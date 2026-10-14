import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { apply } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'

const KEY_CODEX = 'sk-codex-only-key-AAAA'
const KEY_DEEPSEEK = 'sk-deepseek-key-BBBB'
const KEY_CLAUDE = 'sk-claude-code-key-CCCC'
const GROUPS = { [KEY_CODEX]: ['codex'], [KEY_DEEPSEEK]: ['deepseek'], [KEY_CLAUDE]: ['cc'] }
/** What each key's `/v1/models` lists: exactly what its group serves. */
const MODELS = {
  [KEY_CODEX]: ['gpt-6.1-sol', 'gpt-6-astra'],
  [KEY_DEEPSEEK]: ['deepseek-v4.1-flash'],
  [KEY_CLAUDE]: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'],
}

const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
})

/**
 * A stand-in Geek2API gateway on `fetch`: health, each key's model list and
 * groups, and a streaming chat completion that records the key it was sent.
 */
function fakeGateway() {
  const chatKeys = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
    const key = headers.get('authorization')?.replace(/^Bearer /u, '')
    if (url.endsWith('/health')) return Response.json({ status: 'ok' })
    if (url.endsWith('/v1/models')) return Response.json({ object: 'list', data: (MODELS[key] ?? []).map(id => ({ id, type: 'model' })) })
    if (url.includes('/v1/usage')) return Response.json({ mode: 'unrestricted', balance: 10, key: { name: 'k', groups: (GROUPS[key] ?? []).map(name => ({ name })) } })
    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text())
      chatKeys.push(key)
      return sse([
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ])
    }
    return new Response('{}', { status: 404 })
  }
  return { chatKeys, restore: () => { globalThis.fetch = original } }
}

function context() {
  const seen = {}
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (_providers, adapter) => { seen.adapter = adapter; return () => {} },
      registerConfigurableProviders: () => () => {},
    },
    get: () => undefined,
    inject(names, callback) {
      if (names.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle: (_c, handler) => { seen.handler = handler; return () => {} } } } })
      if (names.includes('tools')) return callback({ tools: { register: () => () => {} } })
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, seen }
}

const turn = async (adapter, model) => {
  const prepared = await adapter.prepareCall('geek2api', model)
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'geek2api',
    model,
    sessionId: 'session-1',
    reasoningEffort: 'high',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  return chunks
}

test('an HTTP turn runs on a key whose groups reach its model, without moving the active key', async t => {
  const gateway = fakeGateway()
  t.after(gateway.restore)
  const { ctx, seen } = context()
  apply(ctx, {})
  await seen.handler('keys/add', { key: KEY_CODEX, label: 'codex' })
  await seen.handler('keys/add', { key: KEY_DEEPSEEK, label: 'deepseek' })

  const chunks = await turn(seen.adapter, 'deepseek-v4.1-flash')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // The active key (codex) does not list DeepSeek; the DeepSeek key served it.
  assert.deepEqual(gateway.chatKeys, [KEY_DEEPSEEK])
  const status = await seen.handler('status', {})
  assert.equal(status.value.keys.find(key => key.active).label, 'codex')

  // The panel's group projection names both keys' groups, and no key.
  const groups = await seen.handler('groups', {})
  assert.equal(groups.ok, true)
  assert.deepEqual(groups.value.keys.map(key => key.groups), [['codex'], ['deepseek']])
  assert.equal(groups.value.keys[1].coverage['deepseek-v4.1-flash'], true)
  assert.equal(groups.value.keys[0].coverage['deepseek-v4.1-flash'], false)
  assert.doesNotMatch(JSON.stringify(groups), /sk-(codex|deepseek)/u)
})

test('a Claude CLI turn after "use this key" runs on that key, and otherwise on one with a Claude group', async t => {
  const gateway = fakeGateway()
  t.after(gateway.restore)
  const dir = await mkdtemp(join(tmpdir(), 'geek2api-key-choice-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // A stand-in CLI: records the key it was started with, prints one result.
  const out = join(dir, 'keys.log')
  const cli = join(dir, 'claude')
  await writeFile(cli, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(${JSON.stringify(out)}, process.env.ANTHROPIC_AUTH_TOKEN.slice(-4) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }))
})
`)
  await chmod(cli, 0o755)

  const { ctx, seen } = context()
  apply(ctx, { claudeCliPath: cli, claudeCliMode: 'read-only', claudeCliCwd: dir, claudeRuntime: 'cli' })
  await seen.handler('keys/add', { key: KEY_CODEX, label: 'codex' })
  await seen.handler('keys/add', { key: KEY_CLAUDE, label: 'claude' })

  // Active key without a Claude group: the run uses the cc key and says so.
  const passedOver = await turn(seen.adapter, 'claude-opus-5-5')
  const notes = passedOver.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  assert.match(notes, /当前 Key「codex」的分组不能用 claude-opus-5-5，本轮改用 Key「claude」（分组：cc）/u)

  // "Use this key" on the cc key: the very next run uses it, named plainly.
  const status = await seen.handler('status', {})
  await seen.handler('keys/select', { id: status.value.keys.find(key => key.label === 'claude').id })
  const selected = await turn(seen.adapter, 'claude-opus-5-5')
  assert.match(selected.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), /▸ 使用 Key「claude」（分组：cc）/u)

  assert.deepEqual((await readFile(out, 'utf8')).trim().split('\n'), ['CCCC', 'CCCC'])
})
