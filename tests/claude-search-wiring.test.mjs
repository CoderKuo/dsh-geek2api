import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'

const RELAY_KEY = 'sk-plugin-only-mcp-relay-key-0001'

/** A CLI stand-in that actually calls the advertised MCP HTTP tool. */
async function fakeCli(directory) {
  const record = join(directory, 'invocations.jsonl')
  const cli = join(directory, 'claude')
  await writeFile(cli, `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('2.1.295 (Claude Code)'); process.exit(0) }
process.stdin.resume()
process.stdin.on('end', async () => {
  try {
    const path = args[args.indexOf('--mcp-config') + 1]
    let result = 'title without search'
    let tool
    if (args.includes('--mcp-config')) {
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const [name, server] = Object.entries(config.mcpServers)[0]
      tool = 'mcp__' + name + '__web_search'
      const rpc = async (id, method, params) => {
        const response = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
        return response.json()
      }
      await rpc(1, 'initialize', { protocolVersion: '2025-11-25' })
      const list = await rpc(2, 'tools/list', {})
      if (list.result.tools[0].name !== 'web_search') throw new Error('wrong tool')
      const reply = await rpc(3, 'tools/call', { name: 'web_search', arguments: { query: 'latest Node.js release', max_results: 1 } })
      result = reply.result.content[0].text
    }
    appendFileSync(${JSON.stringify(record)}, JSON.stringify({ path: args.includes('--mcp-config') ? path : null, tool, args }) + '\\n')
    console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result } } }))
    console.log(JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 1, output_tokens: 1 } }))
  } catch {
    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'mock CLI MCP test failed' }))
    process.exitCode = 1
  }
})
`)
  await chmod(cli, 0o755)
  return { cli, record }
}

function context() {
  const seen = { disposers: [] }
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn: () => {}, info: () => {} },
    llm: { registerAdapter: (_providers, adapter) => { seen.adapter = adapter; return () => {} }, registerConfigurableProviders: () => () => {} },
    // No web service: the CLI bridge must remain self-contained in headless profiles.
    get: name => name === 'agents' ? { currentInitiator: () => ({ session: { id: 'originating-dsh-session', requestContext: () => ({ provider: 'geek2api' }) } }) } : undefined,
    inject(names, callback) {
      if (names.includes('settings')) return callback({ settings: {
        installSection(_owner, _ns, _schema, base, hooks) { seen.current = { ...base }; hooks.setSource(() => seen.current) },
        update: async (_ns, patch) => { Object.assign(seen.current, patch) },
      } })
      if (names.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle: (_channel, handler) => { seen.handler = handler; return () => {} } } } })
      if (names.includes('tools')) return callback({ tools: { register: () => () => {} } })
    },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') seen.disposers.push(disposer); return disposer },
  }
  return { ctx, seen }
}

const turn = async (adapter, purpose) => {
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', purpose, messages: [{ role: 'user', content: [{ type: 'text', text: 'Search for a Node.js release' }] }] })) chunks.push(chunk)
  return chunks
}

test('CLI MCP uses the selected backend even with DSH routing off and no web service, preserves session and redacts keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'geek2api-mcp-wiring-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { cli, record } = await fakeCli(dir)
  const { ctx, seen } = context()
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return Response.json({ status: 'ok' })
    const body = JSON.parse(init.body)
    const headers = new Headers(init.headers)
    requests.push({ url, body, key: headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /u, '') })
    if (url.endsWith('/messages')) return Response.json({ content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://nodejs.org/', title: 'Node.js' }] },
      { type: 'text', text: `Public summary; remote echoed ${RELAY_KEY}` },
    ] })
    if (url.endsWith('/responses')) return Response.json({ output: [
      { type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://nodejs.org/' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'GPT result', annotations: [{ type: 'url_citation', url: 'https://nodejs.org/', title: 'Node.js' }] }] },
    ] })
    throw new Error('unexpected external request')
  }
  t.after(() => { globalThis.fetch = original })
  apply(ctx, { claudeCliPath: cli, claudeCliCwd: dir, claudeCliMode: 'read-only', claudeRuntime: 'cli' })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: RELAY_KEY, label: 'relay' })
  assert.equal((await seen.handler('search/status')).value.searchProvider, 'default')
  assert.equal((await seen.handler('search/status')).value.available, false)

  const ds = await turn(seen.adapter)
  assert.equal(ds.at(-1).reason.kind, 'stop')
  const dsText = ds.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.match(dsText, /Public summary/u)
  assert.doesNotMatch(dsText, /sk-plugin-only/u)
  assert.match(ds.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), /Geek2API Claude（MCP/u)
  assert.equal(requests[0].body.model, 'claude-haiku-4-5-20251001')
  assert.equal(requests[0].key, RELAY_KEY)

  await seen.handler('search/update', { searchBackend: 'gpt' })
  const gpt = await turn(seen.adapter)
  assert.equal(gpt.at(-1).reason.kind, 'stop')
  assert.equal(requests[1].body.model, 'gpt-6.1-sol')
  assert.equal(requests[1].body.prompt_cache_key, 'originating-dsh-session', 'captured before MCP HTTP callback loses agent scope')
  assert.equal(requests[1].key, RELAY_KEY)
  assert.match(gpt.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), /Geek2API GPT（MCP/u)

  await turn(seen.adapter, 'session-title')
  assert.equal(requests.length, 2, 'titles issue no search')
  const invocations = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)
  for (const invocation of invocations.slice(0, 2)) {
    assert.ok(invocation.args.includes(invocation.tool))
    assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false)
    assert.equal(invocation.args[invocation.args.indexOf('--disallowedTools') + 1], 'WebSearch')
    await assert.rejects(readFile(invocation.path), error => error.code === 'ENOENT')
    assert.doesNotMatch(JSON.stringify(invocation), /sk-plugin-only/u)
  }
  assert.equal(invocations[2].path, null)
  assert.equal(invocations[2].args[invocations[2].args.indexOf('--disallowedTools') + 1], 'WebSearch')
})
