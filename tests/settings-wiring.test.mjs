import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_API_HOSTS } from '../src/constants.js'
import { apply } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'

/**
 * A context whose settings and connection services behave like the real ones
 * at the two seams this plugin uses: a section install that hands back a live
 * source, and a loopback RPC registration.
 */
function makeContext({ installSection = true, update = true } = {}) {
  const seen = { installed: undefined, updates: [], handler: undefined, adapters: [], injected: [] }
  const ctx = {
    credentials: fakeCredentials(),
    attachments: undefined,
    logger: { warn: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        seen.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders() {
        return () => {}
      },
    },
    get: () => undefined,
    inject(services, callback) {
      seen.injected.push(services)
      if (services.includes('settings')) {
        const settings = {
          installSection(owner, ns, schema, entry, hooks) {
            if (!installSection) throw new Error('this profile mounts no settings provider')
            seen.installed = { owner, ns, schema, entry, hooks }
          },
        }
        if (update) {
          settings.update = async (ns, patch) => {
            seen.updates.push({ ns, patch })
          }
        }
        return callback({ settings })
      }
      if (services.includes('tools')) {
        return callback({ tools: { register: () => () => {} } })
      }
      if (services.includes('connection')) {
        return callback({
          effect: ctx.effect,
          connection: {
            rpc: {
              handle(channel, handler) {
                seen.handler = handler
                seen.channel = channel
                return () => {}
              },
            },
          },
        })
      }
      return callback(ctx)
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, seen }
}

test('installs its settings section under its own namespace', () => {
  const { ctx, seen } = makeContext()
  apply(ctx)
  assert.equal(seen.installed.ns, 'geek2api')
  assert.ok('apiHosts' in seen.installed.entry)
  assert.ok('claudeRuntime' in seen.installed.entry)
  assert.equal(typeof seen.installed.hooks.setSource, 'function')
  assert.equal(typeof seen.installed.hooks.onChange, 'function')
})

test('the settings source drives the host list and Claude runtime, and writes go back to it', async t => {
  // Probes answer alike, so the configured order decides; no real network.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }))
  const { ctx, seen } = makeContext()
  apply(ctx)

  const before = await seen.handler('status')
  assert.deepEqual(before.value.hosts.map(entry => entry.host), [...DEFAULT_API_HOSTS])
  assert.equal(before.value.claudeRuntime, 'http')
  assert.equal(before.value.writable, true)

  // The real service hands back a getter; a plain value must work too.
  let current = { apiHosts: ['https://gateway.example/', 'nonsense', 'https://second.example'], claudeRuntime: 'cli' }
  seen.installed.hooks.setSource(() => current)
  const after = await seen.handler('status')
  assert.deepEqual(after.value.hosts.map(entry => entry.host), ['https://gateway.example', 'https://second.example'])
  assert.equal(after.value.claudeRuntime, 'cli')

  // Unusable entries are dropped and the order kept; an empty list restores the defaults.
  const updated = await seen.handler('hosts/update', { apiHosts: ['https://other.example//', 'not a url', 'https://b.example'] })
  assert.equal(updated.ok, true)
  assert.deepEqual(seen.updates[0], { ns: 'geek2api', patch: { apiHosts: ['https://other.example', 'https://b.example'] } })
  await seen.handler('hosts/update', { apiHosts: [] })
  assert.deepEqual(seen.updates[1].patch, { apiHosts: [...DEFAULT_API_HOSTS] })

  const runtime = await seen.handler('claude-runtime/update', { runtime: 'http' })
  assert.equal(runtime.ok, true)
  assert.deepEqual(seen.updates[2].patch, { claudeRuntime: 'http' })
  const bogus = await seen.handler('claude-runtime/update', { runtime: 'shell' })
  assert.equal(bogus.ok, false)
  assert.match(bogus.error.message, /not supported/u)

  const probed = await seen.handler('hosts/probe', {})
  assert.equal(probed.ok, true)
  assert.ok(probed.value.hosts.every(entry => entry.latencyMs === undefined), 'a 5xx probe is not a latency')

  // ...and the section's change hook is wired to drop the caches.
  seen.installed.hooks.onChange()
})

test('a runtime whose settings service cannot write keeps the read-only posture', async () => {
  const { ctx, seen } = makeContext({ update: false })
  apply(ctx)
  const status = await seen.handler('status')
  assert.equal(status.value.writable, false)
  const refused = await seen.handler('hosts/update', { apiHosts: ['https://x.example'] })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /not writable/u)
})

test('a profile without a settings provider still serves its route', () => {
  const { ctx, seen } = makeContext({ installSection: false })
  apply(ctx)
  assert.equal(seen.installed, undefined)
  assert.equal(seen.adapters.length, 1)
  assert.deepEqual(seen.injected, [['settings'], ['web'], ['connection', 'webServer'], ['tools']])
  assert.equal(seen.channel, '/geek2api')
})
