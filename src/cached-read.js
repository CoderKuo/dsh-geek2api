/**
 * The read cache the balance, group, and version readers share.
 *
 * A read inside the TTL answers from the cache. Concurrent unforced reads
 * share one request, and one caller cancelling does not abort it for the
 * others. A forced read always goes out under the caller's own signal. A read
 * that started before an invalidation never repopulates the cache.
 *
 * @module dsh-geek2api/cached-read
 */

import { waitForSharedRequest } from './request.js'

const clone = value => structuredClone(value)

/**
 * @param load - `(signal) => Promise<value>`; the value carries `fetchedAt`.
 * @param options - the TTL and clock.
 * @returns `{ read({ force, signal }), snapshot(), peek(), invalidate() }`.
 */
export function createCachedRead(load, { ttlMs, now = Date.now }) {
  let cached
  let inFlight
  let generation = 0

  const start = signal => {
    const observed = generation
    return load(signal).then(value => {
      if (generation === observed) cached = value
      return value
    })
  }

  return Object.freeze({
    /** A copy of the current value; fresh from the network when forced or expired. */
    async read({ force = false, signal } = {}) {
      signal?.throwIfAborted()
      if (!force && cached !== undefined && now() - cached.fetchedAt < ttlMs) return clone(cached)
      if (force) return clone(await start(signal))
      if (inFlight === undefined) {
        const pending = start()
        inFlight = pending
        const clear = () => {
          if (inFlight === pending) inFlight = undefined
        }
        void pending.then(clear, clear)
      }
      return clone(await waitForSharedRequest(inFlight, signal))
    },
    /** A copy of the last value, however old, without a request. */
    snapshot() {
      return cached === undefined ? undefined : clone(cached)
    },
    /** The last value itself, for synchronous lookups that do not keep it. */
    peek() {
      return cached
    },
    /** Drop the value; a read already in flight will not restore it. */
    invalidate() {
      generation += 1
      cached = undefined
    },
  })
}
