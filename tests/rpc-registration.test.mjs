import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import { Context as LegacyContext } from '@deepseek-ai/cordis'
import { HostConnectionService as LegacyConnection, serverResponseSchema as legacyResponse } from '@deepseek-ai/dsh-client-connection'
import { Context as CurrentContext, HostConnectionService as CurrentConnection, serverResponseSchema as currentResponse } from 'geek2api-host-v020-fixture'

import * as geek2api from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'

const hosts = [
  { name: 'DSH 0.1.5', Context: LegacyContext, Connection: LegacyConnection, responseSchema: legacyResponse },
  { name: 'DSH 0.2.0-rc.2', Context: CurrentContext, Connection: CurrentConnection, responseSchema: currentResponse },
]
const COOKIE = 'fixture-session=authenticated'

/**
 * Connection is the shipped service, with its real injection checks,
 * Host/Origin admission, HTTP bridge and RPC envelope parser. Only the
 * webserver's prefix dispatch and browser-session identity are fixtures.
 * Services live in sibling fibers, as they do in Loader: providing webServer
 * on the root would accidentally authorize reads without an inject.
 */
async function runningHost(t, { Context, Connection }, { withWebServer = true } = {}) {
  const ctx = new Context()
  const routes = new Map()
  let connectionStarts = 0
  await ctx.plugin({ name: 'existing-model-and-credential-services', apply(owner) {
    owner.provide('credentials', fakeCredentials())
    owner.provide('llm', { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} })
  } })
  const webPlugin = { name: 'existing-web-server', apply(owner) {
    owner.provide('webServer', {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    })
  } }
  let webFiber = withWebServer ? await ctx.plugin(webPlugin) : undefined
  const connectionFiber = await ctx.plugin({ name: 'existing-connection', inject: ['credentials'], apply(owner) {
    connectionStarts += 1
    new Connection(owner, [], { isAuthenticated: request => request.headers.cookie === COOKIE })
  } })
  const server = createServer((req, res) => {
    const route = [...routes.values()].find(route => req.url.startsWith(`${route.path}/`))
    if (route === undefined) { res.writeHead(req.method === 'POST' ? 405 : 404); res.end(); return }
    Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await ctx.fiber.dispose()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const settled = async () => Promise.allSettled([...ctx.registry.values()]
    .flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
  // node:http permits the hostile Host header needed to exercise rebinding
  // rejection; Fetch can replace that forbidden header with the URL's host.
  const request = (method = 'status', { payload = null, headers = {}, cookie = true, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${base}/geek2api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie: COOKIE } : {}), ...headers },
    }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('error', reject)
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })))
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('fixture request timed out')))
    outgoing.end(JSON.stringify(body ?? { type: 'client-request', rpcId: 'fixture-request', method, payload }))
  })
  return {
    ctx, routes, base, request, settled,
    async install() { const fiber = await ctx.plugin(geek2api); await settled(); return fiber },
    async removeWebServer() { await webFiber.dispose(); await settled() },
    async addWebServer() { webFiber = await ctx.plugin(webPlugin); await settled() },
    assertUnrestarted() {
      assert.equal(connectionStarts, 1)
      assert.equal(connectionFiber.state, 2)
      assert.equal(server.listening, true)
    },
  }
}

for (const host of hosts) {
  test(`${host.name}: first hot install serves every settings channel without restarting`, async t => {
    const env = await runningHost(t, host)
    assert.equal((await env.request()).status, 405, 'there is no plugin before first install')
    const fiber = await env.install()
    assert.equal(fiber.state, 2, 'the plugin itself loaded')
    for (const method of ['status', 'search/status', 'models/status']) {
      const response = await env.request(method)
      assert.equal(response.status, 200, `${method} must be available immediately after install`)
      const parsed = host.responseSchema.parse(await response.json())
      assert.equal(parsed.rpcId, 'fixture-request')
      assert.equal(parsed.result.ok, true, method)
    }
    // Check the other cards without spawning the CLI or querying npm. Native
    // envelope rejection proves these paths reached Connection, not a 405.
    for (const method of ['claude-cli/status', 'plugin/version']) {
      const response = await env.request(method, { body: {} })
      assert.equal(response.status, 200, method)
      assert.equal(host.responseSchema.parse(await response.json()).result.error.code, 'gateway/bad-request')
    }
    env.assertUnrestarted()
    await fiber.dispose()
    assert.equal((await env.request()).status, 405, 'uninstall removes this plugin route')
    assert.equal(env.routes.size, 0)
    env.assertUnrestarted()
    const reinstalled = await env.install()
    assert.equal((await env.request()).status, 200, 'reinstall must not collide with a leaked route')
    env.assertUnrestarted()
    await reinstalled.dispose()
  })

  test(`${host.name}: hot-installed RPC preserves browser auth and Host/Origin fences`, async t => {
    const env = await runningHost(t, host)
    await env.install()
    assert.equal((await env.request('status', { cookie: false })).status, 401)
    for (const headers of [
      { host: 'evil.invalid' },
      { origin: 'http://evil.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ]) assert.equal((await env.request('status', { headers })).status, 403, JSON.stringify(headers))
    assert.equal((await env.request('status', { headers: { origin: env.base } })).status, 200)
    env.assertUnrestarted()
  })

  test(`${host.name}: RPC follows optional webServer availability and cleans up its own scope`, async t => {
    const env = await runningHost(t, host, { withWebServer: false })
    const plugin = await env.install()
    assert.equal(plugin.state, 2)
    assert.equal(env.routes.size, 0)
    await env.addWebServer()
    assert.equal((await env.request()).status, 200)
    await env.removeWebServer()
    assert.equal(env.routes.size, 0, 'losing the injected webServer must remove its RPC route')
    assert.equal(plugin.state, 2, 'the model route remains loaded')
    await env.addWebServer()
    assert.equal((await env.request()).status, 200)
    env.assertUnrestarted()
  })
}
