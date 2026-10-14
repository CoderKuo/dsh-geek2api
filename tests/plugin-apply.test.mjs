import assert from 'node:assert/strict'
import test from 'node:test'

import { GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_API_HOSTS } from '../src/constants.js'
import { apply, inject, name } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'

/**
 * A context that records what the plugin registers. Every service this plugin
 * injects is present, so a wiring mistake in `apply()` fails here rather than
 * at the user's next boot.
 */
function stubContext() {
  const registered = { adapters: [], directories: [], rpc: [], effects: [], tools: [] }
  const ctx = {
    credentials: fakeCredentials(),
    injected: [],
    injectedOptions: [],
    attachments: undefined,
    logger: { warn: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        registered.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders(entries) {
        registered.directories.push(entries)
        return () => {}
      },
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          registered.rpc.push({ channel, handler })
          return () => {}
        },
      },
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    get: () => undefined,
    inject(services, callback) {
      ctx.injected.push(services)
      callback(ctx)
    },
    effect(callback, label) {
      registered.effects.push(label)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, registered }
}

test('registers one route and one directory entry, and defers the browser surface', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx)

  assert.equal(name, 'geek2api')
  // A profile without a browser surface must still boot: only the route is mandatory.
  assert.deepEqual(inject, ['llm', 'credentials'])

  assert.equal(registered.adapters.length, 1)
  assert.deepEqual(registered.adapters[0].providers, ['geek2api'])
  const models = await registered.adapters[0].adapter.listModels('geek2api')
  assert.deepEqual(models.map(model => model.id), [...GEEK2API_MODEL_IDS])

  assert.deepEqual(registered.directories[0], [{
    provider: 'geek2api',
    displayName: 'Geek2API',
    settingsNs: 'geek2api',
    settingsPath: [],
  }])

  // Every optional surface is requested through ctx.inject, never injected.
  // `webServer` rides with `connection`: channel registration writes through
  // `owner.webServer`, so a scope holding only `connection` cannot register.
  // `web` carries the search providers; a profile without it still boots.
  assert.deepEqual(ctx.injected, [['settings'], ['web'], ['connection', 'webServer'], ['tools']])
  assert.equal(registered.rpc.length, 1)
  assert.equal(registered.rpc[0].channel, '/geek2api')
  assert.ok(registered.effects.some(label => label.includes('loopback')))

  // The Claude Code bridge registers one tool with a bounded schema.
  assert.equal(registered.tools.length, 1)
  const tool = registered.tools[0]
  assert.equal(tool.name, 'claude_code')
  // defineTool converts the field spec into JSON Schema before registration.
  assert.deepEqual(Object.keys(tool.parameters.properties), ['prompt', 'mode', 'model', 'cwd'])
  assert.deepEqual(tool.parameters.required, ['prompt'])
  assert.deepEqual([...tool.parameters.properties.mode.enum], ['read-only', 'edit', 'full'])
  assert.equal(typeof tool.execute, 'function')
})

test('a profile without a connection service still registers the route', () => {
  const { ctx, registered } = stubContext()
  // The connection service never appears, exactly as in a headless profile.
  ctx.inject = (services, callback) => {
    ctx.injected.push(services)
    if (services.includes('connection')) return
    callback(ctx)
  }
  apply(ctx)
  assert.equal(registered.adapters.length, 1)
  assert.deepEqual(registered.rpc, [])
})

test('the RPC surface refuses key material and answers status without one', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx)
  const handler = registered.rpc[0].handler

  const status = await handler('status')
  assert.equal(status.ok, true)
  assert.deepEqual(status.value.keys, [])
  assert.equal(status.value.activeId, undefined)
  // Every default entry point is listed, the first one preferred before any probe.
  assert.deepEqual(status.value.hosts.map(entry => entry.host), [...DEFAULT_API_HOSTS])
  assert.equal(status.value.hosts[0].current, true)
  assert.deepEqual(status.value.defaults, { apiHosts: [...DEFAULT_API_HOSTS] })
  assert.equal(status.value.claudeRuntime, 'http', 'Claude runs over HTTP unless the profile asks for the CLI')
  // Without a settings service nothing is writable, and the RPC says so.
  assert.equal(status.value.writable, false)
  const runtime = await handler('claude-runtime/update', { runtime: 'cli' })
  assert.equal(runtime.ok, false)
  assert.match(runtime.error.message, /not writable/u)

  const added = await handler('keys/add', { key: 'sk-abcdefgh12345678', label: 'first' })
  assert.equal(added.ok, true)
  assert.equal(added.value.keys.length, 1)
  assert.equal(added.value.keys[0].label, 'first')
  assert.equal(JSON.stringify(added.value).includes('sk-abcdefgh'), false)

  const listed = await handler('keys/status')
  assert.equal(listed.ok, false)
  assert.match(listed.error.message, /Unknown Geek2API endpoint/u)

  const rejected = await handler('keys/add', { key: 'nope' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /printable ASCII/u)
})
