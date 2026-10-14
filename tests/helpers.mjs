/**
 * Test doubles shared across the suite.
 */

/**
 * An in-memory DSH credential-record service with the real one's semantics
 * at the seam the key ring uses: reads answer the committed record, and
 * modifications are serialized read-decide-replace operations.
 * @param options - an optional record to start from.
 * @returns `{ readRecord, modifyRecord, payload }`; `payload()` is a
 *   test-only view of the stored grant payload.
 */
export function fakeCredentials({ record: initial } = {}) {
  let record = initial
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
    payload() {
      return record?.payload
    },
  }
}

/**
 * A key-ring record holding one key, as the ring itself would store it.
 * @param key - the key material.
 * @returns the credential record.
 */
export function singleKeyRecord(key) {
  return { kind: 'grant', payload: { version: 1, activeId: 'k1', keys: [{ id: 'k1', label: 'stub', key, addedAt: 1 }] } }
}

/**
 * A real host pool over fixed hosts whose `/health` probes always answer, so
 * the order is the configured one and probes never reach a reader's fetch.
 * @param hosts - the configured origins.
 * @param options - extra pool options.
 * @returns the pool.
 */
export async function fixedHostPool(hosts = ['https://h1.example', 'https://h2.example'], options = {}) {
  const { createHostPool } = await import('../src/hosts.js')
  return createHostPool({
    listHosts: () => hosts,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }),
    probeIntervalMs: 1e12,
    ...options,
  })
}

/**
 * The same pool, synchronously, for code that composes it at once.
 * @param createHostPool - the pool factory (import it from the module under test).
 * @param hosts - the configured origins.
 * @returns the pool.
 */
export function stubHostPool(createHostPool, hosts = ['https://h1.example', 'https://h2.example']) {
  return createHostPool({
    listHosts: () => hosts,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }),
    probeIntervalMs: 1e12,
  })
}
