/**
 * Which stored key a request runs with, and what happens when the gateway
 * rejects one.
 *
 * The ring's active key serves every request it can. A request for a model
 * the active key's groups cannot reach — as the last group reading shows —
 * runs on the next stored key that can; the active pointer itself does not
 * move. A key the gateway reports as exhausted or invalid is marked unusable
 * and the ring moves on, so the retry of the failed step resolves the next
 * key. Only keys stored in this plugin's ring are ever chosen.
 *
 * @module dsh-geek2api/key-chooser
 */

import { EXHAUSTED_FAILURE } from './failures.js'
import { pickKeyForModel } from './groups.js'

/** How long a request with a choice of keys waits for the first group reading. */
export const DEFAULT_GROUP_WAIT_MS = 6_000
/**
 * How long a key whose money ran out (wallet, subscription, or window) is
 * skipped. It is never disabled for that: a top-up or a new window brings it
 * back, and a balance read showing money brings it back at once.
 */
export const EXHAUSTED_SKIP_MS = 10 * 60_000

/**
 * @param options - the key ring, the group reader, what to do after a key
 *   moved aside, a logger, and how long to wait for the first group reading.
 * @returns the chooser.
 */
export function createKeyChooser({ ring, groups, onRotated, logger, waitMs = DEFAULT_GROUP_WAIT_MS, skipMs = EXHAUSTED_SKIP_MS, now = Date.now }) {
  /** key id → epoch ms until which the key is skipped (in memory only). */
  const skipped = new Map()
  const isSkipped = id => {
    const until = skipped.get(id)
    if (until === undefined) return false
    if (until > now()) return true
    skipped.delete(id)
    return false
  }
  /**
   * Key material to ring id. A failure is reported from inside a stream, which
   * carries the request's key but not its id; this index is refreshed on every
   * resolution so the right key is the one that moves aside.
   */
  const idByKey = new Map()
  /** The ring as of the last resolution, for the synchronous per-request choice. */
  let snapshot = []

  const remember = async () => {
    const entries = await ring.secrets()
    snapshot = entries
    for (const entry of entries) idByKey.set(entry.key, entry.id)
  }
  const usable = () => snapshot.filter(entry => entry.disabled !== true && !isSkipped(entry.id))
  const covers = (keyId, modelId) => groups.covers(keyId, modelId)

  /**
   * Keep the group reading fresh for the choice. It only matters with two
   * usable keys or more; the first reading is awaited for at most `waitMs`,
   * later ones refresh in the background.
   */
  const warm = async () => {
    if (usable().length < 2) return
    const pending = groups.read().catch(() => undefined)
    if (groups.hasReading()) return
    let timer
    await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, waitMs) })])
    clearTimeout(timer)
  }

  /**
   * The active key, after refreshing the ring and, when it matters, the
   * groups. A skipped active key hands over to the next usable one in ring
   * order; with none left, the active key is returned so the failure speaks.
   */
  const active = async () => {
    await remember()
    let key = await ring.activeKey()
    if (key !== undefined && isSkipped(key.id)) {
      const start = snapshot.findIndex(entry => entry.id === key.id)
      const order = start < 0 ? snapshot : [...snapshot.slice(start + 1), ...snapshot.slice(0, start)]
      const next = order.find(entry => entry.disabled !== true && !isSkipped(entry.id))
      if (next !== undefined) key = { ...key, id: next.id, label: next.label, key: next.key }
    }
    if (key !== undefined) await warm()
    return key
  }

  return Object.freeze({
    remember,
    covers,
    active,

    /** Key ids skipped for running out of money, with when the skip ends. */
    skipped() {
      return Object.fromEntries([...skipped.keys()].filter(isSkipped).map(id => [id, skipped.get(id)]))
    },

    /**
     * A balance read is fresher evidence than a failure: a skipped key that
     * now shows money is usable again.
     * @param rows - the `keys` of a balance projection.
     */
    noteBalances(rows) {
      for (const row of Array.isArray(rows) ? rows : []) {
        const available = row?.usage?.availableUsd
        if (row?.stale === undefined && typeof available === 'number' && available > 0) skipped.delete(row.id)
      }
    },

    /**
     * The key one HTTP request for `modelId` runs with, given the active key
     * pi-ai resolved. Synchronous because pi-ai opens its stream synchronously;
     * it reads the ring and groups as of the last {@link active}.
     * @returns the key material to send.
     */
    forRequest(modelId, apiKey) {
      const current = snapshot.find(entry => entry.key === apiKey)
      if (current === undefined) return apiKey
      const chosen = pickKeyForModel(modelId, current, usable(), covers)
      if (chosen?.switchedFrom !== undefined) {
        logger?.info?.('geek2api: key %s cannot reach %s by its last group reading; this request uses key %s', current.id, modelId, chosen.id)
      }
      return chosen?.key ?? apiKey
    },

    /**
     * The key one CLI run for `modelId` uses, with what the run may say about
     * it: its label, its groups, the groups the model needs, and why it was
     * chosen.
     * @returns the choice, or undefined when no usable key is stored.
     */
    async forRun(modelId) {
      const current = await active()
      if (current === undefined) return undefined
      const chosen = pickKeyForModel(modelId, current, usable(), covers)
      return {
        ...chosen,
        model: modelId,
        groups: groups.groupsOf(chosen.id),
        required: groups.requiredGroups(modelId),
        covers: covers(chosen.id, modelId),
      }
    },

    /**
     * Refresh what a run said about its key from the group reading, waiting
     * at most `waitMs` for a reading in flight.
     * @param runKey - the run's key description (`id`, `model`, …).
     * @returns the description with the reading's groups and coverage.
     */
    async describe(runKey) {
      let timer
      await Promise.race([groups.read().catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, waitMs) })])
      clearTimeout(timer)
      if (typeof runKey?.id !== 'string') return runKey
      return {
        ...runKey,
        groups: groups.groupsOf(runKey.id) ?? runKey.groups,
        required: groups.requiredGroups(runKey.model) ?? runKey.required,
        covers: covers(runKey.id, runKey.model) ?? runKey.covers,
      }
    },

    /**
     * The gateway exhausted or rejected a key: mark it unusable so the ring
     * moves on, then let the caller drop what depended on it.
     * @param kind - `quota` or `invalid-key`.
     * @param _message - the failure text (unused; the kind decides).
     * @param key - the key material the failed request carried.
     * @param knownId - the key's ring id, when the caller has it.
     */
    onKeyFailure(kind, _message, key, knownId) {
      const id = knownId ?? (key === undefined ? undefined : idByKey.get(key))
      if (id === undefined) {
        logger?.warn?.('geek2api: %s reported for an unidentified key; not rotating', kind)
        return
      }
      if (kind === EXHAUSTED_FAILURE) {
        skipped.set(id, now() + skipMs)
        logger?.warn?.('geek2api: key %s has no money left for now; skipping it for a while', id)
        onRotated?.()
        return
      }
      logger?.warn?.('geek2api: %s on key %s; the next key serves the retry', kind, id)
      void ring.disable(id, kind)
        .then(() => onRotated?.())
        .catch(error => logger?.warn?.('geek2api: could not move past key %s: %s', id, error.message))
    },
  })
}
