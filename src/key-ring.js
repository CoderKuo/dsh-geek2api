/**
 * The Geek2API key ring.
 *
 * Keys live in one DSH credential *record* (`geek2api/keys`), which is
 * the cross-process-serialized read-decide-replace space the credential
 * service owns. A key the gateway exhausts or rejects is marked unusable and
 * the ring moves the active pointer to the next usable key, so the next
 * attempt — the harness retry of the failed step — resolves a different key
 * through the adapter's per-request `resolveApiKey`.
 *
 * @module dsh-geek2api/key-ring
 */

import { randomUUID } from 'node:crypto'

import { credentialKey } from '@deepseek-ai/dsh-credentials'

import { KEY_RECORD_ID, PLUGIN_ID } from './constants.js'

/** Printable ASCII without spaces: what an HTTP header can carry unchanged. */
const LEGAL_KEY = /^[\x21-\x7E]+$/u
const RECORD_VERSION = 1
const MAX_KEYS = 32

const RECORD_KEY = typeof credentialKey === 'function'
  ? credentialKey(PLUGIN_ID, KEY_RECORD_ID)
  : undefined

const text = value => (typeof value === 'string' ? value : '')

/** Validate a pasted key before it is stored; the gateway never sees a bad one from us. */
export function assertApiKey(value) {
  const key = text(value).trim()
  if (key.length < 8 || key.length > 512 || !LEGAL_KEY.test(key)) {
    throw new Error('Geek2API API key must be 8-512 printable ASCII characters without spaces')
  }
  return key
}

function entry(value) {
  if (value === null || typeof value !== 'object') return undefined
  const key = text(value.key)
  if (key === '' || !LEGAL_KEY.test(key)) return undefined
  const id = text(value.id)
  return {
    id: id === '' ? randomUUID().slice(0, 8) : id,
    label: text(value.label),
    key,
    addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
    ...(Number.isFinite(value.disabledAt) ? { disabledAt: value.disabledAt } : {}),
    ...(text(value.disabledReason) === '' ? {} : { disabledReason: text(value.disabledReason) }),
  }
}

/** Tolerate a hand-edited or older record instead of failing the whole route. */
function normalizeState(record) {
  const payload = record !== null && typeof record === 'object' && record.kind === 'grant' && record.payload !== null && typeof record.payload === 'object'
    ? record.payload
    : undefined
  const raw = Array.isArray(payload?.keys) ? payload.keys : []
  const keys = raw.map(entry).filter(candidate => candidate !== undefined)
  const activeId = text(payload?.activeId)
  return {
    activeId: keys.some(candidate => candidate.id === activeId) ? activeId : keys[0]?.id,
    keys,
  }
}

/**
 * The next free `Key N` name. The ring shrinks on removal, so numbering follows
 * the highest name in use instead of the current key count — otherwise removing
 * the first key and adding another produces a second "Key 2".
 * @param keys - the stored keys.
 * @returns an unused default label.
 */
function nextDefaultLabel(keys) {
  const used = new Set(keys.map(candidate => candidate.label))
  let index = keys.length + 1
  while (used.has(`Key ${index}`)) index += 1
  return `Key ${index}`
}

/** The public shape: what a browser or a log may see, never key material. */
function projection(state) {
  return {
    activeId: state.activeId,
    keys: state.keys.map(candidate => ({
      id: candidate.id,
      label: candidate.label,
      addedAt: candidate.addedAt,
      active: candidate.id === state.activeId,
      disabled: candidate.disabledAt !== undefined,
      ...(candidate.disabledAt === undefined ? {} : { disabledAt: candidate.disabledAt, disabledReason: candidate.disabledReason }),
    })),
  }
}

export class Geek2APIKeyRing {
  #credentials

  constructor(credentials) {
    if (RECORD_KEY === undefined) {
      throw new Error('dsh-geek2api requires @deepseek-ai/dsh-credentials with credentialKey()')
    }
    if (credentials === null || typeof credentials !== 'object'
      || typeof credentials.readRecord !== 'function' || typeof credentials.modifyRecord !== 'function') {
      throw new Error('dsh-geek2api requires the DSH credential record API')
    }
    this.#credentials = credentials
  }

  async #read() {
    return normalizeState(await this.#credentials.readRecord(RECORD_KEY))
  }

  async #write(mutate) {
    const next = await this.#credentials.modifyRecord(RECORD_KEY, async (current) => {
      const state = normalizeState(current)
      const updated = await mutate(state)
      if (updated === undefined) return current
      return {
        kind: 'grant',
        payload: {
          version: RECORD_VERSION,
          activeId: updated.activeId,
          keys: updated.keys.map(candidate => ({
            id: candidate.id,
            label: candidate.label,
            key: candidate.key,
            addedAt: candidate.addedAt,
            ...(candidate.disabledAt === undefined ? {} : { disabledAt: candidate.disabledAt, disabledReason: candidate.disabledReason }),
          })),
        },
      }
    })
    return normalizeState(next)
  }

  /** The keys as the browser may see them. */
  async list() {
    return projection(await this.#read())
  }

  /** Raw key material for the host-side balance reader; never crosses the RPC boundary. */
  async secrets() {
    const state = await this.#read()
    return state.keys.map(candidate => ({
      id: candidate.id,
      label: candidate.label,
      key: candidate.key,
      disabled: candidate.disabledAt !== undefined,
    }))
  }

  /**
   * The key a request should use: the active one when it is usable, otherwise
   * the next usable key in insertion order, wrapping once.
   * @returns the chosen entry, or undefined when every key is unusable.
   */
  async activeKey() {
    const state = await this.#read()
    if (state.keys.length === 0) return undefined
    const usable = candidate => candidate.disabledAt === undefined
    const start = Math.max(0, state.keys.findIndex(candidate => candidate.id === state.activeId))
    for (let offset = 0; offset < state.keys.length; offset += 1) {
      const candidate = state.keys[(start + offset) % state.keys.length]
      if (usable(candidate)) return { id: candidate.id, label: candidate.label, key: candidate.key }
    }
    return undefined
  }

  async add(key, label) {
    const value = assertApiKey(key)
    const name = text(label).trim().slice(0, 60)
    return projection(await this.#write(state => {
      if (state.keys.length >= MAX_KEYS) throw new Error(`Geek2API accepts at most ${MAX_KEYS} keys`)
      if (state.keys.some(candidate => candidate.key === value)) throw new Error('That Geek2API API key is already stored')
      const added = {
        id: randomUUID().slice(0, 8),
        // A default name must not collide with one already in use: the ring
        // shrinks when a key is removed, so the next number follows the
        // highest in use rather than the current count.
        label: name === '' ? nextDefaultLabel(state.keys) : name,
        key: value,
        addedAt: Date.now(),
      }
      return { activeId: state.activeId ?? added.id, keys: [...state.keys, added] }
    }))
  }

  async rename(id, label) {
    const name = text(label).trim().slice(0, 60)
    if (name === '') throw new Error('That Geek2API key name cannot be empty')
    return projection(await this.#write(state => {
      if (!state.keys.some(candidate => candidate.id === id)) throw new Error('Unknown Geek2API key')
      return {
        activeId: state.activeId,
        keys: state.keys.map(candidate => candidate.id === id ? { ...candidate, label: name } : candidate),
      }
    }))
  }

  async remove(id) {
    return projection(await this.#write(state => {
      const remaining = state.keys.filter(candidate => candidate.id !== id)
      if (remaining.length === state.keys.length) throw new Error('Unknown Geek2API key')
      const activeId = state.activeId === id
        ? (remaining.find(candidate => candidate.disabledAt === undefined) ?? remaining[0])?.id
        : state.activeId
      return { activeId, keys: remaining }
    }))
  }

  async removeAll() {
    return projection(await this.#write(() => ({ activeId: undefined, keys: [] })))
  }

  async select(id) {
    return projection(await this.#write(state => {
      if (!state.keys.some(candidate => candidate.id === id)) throw new Error('Unknown Geek2API key')
      return { activeId: id, keys: state.keys }
    }))
  }

  /** Clear a rotation mark so a topped-up or replaced key is tried again. */
  async enable(id) {
    return projection(await this.#write(state => {
      if (!state.keys.some(candidate => candidate.id === id)) throw new Error('Unknown Geek2API key')
      return {
        activeId: state.activeId,
        keys: state.keys.map(candidate => candidate.id === id
          ? { id: candidate.id, label: candidate.label, key: candidate.key, addedAt: candidate.addedAt }
          : candidate),
      }
    }))
  }

  /**
   * Mark a key unusable and move the active pointer on. Called from the stream
   * guard, so the retry of the failed step resolves the next key.
   */
  async disable(id, reason) {
    return projection(await this.#write(state => {
      const now = Date.now()
      const keys = state.keys.map(candidate => candidate.id === id
        ? { ...candidate, disabledAt: now, disabledReason: text(reason) === '' ? 'unusable' : text(reason) }
        : candidate)
      if (!keys.some(candidate => candidate.id === id)) return { activeId: state.activeId, keys: state.keys }
      const nextId = state.activeId === id
        ? (keys.find(candidate => candidate.id !== id && candidate.disabledAt === undefined) ?? keys.find(candidate => candidate.id !== id))?.id
        : state.activeId
      return { activeId: nextId, keys }
    }))
  }
}
