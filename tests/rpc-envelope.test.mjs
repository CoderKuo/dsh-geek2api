import assert from 'node:assert/strict'
import test from 'node:test'

import { Geek2APIKeyRing } from '../src/key-ring.js'
import { createGeek2APIRpc } from '../src/rpc.js'
import { createSearchController } from '../src/search-controller.js'
import { createHostPool } from '../src/hosts.js'
import { fakeCredentials, stubHostPool } from './helpers.mjs'
import { Config } from '../src/index.js'

test('search settings declare volatile fields accepted by DSH 0.2', () => {
  for (const field of ['searchProvider', 'searchBackend', 'hiddenModels', 'apiHosts', 'claudeRuntime']) {
    assert.equal(Config.dict[field].meta.volatile, true, `${field}: DSH 0.2 otherwise rejects settings.update with no volatile fields`)
  }
})

/** DSH 0.2 Connection's failure contract, after a JSON wire round trip. */
function connectionFailure(result) {
  const wire = JSON.parse(JSON.stringify(result))
  assert.equal(wire.ok, false)
  assert.equal(typeof wire.error.code, 'string', 'DSH requires error.code; otherwise invalid server-response failure')
  assert.equal(typeof wire.error.message, 'string')
  assert.deepEqual(wire.error.details, {}, 'DSH requires error.details; diagnostics must carry no secrets')
  return wire.error
}

test('a failed Auto search setting is a valid Connection failure, preserving its safe explanation', async () => {
  const search = createSearchController({
    ring: new Geek2APIKeyRing(fakeCredentials()),
    hosts: stubHostPool(createHostPool),
    readPreference: () => ({}),
    isWritable: () => true,
    writePreference: async () => { throw new Error('storage fixture refused the write') },
  })
  const rpc = createGeek2APIRpc({ search })
  const error = connectionFailure(await rpc('search/update', { searchProvider: 'auto' }))
  assert.equal(error.message, 'Geek2API could not save the web search preference')
})

test('unknown endpoints and unavailable services also satisfy the Connection failure contract', async () => {
  const rpc = createGeek2APIRpc({})
  for (const endpoint of ['unknown', 'search/status', 'models/status', 'plugin/version', 'status']) {
    connectionFailure(await rpc(endpoint))
  }
})

test('an unexpected storage failure never places upstream diagnostics in the envelope', async () => {
  const secret = 'sk-fixture-secret-not-a-real-key'
  const rpc = createGeek2APIRpc({ ring: { list: async () => { throw new Error(secret) } } })
  const result = await rpc('status')
  assert.equal(connectionFailure(result).message, 'Geek2API request failed')
  assert.equal(JSON.stringify(result).includes(secret), false)
})
