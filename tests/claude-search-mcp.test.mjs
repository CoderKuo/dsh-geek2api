import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { dirname } from 'node:path'
import test from 'node:test'

import { createClaudeSearchBridge, MCP_SEARCH_TOOL } from '../src/claude-search-mcp.js'
import { createClaudeRunner } from '../src/claude-cli.js'

const SOURCE = { url: 'https://nodejs.org/en/blog/release', title: 'Node.js releases', snippet: 'release notes' }
const SEARCH_RESULT = { content: 'Latest release notes.', sources: [SOURCE], truncated: false }

async function bridgeFixture(t, options = {}) {
  const bridge = await createClaudeSearchBridge({ search: async () => SEARCH_RESULT, ...options })
  t.after(() => bridge.close())
  const config = JSON.parse(await readFile(bridge.configPath, 'utf8'))
  const [name, server] = Object.entries(config.mcpServers)[0]
  let id = 0
  const send = async (message, extra = {}) => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra.headers },
      body: typeof message === 'string' ? message : JSON.stringify(message),
      ...extra,
      ...(extra.headers === undefined ? {} : { headers: { ...server.headers, 'Content-Type': 'application/json', ...extra.headers } }),
    })
    const raw = await response.text()
    return { status: response.status, body: raw === '' ? undefined : JSON.parse(raw) }
  }
  const rpc = (method, params, extra) => send({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }, extra)
  const search = (args = { query: 'Node.js release' }, extra) => rpc('tools/call', { name: MCP_SEARCH_TOOL, arguments: args }, extra)
  return { bridge, config, server, name, send, rpc, search }
}

const waitFor = (promise, limit = 1000) => Promise.race([promise, new Promise((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('test wait timed out')), limit)
  timer.unref()
})])

/** Send chunked data without a Content-Length header. */
function chunked(url, headers, parts) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    for (const part of parts) request.write(part)
    request.end()
  })
}

test('private per-run config exposes one authenticated loopback HTTP search server, never an API key', async t => {
  const fx = await bridgeFixture(t)
  assert.match(fx.name, /^geek2api_search_[a-f0-9]{12}$/u)
  assert.equal(fx.bridge.toolName, `mcp__${fx.name}__web_search`)
  assert.match(fx.server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
  assert.equal(fx.server.type, 'http')
  assert.match(fx.server.headers.Authorization, /^Bearer [a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(fx.config), /ANTHROPIC_|GEEK2API_API_KEY|cf\.api\.fan/u)
  assert.doesNotMatch(fx.bridge.instructions, /127\.0\.0\.1|Bearer/u)
  if (process.platform !== 'win32') {
    assert.equal((await stat(fx.bridge.configPath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(fx.bridge.configPath))).mode & 0o777, 0o700)
  }
  const init = await fx.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.body.result.capabilities, { tools: {} })
  assert.equal((await fx.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.deepEqual((await fx.rpc('ping')).body.result, {})
  const list = (await fx.rpc('tools/list')).body.result.tools
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'web_search')
  assert.equal(list[0].annotations.readOnlyHint, true)
  assert.equal(list[0].inputSchema.additionalProperties, false)
  assert.doesNotMatch(JSON.stringify(list), new RegExp(fx.server.headers.Authorization.slice(7), 'u'))
  // A newer CLI's discover probe cleanly falls back to legacy initialize.
  assert.equal((await fx.rpc('server/discover')).body.error.code, -32601)
})

test('authenticated search returns bounded source projections and an untrusted-data notice, using a live backend choice', async t => {
  let backend = 'claude'
  const calls = []
  const fx = await bridgeFixture(t, {
    backend: () => backend,
    search: async (request, signal) => { calls.push({ request, signal, backend }); return { ...SEARCH_RESULT, sources: [SOURCE, { ...SOURCE, url: 'https://example.org/' }] } },
  })
  const result = (await fx.search({ query: '  Node release ', max_results: 1 })).body.result
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /^External web content follows/u)
  const value = JSON.parse(result.content[0].text.split('\n\n')[1])
  assert.deepEqual(value.sources, [SOURCE])
  assert.equal(value.backend, 'claude')
  assert.equal(value.truncated, true)
  assert.deepEqual(calls[0].request, { query: 'Node release', maxResults: 1 })
  assert.ok(calls[0].signal instanceof AbortSignal)
  backend = 'gpt'
  assert.equal(JSON.parse((await fx.search()).body.result.content[0].text.split('\n\n')[1]).backend, 'gpt')
  assert.equal(calls[1].backend, 'gpt')
})

test('bad capability, foreign Host/Origin, other paths, and unsupported HTTP methods never invoke search', async t => {
  let calls = 0
  const fx = await bridgeFixture(t, { search: async () => { calls++; return SEARCH_RESULT } })
  assert.equal((await fx.search(undefined, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  // undici normalizes Host to the target; use raw HTTP to test rebinding.
  assert.equal(await chunked(fx.server.url, { ...fx.server.headers, Host: 'attacker.example', 'Content-Type': 'application/json' }, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })]), 403)
  assert.equal((await fx.search(undefined, { headers: { Origin: 'https://attacker.example' } })).status, 403)
  const get = await fetch(fx.server.url, { headers: fx.server.headers })
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  const del = await fetch(fx.server.url, { method: 'DELETE', headers: fx.server.headers })
  assert.equal(del.status, 405)
  assert.equal((await fetch(fx.server.url.replace('/mcp', '/other'), { method: 'POST', headers: fx.server.headers })).status, 404)
  assert.equal(calls, 0)
})

test('malformed/batch JSON-RPC, unknown tools, and model-supplied backend/host/key fields are refused', async t => {
  let calls = 0
  const fx = await bridgeFixture(t, { search: async () => { calls++; return SEARCH_RESULT } })
  assert.equal((await fx.send('not JSON')).body.error.code, -32700)
  assert.equal((await fx.send([])).body.error.code, -32600)
  for (const params of [42, null, false, 'scalar']) assert.equal((await fx.rpc('ping', params)).body.error.code, -32600)
  assert.equal((await fx.send({ jsonrpc: '2.0', id: {}, method: 'ping' })).body.error.code, -32600)
  assert.equal((await fx.rpc('tools/call', { name: 'shell', arguments: { command: 'echo secret' } })).body.error.code, -32602)
  for (const args of [null, {}, { query: '' }, { query: 'q'.repeat(2001) }, { query: 'q', backend: 'gpt' }, { query: 'q', host: 'https://attacker/' }, { query: 'q', key: 'x' }, { query: 'q', sessionId: 'attacker' }, { query: 'q', max_results: 9 }, { query: 'q', max_results: 1.1 }]) {
    assert.equal((await fx.search(args)).body.error.code, -32602)
  }
  assert.equal((await fx.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'web_search', arguments: { query: 'q' } } })).status, 400)
  assert.equal(calls, 0)
})

test('declared and chunked oversized bodies are rejected before paid work', async t => {
  let calls = 0
  const fx = await bridgeFixture(t, { search: async () => { calls++; return SEARCH_RESULT } })
  const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'x'.repeat(20_000) } } })
  assert.equal((await fx.send(oversized)).status, 413)
  assert.equal(await chunked(fx.server.url, { ...fx.server.headers, 'Content-Type': 'application/json' }, [oversized.slice(0, 8000), oversized.slice(8000)]), 413)
  assert.equal((await fx.search(undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal(calls, 0)
})

test('tool errors are explicit and sanitized; source and summary output is bounded and host-redacted', async t => {
  let fail = true
  const secret = 'sk-host-only-not-in-mcp-output'
  const fx = await bridgeFixture(t, {
    sanitize: text => text.split(secret).join('[redacted]'),
    search: async () => {
      if (fail) throw new Error(`remote echoed ${secret}`)
      return { content: `${secret}${'x'.repeat(6000)}`, sources: [{ ...SOURCE, title: secret, snippet: 's'.repeat(800) }, { url: 'file:///etc/passwd' }, { url: 'https://user:password@example.com/' }] }
    },
  })
  const error = (await fx.search()).body.result
  assert.equal(error.isError, true)
  assert.doesNotMatch(JSON.stringify(error), /sk-host-only|remote echoed/u)
  fail = false
  const success = (await fx.search()).body.result
  assert.doesNotMatch(JSON.stringify(success), /sk-host-only/u)
  const projection = JSON.parse(success.content[0].text.split('\n\n')[1])
  assert.equal(projection.sources.length, 1)
  assert.ok(projection.summary.length <= 4000)
  assert.ok(projection.sources[0].snippet.length <= 500)
})

test('per-run call budget and concurrency caps bound searches but allow cancellation control traffic', async t => {
  let release
  const slow = new Promise(resolve => { release = resolve })
  let calls = 0
  const fx = await bridgeFixture(t, { maxCalls: 2, search: async () => { calls++; await slow; return SEARCH_RESULT } })
  const first = fx.search()
  const second = fx.search()
  await new Promise(resolve => setTimeout(resolve, 20))
  const capped = (await fx.search()).body.result
  assert.equal(capped.isError, true)
  assert.match(capped.content[0].text, /budget|already running/u)
  assert.equal((await fx.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  release()
  assert.equal((await first).body.result.isError, undefined)
  assert.equal((await second).body.result.isError, undefined)
  assert.equal(calls, 2)
  assert.equal((await fx.search()).body.result.isError, true)
})

test('notifications/cancelled and the end-to-end deadline abort providers without leaking errors', async t => {
  const signals = []
  let started
  let start = new Promise(resolve => { started = resolve })
  const fx = await bridgeFixture(t, { timeoutMs: 60, search: async (_request, signal) => { signals.push(signal); started(); return new Promise(() => {}) } })
  const pending = fx.send({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: { name: 'web_search', arguments: { query: 'q' } } })
  await waitFor(start)
  const cancelled = await fx.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } })
  assert.equal(cancelled.status, 202)
  assert.equal((await pending).body.result.isError, true)
  assert.equal(signals[0].aborted, true)
  start = new Promise(resolve => { started = resolve })
  const timedOut = fx.search()
  await waitFor(start)
  const outcome = await waitFor(timedOut)
  assert.equal(outcome.body.result.isError, true)
  assert.equal(signals[1].aborted, true)
})

test('HTTP disconnect aborts one search and close revokes capability, cancels work, and deletes config idempotently', async t => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  let signal
  const fx = await bridgeFixture(t, { search: async (_args, abort) => { signal = abort; started(); return new Promise(() => {}) } })
  const caller = new AbortController()
  const pending = fx.search(undefined, { signal: caller.signal }).catch(() => undefined)
  await waitFor(ready)
  caller.abort()
  await pending
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(signal.aborted, true)
  const path = fx.bridge.configPath
  await fx.bridge.close()
  await fx.bridge.close()
  await assert.rejects(readFile(path), error => error.code === 'ENOENT')
  await assert.rejects(fetch(fx.server.url, { headers: fx.server.headers }))
})

test('callback fallback hostname titles and long URLs obey output bounds', async t => {
  const fx = await bridgeFixture(t, { search: async () => ({ sources: [
    { url: `https://${'a'.repeat(3000)}.example/` },
    { url: `https://${'b'.repeat(10_000)}.example/` },
  ] }) })
  const value = JSON.parse((await fx.search()).body.result.content[0].text.split('\n\n')[1])
  assert.equal(value.sources.length, 1)
  assert.ok(value.sources[0].title.length <= 200)
  assert.ok(value.sources[0].url.length <= 4000)
})

test('abort during each filesystem setup phase revokes the real listener immediately and unload owns late cleanup', async t => {
  for (const phase of ['mkdtemp', 'realpath', 'writeFile']) {
    const controller = new AbortController()
    let entered
    let release
    const ready = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    t.after(() => release())
    const fs = { mkdtemp, realpath, rm, writeFile }
    const original = fs[phase]
    let once = false
    let directory
    let server
    fs[phase] = async (...args) => {
      if (phase === 'writeFile') {
        // Simulate a filesystem operation that cannot honour cancellation.
        args[2] = { ...args[2], signal: undefined }
      }
      const value = phase === 'writeFile' ? undefined : await original(...args)
      if (phase === 'mkdtemp') directory = value
      else if (phase === 'realpath') directory = args[0]
      else directory = dirname(args[0])
      if (!once) { once = true; entered(); await blocked }
      if (phase === 'writeFile') await original(...args)
      return value
    }
    const runner = createClaudeRunner({
      resolveCredential: async () => ({ baseUrl: 'https://gw.example', token: 'sk-local-only-dummy' }),
      createSearchBridge: ({ signal }) => createClaudeSearchBridge({ search: async () => SEARCH_RESULT, signal, fs, serverFactory: listener => { server = createServer(listener); return server } }),
      spawnImpl: () => assert.fail('cancelled setup must not spawn'),
    })
    const pending = runner.run({ prompt: 'x', signal: controller.signal })
    pending.catch(() => undefined)
    await waitFor(ready)
    assert.equal(server.listening, true)
    controller.abort()
    await assert.rejects(pending, /aborted/u)
    assert.equal(server.listening, false, `${phase}: listener closed before filesystem completion`)
    let unloaded = false
    const unloading = runner.close().then(() => { unloaded = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unloaded, false, `${phase}: unload must still own the pending factory`)
    release()
    await waitFor(unloading)
    await assert.rejects(stat(directory), error => error.code === 'ENOENT')
  }
})

test('concurrent bridges have independent capabilities, preferences, and lifetimes; run abort closes its bridge', async t => {
  const controller = new AbortController()
  const one = await bridgeFixture(t, { backend: () => 'claude', signal: controller.signal })
  const two = await bridgeFixture(t, { backend: () => 'gpt' })
  assert.notEqual(one.server.url, two.server.url)
  assert.notEqual(one.server.headers.Authorization, two.server.headers.Authorization)
  assert.equal((await one.search(undefined, { headers: two.server.headers })).status, 401)
  controller.abort()
  await one.bridge.close()
  assert.equal((await two.search()).body.result.isError, undefined)
  const value = JSON.parse((await two.search()).body.result.content[0].text.split('\n\n')[1])
  assert.equal(value.backend, 'gpt')
  await assert.rejects(createClaudeSearchBridge({ search: async () => SEARCH_RESULT, signal: controller.signal }), /aborted/u)
})
