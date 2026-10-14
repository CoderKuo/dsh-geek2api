#!/usr/bin/env node
/**
 * Real official CLI → built MCP bridge → search check, without requiring a
 * Claude-group key. A local fake Anthropic gateway requests the MCP search
 * tool and records that native WebSearch/server tools never appear. The CLI
 * itself is real, including its MCP transport and permission handling.
 *
 *   node scripts/cli-search-check.mjs
 *   node scripts/cli-search-check.mjs --live --backend claude
 *   node scripts/cli-search-check.mjs --live --backend gpt
 *   node scripts/cli-search-check.mjs --binary /path/to/claude
 *
 * Default: mocked search, no quota. --live: ONE real search through the
 * selected Geek2API backend in read-only mode using the same stored key as
 * live-check.mjs; edit/full are still mocked. No DSH is started, and no real
 * key is given to the CLI or fake gateway or written into MCP configuration.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClaudeRunner, createClaudeSearchBridge, createGeek2APISearchProvider, createHostPool, findClaudeBinary, Geek2APIKeyRing } from '../lib/index.js'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const backend = option('--backend', 'claude')
if (!['claude', 'gpt'].includes(backend)) throw new Error('backend must be claude or gpt')
const live = args.includes('--live')
const binary = findClaudeBinary(option('--binary', ''))
// This store is host-only; the real key never reaches the child process.
let record
const credentials = { readRecord: async () => record, modifyRecord: async (_id, mutate) => { record = await mutate(record); return record } }
const ring = new Geek2APIKeyRing(credentials)
let secret
if (live) {
  const text = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const match = /^\s*GEEK2API_API_KEY:\s*(.+)$/mu.exec(text)
  if (match === null) throw new Error('Store a Geek2API key in DSH before using --live')
  secret = match[1].trim().replace(/^['"]|['"]$/gu, '')
  await ring.add(secret, 'CLI MCP live check')
}
const provider = createGeek2APISearchProvider({ ring, hosts: createHostPool(), backend: () => backend, resolveSessionId: () => 'dsh-cli-mcp-live-check' })
const directory = await mkdtemp(join(tmpdir(), 'geek2api-cli-mcp-check-'))
const ownedDirectory = await realpath(directory)
let mode
let mainCalls = 0
let searchCalls = 0
let nativeSearchCalls = 0
let currentToolName
const requests = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch { body = {} }
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
      return res.end(req.url.includes('count_tokens') ? '{"input_tokens":1}' : '{}')
    }
    if ((body.tools ?? []).some(t => t.type?.startsWith('web_search'))) {
      nativeSearchCalls++
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Mock gateway refuses Claude native search child calls' } }))
    }
    if (body.max_tokens !== 1) mainCalls++
    const tool = (body.tools ?? []).find(t => /^mcp__geek2api_search_[a-f0-9]+__web_search$/u.test(t.name ?? ''))
    requests.push({ mode, hasBridge: Boolean(tool), hasNativeSearch: (body.tools ?? []).some(t => t.name === 'WebSearch'), officialIdentity: Array.isArray(body.system) && body.system.some(b => b.text?.startsWith('You are Claude Code, Anthropic\'s official CLI')) })
    const callSearch = mainCalls === 1 && body.max_tokens !== 1 && tool !== undefined
    if (tool !== undefined) currentToolName = tool.name
    const result = callSearch
      ? { type: 'tool_use', id: 'tool_mcp_check', name: tool.name, input: { query: 'latest Node.js release', max_results: 2 } }
      : { type: 'text', text: tool === undefined ? 'bridge missing' : 'MCP search completed.' }
    const stop = callSearch ? 'tool_use' : 'end_turn'
    const message = { id: 'msg_mcp_check', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ...message, content: [result], stop_reason: stop }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('message_start', { message })
    event('content_block_start', { index: 0, content_block: callSearch ? { ...result, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: callSearch ? { type: 'input_json_delta', partial_json: JSON.stringify(result.input) } : { type: 'text_delta', text: result.text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
    event('message_stop', {})
    res.end()
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
try {
  for (const variant of ['read-only', 'edit', 'full']) {
    mode = variant
    mainCalls = 0
    const before = searchCalls
    let configPath
    const useLiveSearch = live && mode === 'read-only'
    const runner = createClaudeRunner({
      binary,
      configDir: join(directory, `config-${mode}`),
      resolveCredential: async () => ({ baseUrl, token: 'sk-dummy-cli-not-a-real-key', label: 'mock Claude gateway' }),
      createSearchBridge: async ({ signal }) => {
        const bridge = await createClaudeSearchBridge({
          signal,
          backend: () => backend,
          sanitize: text => secret === undefined ? text : text.split(secret).join('[redacted]'),
          search: async (request, searchSignal) => {
            searchCalls++
            let result
            try {
              result = useLiveSearch ? await provider.search(request, searchSignal) : { content: 'Mock search result', sources: [{ url: 'https://nodejs.org/en/blog/release', title: 'Node.js releases' }] }
            } catch (error) {
              // Diagnostics stay in this host-side test only; remove the stored
              // key even if a gateway/transport happens to echo it.
              const detail = String(error?.message ?? error)
              console.error(`  ${backend} backend failure (${error?.code ?? 'error'}): ${secret === undefined ? detail.slice(0, 300) : detail.split(secret).join('[redacted]').slice(0, 300)}`)
              throw error
            }
            assert.ok(result.sources.length > 0, 'the selected search backend returned no sources')
            console.log(`  ${useLiveSearch ? `live ${backend}` : 'mock search'}: ${result.sources.length} sources`)
            return result
          },
        })
        configPath = bridge.configPath
        return bridge
      },
      timeoutMs: 120_000,
    })
    const errors = []
    try {
      for await (const event of runner.stream({ prompt: 'Search the web using the provided Geek2API MCP tool and cite the sources. Do not use shell commands or other tools.', mode, model: 'claude-opus-5-5', cwd: directory })) {
        if (event.type === 'tool-error') errors.push(event.text)
      }
      assert.equal(searchCalls - before, 1, `${mode}: actual CLI never called MCP search`)
      assert.deepEqual(errors, [], `${mode}: actual MCP/permission error`)
      assert.ok(requests.filter(r => r.mode === mode).every(r => !r.hasNativeSearch && r.officialIdentity), `${mode}: native search present or CLI identity replaced`)
      await assert.rejects(readFile(configPath), e => e.code === 'ENOENT')
      console.log(`${mode}: real CLI MCP call OK; native WebSearch absent; official identity preserved; config cleaned (${currentToolName})`)
    } finally { await runner.close() }
  }
  assert.equal(nativeSearchCalls, 0)
  console.log('PASS: no Claude native-search subrequest was made. Claude model responses above were mocked, not live.')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  // Only delete the private directory this script created and verified.
  assert.equal(await realpath(directory), ownedDirectory)
  await rm(directory, { recursive: true, force: true })
}
