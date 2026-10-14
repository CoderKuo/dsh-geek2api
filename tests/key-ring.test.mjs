import assert from 'node:assert/strict'
import test from 'node:test'

import { Geek2APIKeyRing, assertApiKey } from '../src/key-ring.js'
import { fakeCredentials } from './helpers.mjs'

/** Minimal credential-record service: one in-memory record, serialized writes. */
const KEY_A = 'sk-aaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'sk-bbbbbbbbbbbbbbbbbbbb'
const KEY_C = 'sk-cccccccccccccccccccc'

test('rejects keys the gateway could not carry in a header', () => {
  assert.equal(assertApiKey('  sk-abcdefgh12345678  '), 'sk-abcdefgh12345678')
  assert.throws(() => assertApiKey('short'), /printable ASCII/u)
  assert.throws(() => assertApiKey('sk-with space in it'), /printable ASCII/u)
  assert.throws(() => assertApiKey(''), /printable ASCII/u)
})

test('adds keys in order and keeps the first one active', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A, 'primary')
  await ring.add(KEY_B)
  const state = await ring.list()
  assert.equal(state.keys.length, 2)
  assert.equal(state.keys[0].label, 'primary')
  assert.equal(state.keys[1].label, 'Key 2')
  assert.equal(state.activeId, state.keys[0].id)
  assert.equal((await ring.activeKey()).key, KEY_A)
  // The projection never carries key material.
  assert.equal(JSON.stringify(state).includes('sk-'), false)
})

test('refuses a duplicate key', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await assert.rejects(() => ring.add(KEY_A), /already stored/u)
})

test('disabling the active key moves to the next usable one', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  await ring.add(KEY_C)
  const [a, b] = (await ring.list()).keys

  await ring.disable(a.id, 'quota')
  assert.equal((await ring.activeKey()).key, KEY_B)
  const afterFirst = await ring.list()
  assert.equal(afterFirst.keys[0].disabled, true)
  assert.equal(afterFirst.keys[0].disabledReason, 'quota')

  await ring.disable(b.id, 'invalid-key')
  assert.equal((await ring.activeKey()).key, KEY_C)

  // Re-enabling a key makes it eligible again without stealing the pointer.
  await ring.enable(a.id)
  assert.equal((await ring.activeKey()).key, KEY_C)
})

test('every key disabled leaves no usable key instead of a silent fallback', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  const [a] = (await ring.list()).keys
  await ring.disable(a.id, 'quota')
  assert.equal(await ring.activeKey(), undefined)
})

test('select, remove, and removeAll keep the ring consistent', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  const [a, b] = (await ring.list()).keys

  await ring.select(b.id)
  assert.equal((await ring.list()).activeId, b.id)
  assert.equal((await ring.activeKey()).key, KEY_B)

  await ring.remove(b.id)
  const afterRemove = await ring.list()
  assert.equal(afterRemove.keys.length, 1)
  assert.equal(afterRemove.activeId, a.id)

  await ring.removeAll()
  assert.deepEqual(await ring.list(), { activeId: undefined, keys: [] })
  await assert.rejects(() => ring.select('missing'), /Unknown Geek2API key/u)
})

test('tolerates a hand-edited record instead of failing the route', async () => {
  const credentials = fakeCredentials()
  const ring = new Geek2APIKeyRing(credentials)
  await ring.add(KEY_A)
  const payload = credentials.payload()
  // A record whose activeId names no stored key still serves the first key.
  await credentials.modifyRecord('ignored', async () => ({
    kind: 'grant',
    payload: { ...payload, activeId: 'gone' },
  }))
  assert.equal((await ring.activeKey()).key, KEY_A)
})

test('secrets() is host-side material and marks disabled keys', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  const [a] = (await ring.list()).keys
  await ring.disable(a.id, 'quota')
  const secrets = await ring.secrets()
  assert.equal(secrets.length, 1)
  assert.equal(secrets[0].key, KEY_A)
  assert.equal(secrets[0].disabled, true)
})

test('a default label never collides after a removal', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  const [first] = (await ring.list()).keys
  await ring.remove(first.id)
  // The ring shrank to one key, but "Key 2" is taken: the next name must not repeat it.
  await ring.add(KEY_C)
  const labels = (await ring.list()).keys.map(candidate => candidate.label)
  assert.deepEqual(labels, ['Key 2', 'Key 3'])
  assert.equal(new Set(labels).size, labels.length)
})

test('an explicit label is kept verbatim and may repeat', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A, '战魂铭人-张洋凡')
  await ring.add(KEY_B, '战魂铭人-张洋凡')
  const labels = (await ring.list()).keys.map(candidate => candidate.label)
  assert.deepEqual(labels, ['战魂铭人-张洋凡', '战魂铭人-张洋凡'])
})

test('rename replaces a label, keeps the key and active pointer, and trims', async () => {
  const credentials = fakeCredentials()
  const ring = new Geek2APIKeyRing(credentials)
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  const [first, second] = (await ring.list()).keys
  const state = await ring.rename(second.id, '  备用 Key  ')
  assert.deepEqual(state.keys.map(candidate => candidate.label), [first.label, '备用 Key'])
  assert.equal(state.activeId, first.id)
  assert.equal(credentials.payload().keys[1].key, KEY_B)
  assert.equal((await ring.rename(first.id, 'x'.repeat(80))).keys[0].label.length, 60)
})

test('rename keeps a disabled mark and rejects an empty name or an unknown id', async () => {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  const [a] = (await ring.list()).keys
  await ring.disable(a.id, 'quota')
  const [renamed] = (await ring.rename(a.id, 'main')).keys
  assert.equal(renamed.disabled, true)
  assert.equal(renamed.disabledReason, 'quota')
  await assert.rejects(ring.rename(a.id, '   '), /cannot be empty/)
  await assert.rejects(ring.rename('nope', 'x'), /Unknown Geek2API key/)
})
