import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CLAUDE_CLI_MODES,
  DEFAULT_APPEND_SYSTEM_PROMPT,
  DEFAULT_CLAUDE_MODE,
  buildClaudeArgs,
  buildClaudeEnvironment,
  buildClaudeInput,
  createClaudeRunner,
  findClaudeBinary,
  findPlanWrittenDuringRun,
  parseClaudeResult,
  readClaudeStreamEvents,
  readSubmittedPlan,
  summarizeToolUse,
} from '../src/claude-cli.js'

const PAYLOAD = {
  is_error: false,
  result: 'cli-ok',
  type: 'result',
  duration_ms: 22736,
  total_cost_usd: 0.18625375,
  usage: { input_tokens: 2, output_tokens: 7 },
}

/** A spawn stand-in that records its call and stdin, and replays a scripted child. */
function stubSpawn({ stdout = `${JSON.stringify(PAYLOAD)}\n`, stderr = '', code = 0, hang = false } = {}) {
  const calls = []
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, stdin: '', stdinClosed: false }
    calls.push(call)
    const child = new EventEmitter()
    child.stdin = {
      on: () => child.stdin,
      write: input => { call.stdin += input ?? '' },
      end: input => {
        call.stdin += input ?? ''
        call.stdinClosed = true
      },
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = signal => {
      child.signalCode = signal
      queueMicrotask(() => child.emit('close', null, signal))
      return true
    }
    if (!hang) {
      queueMicrotask(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.exitCode = code
        child.emit('close', code, null)
      })
    }
    return child
  }
  return { spawnImpl, calls }
}

test('builds the argv the CLI documents, with the prompt kept off it', () => {
  assert.deepEqual(buildClaudeArgs({}), [
    '-p', '--output-format', 'json',
    '--append-system-prompt', DEFAULT_APPEND_SYSTEM_PROMPT,
    '--allowedTools', ...CLAUDE_CLI_MODES[DEFAULT_CLAUDE_MODE].allowedTools,
  ])
  const full = buildClaudeArgs({ mode: 'full', model: 'claude-opus-5-5' })
  assert.deepEqual(full, ['-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--append-system-prompt', DEFAULT_APPEND_SYSTEM_PROMPT, '--dangerously-skip-permissions'])
  assert.deepEqual(buildClaudeArgs({ mode: 'read-only' }).slice(-4), ['--allowedTools', 'Read', 'Grep', 'Glob'])
  // A streaming run reads its prompt as stream-json from stdin.
  assert.deepEqual(buildClaudeArgs({ stream: true }).slice(0, 7), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'])
  // Extra instructions are appended; the CLI's own system prompt and tools stay.
  const titled = buildClaudeArgs({ mode: 'read-only', model: 'claude-haiku-4-5-20251001', appendSystemPrompt: '  Return only the title.  ' })
  assert.deepEqual(titled.slice(3), ['--model', 'claude-haiku-4-5-20251001', '--append-system-prompt', 'Return only the title.', '--allowedTools', 'Read', 'Grep', 'Glob'])
  assert.equal(titled.includes('--system-prompt'), false)
  assert.equal(titled.includes('--tools'), false)
  // Every run carries appended instructions: in print mode that is what makes
  // the official CLI introduce itself to the model as Claude Code.
  const blank = buildClaudeArgs({ appendSystemPrompt: '   ' })
  assert.equal(blank[blank.indexOf('--append-system-prompt') + 1], DEFAULT_APPEND_SYSTEM_PROMPT)
  const plan = buildClaudeArgs({ mode: 'plan', stream: true, model: 'claude-opus-5-5', planDirectory: '/private/this run/plans' })
  assert.equal(plan[plan.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(plan[plan.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.deepEqual(JSON.parse(plan[plan.indexOf('--settings') + 1]), {
    plansDirectory: '/private/this run/plans', permissions: { ask: ['ExitPlanMode'] },
  })
  assert.equal(plan.includes('--allowedTools'), false)
  assert.equal(plan.includes('--dangerously-skip-permissions'), false)
  assert.equal(plan.includes('--setting-sources'), false)
  assert.throws(() => buildClaudeArgs({ mode: 'plan', planDirectory: 'relative/plans' }), /absolute path/u)
  assert.equal(buildClaudeArgs({ mode: 'edit', planDirectory: '/private/plans' }).includes('--settings'), false)
})

test('builds the stdin payload: plain text, or one stream-json user message with images', () => {
  assert.equal(buildClaudeInput({ prompt: '多行\n提示' }), '多行\n提示')
  const line = buildClaudeInput({
    stream: true,
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '' },
    ],
  })
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  })
  assert.deepEqual(JSON.parse(buildClaudeInput({ stream: true, prompt: 'hi' })).message.content, [{ type: 'text', text: 'hi' }])
})

test('refuses a missing prompt, an unknown mode, an oversized prompt, and images without streaming', () => {
  assert.throws(() => buildClaudeInput({ prompt: '   ' }), /non-empty prompt/u)
  assert.throws(() => buildClaudeArgs({ mode: 'yolo' }), /mode must be one of/u)
  assert.throws(() => buildClaudeInput({ prompt: 'x'.repeat(100_001) }), /too long/u)
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  assert.throws(() => buildClaudeInput({ content: [image] }), /streaming CLI input/u)
  assert.throws(() => buildClaudeInput({ stream: true, content: Array.from({ length: 21 }, () => image) }), /at most 20 images/u)
})

test('the child environment carries this plugin endpoint and key, not the ambient ones', () => {
  const env = buildClaudeEnvironment({
    baseUrl: 'https://hk.geek2api.com',
    token: 'sk-plugin-key',
    configDir: '/tmp/claude-home',
    parent: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'oat', HOME: '/Users/x' },
  })
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://hk.geek2api.com')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-plugin-key')
  // An isolated config home is what stops ~/.claude/settings.json from winning.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/claude-home')
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DISABLE_AUTOUPDATER, '1')
  assert.throws(() => buildClaudeEnvironment({ baseUrl: 'https://hk.geek2api.com', token: '' }), /no Geek2API API key/u)
})

test('reads the payload the CLI prints', () => {
  assert.equal(parseClaudeResult(JSON.stringify(PAYLOAD)).result, 'cli-ok')
  assert.equal(parseClaudeResult(`warning: something\n${JSON.stringify(PAYLOAD)}\n`).is_error, false)
  assert.equal(parseClaudeResult('not json at all'), undefined)
  assert.equal(parseClaudeResult('{"other":1}'), undefined)
})

test('runs the binary with the resolved credential and returns its accounting', async () => {
  const { spawnImpl, calls } = stubSpawn()
  const runner = createClaudeRunner({
    binary: '/opt/claude',
    configDir: '/tmp/claude-home',
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-plugin-key' }),
    spawnImpl,
  })
  const value = await runner.run({ prompt: 'say ok', mode: 'read-only', cwd: '/work' })
  assert.equal(value.result, 'cli-ok')
  assert.equal(value.costUsd, 0.18625375)
  assert.equal(value.mode, 'read-only')
  assert.equal(value.outputTokens, 7)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, '/opt/claude')
  assert.equal(calls[0].options.cwd, '/work')
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-plugin-key')
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/tmp/claude-home')
  // The prompt arrives on stdin, which is then closed; argv never carries it.
  assert.equal(calls[0].stdin, 'say ok')
  assert.equal(calls[0].stdinClosed, true)
  assert.equal(calls[0].args.includes('say ok'), false)
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
})

test("a failing CLI reports the reason it printed", async () => {
  const { spawnImpl } = stubSpawn({
    stdout: `${JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 无效的令牌' })}\n`,
    code: 1,
  })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), /Failed to authenticate/u)
})

test('a CLI that prints nothing reports its stderr', async () => {
  const { spawnImpl } = stubSpawn({ stdout: '', stderr: 'boom from the CLI', code: 2 })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), /code 2: boom from the CLI/u)
})

test('an abort kills the child instead of leaving it running', async () => {
  const { spawnImpl, calls } = stubSpawn({ hang: true })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
  })
  const controller = new AbortController()
  const pending = runner.run({ prompt: 'long task', signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(() => pending, /aborted/u)
  assert.equal(calls.length, 1)
})

test('a timeout stops a hung CLI', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
    timeoutMs: 20,
  })
  // The runner unrefs its timer, and this stub is not a real process, so
  // nothing else keeps the loop alive. Node 22's test runner then cancels the
  // still-pending assertion instead of waiting for the timeout.
  const pin = setInterval(() => {}, 1000)
  try {
    await assert.rejects(() => runner.run({ prompt: 'x' }), /timed out/u)
  } finally {
    clearInterval(pin)
  }
})

const STREAM_LINES = [
  { type: 'system', subtype: 'init', claude_code_version: '2.1.295', model: 'claude-opus-5-5' },
  { type: 'system', subtype: 'status', status: 'requesting' },
  { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1240, error_status: 503, error: 'server_error' },
  { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 443, cache_read_input_tokens: 42_880, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git   status\n--short' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 443, cache_read_input_tokens: 42_880 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'fatal: not a git repository' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'fine' }] } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } } },
  { type: 'result', is_error: false, result: '完成', total_cost_usd: 0.2, usage: { input_tokens: 4, output_tokens: 300, cache_read_input_tokens: 85_760, cache_creation_input_tokens: 886 } },
]

test('reads live text, thinking, tool calls, tool failures, and request usage from stream-json', () => {
  const events = STREAM_LINES.flatMap(readClaudeStreamEvents)
  assert.deepEqual(events.slice(0, -1), [
    { type: 'started', version: '2.1.295', model: 'claude-opus-5-5' },
    { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 1240, status: 503, error: 'server_error' },
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 42_880, cacheWriteTokens: 443 } },
    { type: 'block', kind: 'reasoning' },
    { type: 'reasoning', text: '想一想' },
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 42_880, cacheWriteTokens: 443 } },
    { type: 'tool', id: 'toolu_1', summary: 'Bash · git status --short' },
    { type: 'tool-error', id: 'toolu_1', text: 'fatal: not a git repository' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '完成' },
  ])
  assert.equal(events.at(-1).type, 'result')
})

test('a tool summary names the input a reader looks for', () => {
  assert.equal(summarizeToolUse('Read', { file_path: '/a/b.cs', limit: 20 }), 'Read · /a/b.cs')
  assert.equal(summarizeToolUse('Grep', { pattern: 'foo', path: '/x' }), 'Grep · foo')
  assert.equal(summarizeToolUse('TodoWrite', { todos: [] }), 'TodoWrite')
  assert.equal(summarizeToolUse('mcp__geek2api_search_ab1234__web_search', { query: 'latest release' }), 'Geek2API WebSearch · latest release')
  assert.equal(summarizeToolUse('Bash', { command: 'x'.repeat(400) }).length, 'Bash · '.length + 160)
})

test('the streaming runner yields events as they arrive and closes with the summed accounting', async () => {
  const { spawnImpl, calls } = stubSpawn({ stdout: `${STREAM_LINES.map(line => JSON.stringify(line)).join('\n')}\n` })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
  })
  const events = []
  for await (const event of runner.stream({ prompt: 'x' })) events.push(event)
  assert.ok(calls[0].args.includes('--include-partial-messages'))
  assert.deepEqual(JSON.parse(calls[0].stdin).message.content, [{ type: 'text', text: 'x' }])
  assert.equal(events.filter(event => event.type === 'result').length, 1)
  const { result } = events.at(-1)
  assert.equal(result.outputTokens, 300)
  assert.equal(result.cacheReadTokens, 85_760)
  assert.equal(result.cacheWriteTokens, 886)
  assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: '完成' }])
})

test('each run resolves its key for its own model and names that key, never the token', async () => {
  const { spawnImpl, calls } = stubSpawn({ stdout: `${STREAM_LINES.map(line => JSON.stringify(line)).join('\n')}\n` })
  const asked = []
  let label = 'no-cc'
  const runner = createClaudeRunner({
    resolveCredential: async ({ model }) => {
      asked.push(model)
      return {
        baseUrl: 'https://hk.geek2api.com',
        token: label === 'no-cc' ? 'sk-without-claude-AAAA' : 'sk-with-claude-BBBB',
        label,
        model,
        groups: label === 'no-cc' ? ['codex'] : ['cc'],
        required: ['cc', 'cc-sale'],
        covers: label !== 'no-cc',
      }
    },
    spawnImpl,
  })
  const run = async () => {
    const events = []
    for await (const event of runner.stream({ prompt: 'x', model: 'claude-opus-5-5' })) events.push(event)
    return events
  }
  const first = await run()
  label = 'cc'
  const second = await run()
  // Resolved per run: the second run sees the switch.
  assert.deepEqual(asked, ['claude-opus-5-5', 'claude-opus-5-5'])
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-without-claude-AAAA')
  assert.equal(calls[1].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-with-claude-BBBB')
  assert.deepEqual(first[0], { type: 'key', label: 'no-cc', model: 'claude-opus-5-5', groups: ['codex'], required: ['cc', 'cc-sale'], covers: false })
  assert.equal(second[0].label, 'cc')
  assert.doesNotMatch(JSON.stringify([...first, ...second]), /sk-with|sk-without/u)
})

/** A spawn stand-in whose stdout is a real byte stream fed the given buffers. */
function byteStreamSpawn(buffers) {
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    child.stdout.on('end', () => {
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    queueMicrotask(async () => {
      for (const buffer of buffers) {
        child.stdout.write(buffer)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      child.stdout.end()
    })
    return child
  }
  return spawnImpl
}

test('a multi-byte character split across two pipe reads arrives intact', async () => {
  const bytes = Buffer.from(`${JSON.stringify({ ...PAYLOAD, result: '中文回答' })}\n`)
  const cut = bytes.indexOf(Buffer.from('文')) + 1
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl: byteStreamSpawn([bytes.subarray(0, cut), bytes.subarray(cut)]),
  })
  const value = await runner.run({ prompt: 'x' })
  assert.equal(value.result, '中文回答')
})

test('a consumer that stops reading early kills the streaming CLI', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  let child
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl: (...args) => {
      child = spawnImpl(...args)
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(STREAM_LINES.find(line => line.event?.delta?.type === 'thinking_delta'))}\n`))
      return child
    },
  })
  for await (const event of runner.stream({ prompt: 'x' })) {
    assert.equal(event.type, 'reasoning')
    break
  }
  assert.equal(child.signalCode, 'SIGTERM')
})

function bridgeStub() {
  let starts = 0
  let closes = 0
  const factory = async () => {
    starts++
    let closed = false
    return {
      configPath: '/private-run/mcp.json',
      toolName: 'mcp__geek2api_search_ab1234__web_search',
      instructions: 'Use the MCP search tool; native WebSearch is disabled.',
      backend: 'claude',
      close: async () => { if (!closed) { closes++; closed = true } },
    }
  }
  return { factory, get starts() { return starts }, get closes() { return closes } }
}

const credential = async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-plugin-secret', label: 'test' })

test('MCP argv grants only the exact read-only search tool and disables native WebSearch in every mode', () => {
  const bridge = { configPath: '/private-run/mcp.json', toolName: 'mcp__geek2api_search_ab1234__web_search', instructions: 'Use MCP search.' }
  for (const mode of ['read-only', 'edit', 'full']) {
    const args = buildClaudeArgs({ mode, searchBridge: bridge })
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'WebSearch')
    assert.equal(args[args.indexOf('--mcp-config') + 1], bridge.configPath)
    assert.equal(args.includes('--strict-mcp-config'), false)
    assert.equal(args.includes('--system-prompt'), false)
    assert.equal(args.some(arg => /mcp__.*\*/u.test(arg)), false)
    if (mode !== 'full') {
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
      assert.deepEqual(allowed, [...CLAUDE_CLI_MODES[mode].allowedTools, bridge.toolName])
      assert.equal(args.includes('--dangerously-skip-permissions'), false)
    }
  }
  const plan = buildClaudeArgs({ mode: 'plan', searchBridge: bridge })
  assert.equal(plan[plan.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(plan[plan.indexOf('--allowedTools') + 1], bridge.toolName)
  assert.equal(plan[plan.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.deepEqual(JSON.parse(plan[plan.indexOf('--settings') + 1]), { permissions: { ask: ['ExitPlanMode'] } })
  assert.equal(plan.includes('--dangerously-skip-permissions'), false)
  assert.throws(() => buildClaudeArgs({ searchBridge: { ...bridge, toolName: 'mcp__anything__*' } }), /configuration is invalid/u)
})

test('MCP bridge closes on successful/nonzero/invalid JSON exits and synchronous/asynchronous spawn failure', async () => {
  for (const variant of ['success', 'nonzero', 'invalid', 'sync-spawn', 'async-spawn', 'stdin']) {
    const bridge = bridgeStub()
    const { spawnImpl } = stubSpawn({ code: variant === 'nonzero' ? 1 : 0, stdout: variant === 'invalid' ? 'not JSON' : `${JSON.stringify(PAYLOAD)}\n`, hang: ['async-spawn', 'stdin'].includes(variant) })
    const runner = createClaudeRunner({
      binary: '/mock/claude',
      resolveCredential: credential,
      createSearchBridge: bridge.factory,
      spawnImpl: (...args) => {
        if (variant === 'sync-spawn') throw new Error('spawn failed')
        const child = spawnImpl(...args)
        if (variant === 'async-spawn') queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        if (variant === 'stdin') child.stdin.end = () => { throw new Error('stdin failed') }
        return child
      },
    })
    if (variant === 'success') await runner.run({ prompt: 'x' })
    else await assert.rejects(runner.run({ prompt: 'x' }))
    assert.equal(bridge.starts, 1, variant)
    assert.equal(bridge.closes, 1, variant)
    await runner.close()
  }
})

test('pre-aborted and cancelled setup never spawns; a late bridge factory is disposed', async () => {
  for (const phase of ['pre', 'credential', 'binary', 'bridge']) {
    const bridge = bridgeStub()
    const controller = new AbortController()
    const spawn = []
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    let resolveBlocked
    const blocked = new Promise(resolve => { resolveBlocked = resolve })
    const runner = createClaudeRunner({
      binary: phase === 'binary' ? async () => { entered(); await blocked; return '/mock/claude' } : '/mock/claude',
      resolveCredential: phase === 'credential' ? async () => { entered(); await blocked; return credential() } : credential,
      createSearchBridge: phase === 'bridge' ? async () => { entered(); await blocked; return bridge.factory() } : bridge.factory,
      spawnImpl: (...args) => { spawn.push(args); throw new Error('should not spawn') },
    })
    if (phase === 'pre') controller.abort()
    const pending = runner.run({ prompt: 'x', signal: controller.signal })
    if (phase !== 'pre') { await ready; controller.abort() }
    await assert.rejects(pending, /aborted/u)
    resolveBlocked()
    await new Promise(resolve => setImmediate(resolve))
    await runner.close()
    assert.equal(spawn.length, 0, phase)
    if (phase === 'bridge') assert.equal(bridge.closes, 1)
    else assert.equal(bridge.starts, 0)
  }
})

test('returning on the first key or MCP progress event terminates the CLI and closes its bridge', async () => {
  for (const stopOn of ['key', 'search-bridge']) {
    const bridge = bridgeStub()
    let child
    const { spawnImpl } = stubSpawn({ hang: true })
    const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, createSearchBridge: bridge.factory, spawnImpl: (...args) => { child = spawnImpl(...args); return child } })
    for await (const event of runner.stream({ prompt: 'x' })) {
      if (event.type === stopOn) break
    }
    assert.equal(child.signalCode, 'SIGTERM')
    assert.equal(bridge.closes, 1)
    await runner.close()
  }
})

test('abort, timeout, startup watchdog and plugin unload immediately revoke MCP access', async () => {
  for (const variant of ['abort', 'timeout', 'watchdog', 'unload']) {
    const bridge = bridgeStub()
    const { spawnImpl } = stubSpawn({ hang: true })
    const controller = new AbortController()
    const runner = createClaudeRunner({
      resolveCredential: credential, spawnImpl, createSearchBridge: bridge.factory,
      timeoutMs: variant === 'timeout' ? 20 : 1000,
      startupTimeoutMs: variant === 'watchdog' ? 20 : 1000,
    })
    const keepAlive = setInterval(() => {}, 1000)
    try {
      const pending = variant === 'watchdog' ? (async () => { for await (const _event of runner.stream({ prompt: 'x' })) { /* startup */ } })() : runner.run({ prompt: 'x', signal: controller.signal })
      pending.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 5))
      if (variant === 'abort') controller.abort()
      if (variant === 'unload') await runner.close()
      await assert.rejects(pending)
      assert.equal(bridge.closes, 1, variant)
      await runner.close()
    } finally { clearInterval(keepAlive) }
  }
})

test('titles opt out of MCP allocation but still deny native search, and emitted diagnostics redact API keys', async () => {
  const bridge = bridgeStub()
  const token = 'sk-secret-never-in-results'
  const { spawnImpl, calls } = stubSpawn({ stdout: `${JSON.stringify({ ...PAYLOAD, result: `echoed ${token}` })}\n` })
  const runner = createClaudeRunner({ resolveCredential: async () => ({ baseUrl: 'https://gw.example', token }), spawnImpl, createSearchBridge: bridge.factory })
  const value = await runner.run({ prompt: 'title', enableSearch: false })
  assert.equal(bridge.starts, 0)
  assert.equal(calls[0].args.includes('--mcp-config'), false)
  assert.equal(calls[0].args[calls[0].args.indexOf('--disallowedTools') + 1], 'WebSearch')
  assert.doesNotMatch(value.result, /sk-secret/u)
  assert.match(value.result, /\[redacted\]/u)
  const events = []
  for await (const event of runner.stream({ prompt: 'x' })) events.push(event)
  assert.doesNotMatch(JSON.stringify(events), /sk-secret/u)
  assert.equal(bridge.closes, 1)
  await runner.close()
})

test('text/reasoning deltas split across events never reconstruct a relay key or MCP capability', async () => {
  const token = 'sk-stream-only-dummy-key-0000'
  const capability = 'mockcapabilityabcdef0123456789'
  for (const kind of ['text', 'reasoning']) {
    const text = kind === 'text' ? 'text' : 'thinking'
    const delta = value => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: kind === 'text' ? 'text_delta' : 'thinking_delta', [text]: value } } })
    const payload = [delta(`echo ${token.slice(0, 8)}`), delta(`${token.slice(8)} and ${capability.slice(0, 9)}`), delta(`${capability.slice(9)}.`), PAYLOAD]
    const { spawnImpl } = stubSpawn({ stdout: `${payload.map(JSON.stringify).join('\n')}\n` })
    const bridge = bridgeStub()
    const runner = createClaudeRunner({ resolveCredential: async () => ({ baseUrl: 'https://gw.example', token }), spawnImpl, createSearchBridge: async () => ({ ...await bridge.factory(), redactionValues: () => [capability] }) })
    const events = []
    for await (const event of runner.stream({ prompt: 'x' })) events.push(event)
    const displayed = events.filter(event => event.type === kind).map(event => event.text).join('')
    assert.equal(displayed, 'echo [redacted] and [redacted].')
    assert.equal(displayed.includes(token), false)
    assert.equal(displayed.includes(capability), false)
    await runner.close()
  }
})

test('a successful-looking stream result followed by nonzero child exit is not success', async () => {
  const { spawnImpl } = stubSpawn({ code: 2 })
  const bridge = bridgeStub()
  const runner = createClaudeRunner({ resolveCredential: credential, spawnImpl, createSearchBridge: bridge.factory })
  const events = []
  await assert.rejects(async () => { for await (const event of runner.stream({ prompt: 'x' })) events.push(event) }, /failed/u)
  assert.equal(events.some(event => event.type === 'result'), false)
  assert.equal(bridge.closes, 1)
  await runner.close()
})

test('an explicit binary path wins and PATH is the fallback', () => {
  assert.equal(findClaudeBinary('/custom/claude'), '/custom/claude')
  assert.equal(typeof findClaudeBinary(''), 'string')
})

test('a streaming CLI that prints nothing after starting is stopped with its stderr', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  let child
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl: (...args) => {
      child = spawnImpl(...args)
      queueMicrotask(() => child.stderr.emit('data', 'waiting for git-bash'))
      return child
    },
    startupTimeoutMs: 20,
  })
  const pin = setInterval(() => {}, 1000)
  try {
    await assert.rejects(async () => {
      for await (const _event of runner.stream({ prompt: 'x' })) {
        // nothing arrives
      }
    }, /printed nothing within 0s of starting and was stopped: waiting for git-bash/u)
  } finally {
    clearInterval(pin)
  }
  assert.equal(child.signalCode, 'SIGTERM')
})

test('the startup watchdog leaves a JSON run alone: it prints only at the end', async () => {
  const { spawnImpl } = stubSpawn()
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
    startupTimeoutMs: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await runner.run({ prompt: 'x' })).result, 'cli-ok')
})

/** Test fixtures are deleted only after checking the exact owned canonical root. */
function testDirectory(t, prefix = 'geek2api-plan-test-') {
  const parent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(parent, prefix)))
  const identity = lstatSync(root)
  t.after(() => {
    assert.equal(dirname(root), parent)
    assert.equal(realpathSync(root), root)
    const current = lstatSync(root)
    assert.equal(current.isSymbolicLink(), false)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

const planDirectoryOf = call => JSON.parse(call.args[call.args.indexOf('--settings') + 1]).plansDirectory
const collect = async iterator => { const events = []; for await (const event of iterator) events.push(event); return events }

/** Record owned production directories and keep filesystem operations real. */
function recordingPlanFs() {
  const created = []
  const removed = []
  return {
    created, removed,
    fs: {
      realpathSync, lstatSync,
      mkdtempSync: prefix => { const path = mkdtempSync(prefix); created.push(path); return path },
      rmSync: (path, options) => {
        assert.ok(created.includes(path))
        assert.equal(realpathSync(path), path)
        assert.equal(lstatSync(path).isSymbolicLink(), false)
        removed.push(path)
        return rmSync(path, options)
      },
    },
  }
}

function assertPlansClean(recorded) {
  assert.deepEqual(recorded.removed, recorded.created)
  for (const path of recorded.created) assert.equal(existsSync(path), false, 'owned plan directory must be gone')
}

test('a submitted plan is inline text or a bounded markdown file inside its bound private directory', t => {
  const root = testDirectory(t)
  const planDirectory = join(root, 'private')
  mkdirSync(planDirectory)
  const inside = join(planDirectory, 'ok.md')
  writeFileSync(inside, '  steps without a heading  ')
  const notes = join(planDirectory, 'notes.txt')
  writeFileSync(notes, '# Notes\n\nno')
  const outside = join(root, 'secret.md')
  writeFileSync(outside, '# Secret\n\nnope')
  const link = join(planDirectory, 'link.md')
  symlinkSync(outside, link)
  const large = join(planDirectory, 'large.md')
  writeFileSync(large, '# Oversize\n' + 'x'.repeat(200_000))
  const directory = join(planDirectory, 'folder.md')
  mkdirSync(directory)
  const configDir = join(root, 'cfg')
  const globalPlans = join(root, '.claude', 'plans')
  mkdirSync(configDir)
  mkdirSync(globalPlans, { recursive: true })
  const shared = join(configDir, 'arbitrary.md')
  const global = join(globalPlans, 'global.md')
  writeFileSync(shared, '# Shared\n\nnever')
  writeFileSync(global, '# Global\n\nnever')
  assert.equal(readSubmittedPlan({ plan: '  # Ship\n\nnow  ' }), '# Ship\n\nnow')
  assert.equal(readSubmittedPlan({ planFilePath: inside }, { planDirectory }), '# Plan\n\nsteps without a heading')
  // Date/mtime are not run identity. Only the unique directory is.
  assert.equal(readSubmittedPlan({ planFilePath: inside }, { planDirectory, startedAt: Date.now() + 60_000 }), '# Plan\n\nsteps without a heading')
  for (const planFilePath of [outside, link, notes, large, directory, 'ok.md', shared, global]) {
    let reads = 0
    assert.equal(readSubmittedPlan({ planFilePath }, {
      planDirectory, configDir, home: root, startedAt: 0,
      readFile: () => { reads += 1; throw new Error('must not read') },
    }), undefined)
    assert.equal(reads, 0, 'rejected paths must never be read')
  }
  assert.equal(readSubmittedPlan({ planFilePath: shared }, { configDir }), undefined)
  assert.equal(readSubmittedPlan({ planFilePath: global }, { home: root }), undefined)
  let reason
  assert.equal(readSubmittedPlan({ plan: '🙂'.repeat(100_000) }, { onRejected: value => { reason = value } }), undefined)
  assert.equal(reason, 'too-large')
  const bounded = readSubmittedPlan({ plan: '🙂'.repeat(40_000) })
  assert.ok(Buffer.byteLength(bounded) <= 200_000)
  assert.equal(bounded.includes('\uFFFD'), false)
})

test('file-only completion requires a bound private directory and never picks the newest of multiple files', t => {
  const root = testDirectory(t)
  const planDirectory = join(root, 'private')
  mkdirSync(planDirectory)
  assert.equal(findPlanWrittenDuringRun({ planDirectory }), undefined)
  const first = join(planDirectory, 'first.md')
  writeFileSync(first, '# First\n\nonly')
  assert.equal(findPlanWrittenDuringRun({ planDirectory }), '# First\n\nonly')
  const second = join(planDirectory, 'second.md')
  writeFileSync(second, '# Second\n\nnewer')
  const future = new Date(Date.now() + 60_000)
  utimesSync(second, future, future)
  assert.equal(findPlanWrittenDuringRun({ planDirectory }), undefined)
  assert.equal(findPlanWrittenDuringRun({ configDir: root, home: root, startedAt: 0 }), undefined)
})

/**
 * A CLI stand-in whose stdin is the stream-json control channel. `script`
 * sees each complete JSON frame and may emit stdout lines.
 */
function controlSpawn(script) {
  const calls = []
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, stdin: '', frames: [], killed: undefined, parsed: 0 }
    calls.push(call)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = signal => {
      call.killed = signal
      child.signalCode = signal
      queueMicrotask(() => child.emit('close', null, signal))
      return true
    }
    const emit = message => queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`))
    const stdout = text => queueMicrotask(() => child.stdout.emit('data', text))
    const consume = () => {
      const lines = call.stdin.split('\n')
      const complete = lines.slice(0, -1)
      while (call.parsed < complete.length) {
        const line = complete[call.parsed]
        call.parsed += 1
        if (line.trim() === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        call.frames.push(message)
        try { script({ message, emit, stdout, call }) } catch (error) {
          queueMicrotask(() => child.emit('error', error))
        }
      }
    }
    child.stdin = {
      on: () => child.stdin,
      write: chunk => {
        call.stdin += String(chunk ?? '')
        consume()
      },
      end: chunk => {
        if (chunk !== undefined && chunk !== '') call.stdin += String(chunk)
        call.stdinClosed = true
        consume()
        if (call.killed === undefined) queueMicrotask(() => child.emit('close', 0, null))
      },
    }
    return child
  }
  return { spawnImpl, calls }
}

const planRunner = spawnImpl => createClaudeRunner({
  binary: '/mock/claude',
  resolveCredential: async () => ({ baseUrl: 'https://cf.example', token: 'sk-test', label: 't' }),
  spawnImpl,
  configDir: '/tmp/geek2api-plan-cfg',
})

test('plan mode denies other tools and stops on ExitPlanMode without allowing it', async () => {
  const { spawnImpl, calls } = controlSpawn(({ message, emit }) => {
    if (message.type === 'user' && calls[0].askedBash !== true) {
      calls[0].askedBash = true
      emit({ type: 'control_request', request_id: 'bash-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf .' } } })
    }
    if (message.type === 'control_response' && message.response?.request_id === 'bash-1' && calls[0].askedPlan !== true) {
      calls[0].askedPlan = true
      emit({
        type: 'control_request',
        request_id: 'plan-1',
        request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Ship it\n\nDo the thing.' } },
      })
    }
  })
  const events = []
  for await (const event of planRunner(spawnImpl).stream({ prompt: 'plan it', mode: 'plan', model: 'claude-opus-5-5' })) events.push(event)
  assert.equal(events.find(event => event.type === 'plan')?.plan, '# Ship it\n\nDo the thing.')
  const call = calls[0]
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(call.args.includes('--input-format'), true)
  assert.equal(call.killed, 'SIGTERM')
  const decisions = call.frames.filter(frame => frame.type === 'control_response').map(frame => frame.response?.response)
  assert.equal(decisions[0]?.behavior, 'deny')
  assert.equal(decisions.some(decision => decision?.behavior === 'allow'), false)
  const finished = await planRunner(controlSpawn(({ message, emit }) => {
    if (message.type === 'user') {
      emit({
        type: 'control_request',
        request_id: 'plan-1',
        request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'steps only' } },
      })
    }
  }).spawnImpl).run({ prompt: 'plan it', mode: 'plan' })
  assert.equal(finished.mode, 'plan')
  assert.match(finished.result, /^# Plan\n\nsteps only/u)
})

test('an ExitPlanMode without a plan is denied, and too many denials stop the run', async () => {
  const missing = controlSpawn(({ message, emit, call }) => {
    if (message.type === 'user' && call.asked !== true) {
      call.asked = true
      emit({ type: 'control_request', request_id: 'plan-1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { planFilePath: '/nope/secret.md' } } })
    }
    if (message.type === 'control_response' && message.response?.request_id === 'plan-1') {
      emit({ type: 'result', is_error: false, result: 'still planning', duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    }
  })
  const events = []
  for await (const event of planRunner(missing.spawnImpl).stream({ prompt: 'plan it', mode: 'plan' })) events.push(event)
  assert.equal(events.some(event => event.type === 'plan'), false)
  assert.equal(events.at(-1)?.result?.result, 'still planning')
  assert.match(missing.calls[0].frames.find(frame => frame.type === 'control_response')?.response?.response?.message ?? '', /plan file/u)

  const burst = controlSpawn(({ message, stdout, call }) => {
    if (message.type !== 'user' || call.flooded === true) return
    call.flooded = true
    const lines = []
    for (let index = 1; index <= 9; index += 1) {
      lines.push(JSON.stringify({
        type: 'control_request',
        request_id: `bash-${index}`,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf .' } },
      }))
    }
    stdout(`${lines.join('\n')}\n`)
  })
  await assert.rejects(async () => {
    for await (const _event of planRunner(burst.spawnImpl).stream({ prompt: 'plan it', mode: 'plan' })) {
      // the ninth denial stops the run
    }
  }, /too many denied permission prompts/u)
  const responses = burst.calls[0].frames.filter(frame => frame.type === 'control_response')
  assert.equal(responses.length, 8)
  assert.equal(burst.calls[0].killed, 'SIGTERM')
})

test('a private plan file is captured before cleanup when the CLI returns without ExitPlanMode', async t => {
  const configDir = testDirectory(t)
  const shared = join(configDir, 'plans')
  mkdirSync(shared)
  const stale = join(shared, 'old.md')
  writeFileSync(stale, '# Old\n\nignore')
  const recorded = recordingPlanFs()
  const { spawnImpl, calls } = controlSpawn(({ message, emit, call }) => {
    if (message.type !== 'user') return
    const plans = planDirectoryOf(call)
    assert.ok(isAbsolute(plans))
    assert.notEqual(plans, shared)
    assert.deepEqual(readdirSync(plans), [])
    if (process.platform !== 'win32') assert.equal(lstatSync(plans).mode & 0o777, 0o700)
    writeFileSync(join(plans, 'shimmering-peach.md'), 'count the files with git ls-files')
    emit({ ...PAYLOAD, result: 'wrote the plan file' })
  })
  const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, spawnImpl, configDir, planFs: recorded.fs })
  const events = await collect(runner.stream({ prompt: 'how many files', mode: 'plan' }))
  assert.equal(events.find(event => event.type === 'plan')?.plan, '# Plan\n\ncount the files with git ls-files')
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, configDir)
  assert.equal(readFileSync(stale, 'utf8'), '# Old\n\nignore')
  assertPlansClean(recorded)
  await runner.close()
})

test('parallel CLI invocations never take another run’s plan even when it has a newer mtime', async t => {
  const configDir = testDirectory(t)
  const recorded = recordingPlanFs()
  const active = new Map()
  const { spawnImpl, calls } = controlSpawn(({ message, emit, call }) => {
    if (message.type !== 'user') return
    const label = message.message.content[0].text
    const plans = planDirectoryOf(call)
    const file = join(plans, 'same-slug.md')
    writeFileSync(file, `# ${label}\n\n${label}-only`)
    if (label === 'B') {
      const future = new Date(Date.now() + 60_000)
      utimesSync(file, future, future)
    }
    active.set(label, { emit, file })
    if (active.size === 2) {
      // Finish A while B’s newer plan exists, then finish B. Time is irrelevant.
      active.get('A').emit({ ...PAYLOAD, result: 'A finished' })
      active.get('B').emit({ ...PAYLOAD, result: 'B finished' })
    }
  })
  const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, spawnImpl, configDir, planFs: recorded.fs })
  const [a, b] = await Promise.all([
    collect(runner.stream({ prompt: 'A', mode: 'plan' })),
    collect(runner.stream({ prompt: 'B', mode: 'plan' })),
  ])
  assert.notEqual(planDirectoryOf(calls[0]), planDirectoryOf(calls[1]))
  assert.equal(a.find(event => event.type === 'plan')?.plan, '# A\n\nA-only')
  assert.equal(b.find(event => event.type === 'plan')?.plan, '# B\n\nB-only')
  assert.deepEqual(new Set(recorded.removed), new Set(recorded.created))
  for (const path of recorded.created) assert.equal(existsSync(path), false)
  await runner.close()
})

test('no-write runs ignore shared startup files, recent previous plans, and concurrent global files', async t => {
  const configDir = testDirectory(t)
  const shared = join(configDir, 'plans')
  mkdirSync(shared)
  const stale = join(shared, 'startup-stale.md')
  writeFileSync(stale, '# Previous\n\ndo not review')
  // It lies inside the former two-second tolerance window and is still ignored.
  const near = new Date(Date.now() - 100)
  utimesSync(stale, near, near)
  const recorded = recordingPlanFs()
  const { spawnImpl, calls } = controlSpawn(({ message, emit, call }) => {
    if (message.type !== 'user') return
    assert.deepEqual(readdirSync(planDirectoryOf(call)), [])
    if (call === calls[0]) writeFileSync(join(planDirectoryOf(call), 'first.md'), '# First\n\nthis run only')
    // Another CLI updates the shared directory in the no-write run.
    else writeFileSync(join(shared, 'other-run.md'), '# Other\n\nnot this run')
    emit({ ...PAYLOAD, result: 'ordinary answer' })
  })
  const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, spawnImpl, configDir, planFs: recorded.fs })
  const first = await collect(runner.stream({ prompt: 'write', mode: 'plan' }))
  const second = await collect(runner.stream({ prompt: 'no write', mode: 'plan' }))
  assert.equal(first.find(event => event.type === 'plan')?.plan, '# First\n\nthis run only')
  assert.equal(second.some(event => event.type === 'plan'), false)
  assert.equal(second.at(-1).result.result, 'ordinary answer')
  assert.notEqual(planDirectoryOf(calls[0]), planDirectoryOf(calls[1]))
  assert.equal(existsSync(stale), true)
  assertPlansClean(recorded)
  await runner.close()
})

const assistantTool = (id, name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const toolError = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] } })

test('real CLI native plan-write hard denials stop at the same budget without any control requests', async () => {
  for (const [name, verb] of [['Write', 'write to'], ['Edit', 'edit']]) {
    const recorded = recordingPlanFs()
    const { spawnImpl, calls } = controlSpawn(({ message, emit }) => {
      if (message.type !== 'user') return
      for (let index = 1; index <= 10; index += 1) {
        emit(assistantTool(`deny-${index}`, name, { file_path: '/outside/must-not-be-written.txt' }))
        emit(toolError(`deny-${index}`, `Cannot ${verb} /outside/must-not-be-written.txt while in plan mode.`))
      }
    })
    const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, spawnImpl, planFs: recorded.fs })
    await assert.rejects(collect(runner.stream({ prompt: 'plan only', mode: 'plan' })), /too many denied permission prompts/u)
    assert.equal(calls[0].frames.filter(frame => frame.type === 'control_response').length, 0)
    assert.equal(calls[0].killed, 'SIGTERM')
    assertPlansClean(recorded)
    await runner.close()
  }
})

test('ordinary Read/Bash/MCP execution errors never consume the plan permission budget', async () => {
  const { spawnImpl } = controlSpawn(({ message, emit }) => {
    if (message.type !== 'user') return
    const failures = [
      ['Read', 'File does not exist.'],
      ['Read', "EACCES: permission denied, open '/private/file'"],
      ['Bash', 'fatal: not a git repository'],
      ['Bash', 'Permission denied: ./script.sh'],
      ['mcp__geek2api_search_ab1234__web_search', 'Geek2API search failed on the selected backend.'],
      // Gate-like text returned by a read is still not a native write denial.
      ['Read', 'Cannot write to /outside/no while in plan mode.'],
    ]
    for (let index = 0; index < 24; index += 1) {
      const [name, text] = failures[index % failures.length]
      emit(assistantTool(`ordinary-${index}`, name))
      emit(toolError(`ordinary-${index}`, [{ type: 'text', text }]))
    }
    emit(toolError('unknown-tool', 'Cannot write to /outside/no while in plan mode.'))
    emit({ type: 'control_request', request_id: 'plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Still planning\n\nErrors are not permissions.' } } })
  })
  const runner = planRunner(spawnImpl)
  const events = await collect(runner.stream({ prompt: 'plan only', mode: 'plan' }))
  assert.equal(events.filter(event => event.type === 'tool-error').length, 25)
  assert.equal(events.find(event => event.type === 'plan')?.plan, '# Still planning\n\nErrors are not permissions.')
  await runner.close()
})

test('control denials and their repeated native tool_results count once per tool_use_id', async () => {
  const { spawnImpl, calls } = controlSpawn(({ message, emit, call }) => {
    const request = index => {
      emit(assistantTool(`tool-${index}`, 'Bash', { command: 'touch outside' }))
      emit({ type: 'control_request', request_id: `permission-${index}`, request: { subtype: 'can_use_tool', tool_use_id: `tool-${index}`, tool_name: 'Bash', input: { command: 'touch outside' } } })
    }
    if (message.type === 'user') { request(1); return }
    if (message.type !== 'control_response') return
    const index = Number(message.response.request_id.split('-').at(-1))
    if (call.responded?.has(index)) return
    call.responded ??= new Set()
    call.responded.add(index)
    const text = message.response.response.message
    emit(toolError(`tool-${index}`, text))
    emit(toolError(`tool-${index}`, text))
    // A transport replay is not another rejected action, either.
    emit({ type: 'control_request', request_id: `permission-${index}`, request: { subtype: 'can_use_tool', tool_use_id: `tool-${index}`, tool_name: 'Bash', input: { command: 'touch outside' } } })
    if (index < 8) request(index + 1)
    else emit({ type: 'control_request', request_id: 'plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Finished\n\nEight distinct denials.' } } })
  })
  const runner = planRunner(spawnImpl)
  const events = await collect(runner.stream({ prompt: 'plan only', mode: 'plan' }))
  assert.equal(events.find(event => event.type === 'plan')?.plan, '# Finished\n\nEight distinct denials.')
  assert.equal(calls[0].killed, 'SIGTERM')
  await runner.close()
})

test('ExitPlanMode reads only the private bound file and retains scrubbed bounded inline plans', async t => {
  const configDir = testDirectory(t)
  const shared = join(configDir, 'private-looking.md')
  writeFileSync(shared, '# Shared secret\n\nnot allowed')
  const token = 'sk-plan-dummy-key-never-exposed'
  const capability = 'dummy-private-mcp-capability'
  const bridge = bridgeStub()
  const recorded = recordingPlanFs()
  const { spawnImpl, calls } = controlSpawn(({ message, emit, call }) => {
    if (message.type === 'user') {
      emit({ type: 'control_request', request_id: 'outside', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { planFilePath: shared } } })
    } else if (message.type === 'control_response' && message.response.request_id === 'outside') {
      const file = join(planDirectoryOf(call), 'current.md')
      writeFileSync(file, `# Private\n\n${token} ${capability}`)
      emit({ type: 'control_request', request_id: 'inside', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { planFilePath: file } } })
    }
  })
  const runner = createClaudeRunner({
    binary: '/mock/claude', configDir, spawnImpl, planFs: recorded.fs,
    resolveCredential: async () => ({ baseUrl: 'https://cf.example', token }),
    createSearchBridge: async () => ({
      ...await bridge.factory(), redactionValues: () => [capability],
      scrub: text => text.split(capability).join('[redacted]'),
    }),
  })
  const events = await collect(runner.stream({ prompt: 'plan only', mode: 'plan' }))
  assert.equal(events.find(event => event.type === 'plan')?.plan, '# Private\n\n[redacted] [redacted]')
  assert.equal(calls[0].frames.filter(frame => frame.type === 'control_response').length, 1)
  assert.equal(readFileSync(shared, 'utf8'), '# Shared secret\n\nnot allowed')
  assertPlansClean(recorded)
  assert.equal(bridge.closes, 1)
  await runner.close()

  const inline = controlSpawn(({ message, emit }) => {
    if (message.type === 'user') emit({ type: 'control_request', request_id: 'oversize', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Inline\n\n' + 'x'.repeat(199_985) + token + 'y'.repeat(100) } } })
    if (message.type === 'control_response') emit({ type: 'control_request', request_id: 'short', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: `# Inline\n\n${token}` } } })
  })
  const inlineRunner = createClaudeRunner({ binary: '/mock/claude', spawnImpl: inline.spawnImpl, resolveCredential: async () => ({ baseUrl: 'https://cf.example', token }) })
  const value = await inlineRunner.run({ prompt: 'plan only', mode: 'plan' })
  const refusal = inline.calls[0].frames.find(frame => frame.type === 'control_response')
  assert.match(refusal.response.response.message, /200000-byte review limit/u)
  assert.equal(value.result, '# Inline\n\n[redacted]')
  await inlineRunner.close()
})

test('oversized file-only plans fail explicitly without returning a truncated review', async () => {
  const recorded = recordingPlanFs()
  const { spawnImpl } = controlSpawn(({ message, emit, call }) => {
    if (message.type !== 'user') return
    writeFileSync(join(planDirectoryOf(call), 'huge.md'), '# Too large\n\n' + 'x'.repeat(200_000))
    emit(PAYLOAD)
  })
  const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, spawnImpl, planFs: recorded.fs })
  await assert.rejects(collect(runner.stream({ prompt: 'plan only', mode: 'plan' })), /200000-byte review limit/u)
  assertPlansClean(recorded)
  await runner.close()
})

test('private plan directories stay inside the actual child cwd and preserve shared settings unchanged', async t => {
  const root = testDirectory(t)
  const cwd = join(root, 'project')
  const configDir = join(root, 'config')
  mkdirSync(cwd)
  mkdirSync(configDir)
  const settings = join(configDir, 'settings.json')
  const contents = JSON.stringify({
    permissions: { allow: ['ExitPlanMode'], deny: ['Bash(git push *)', 'Read(secret.txt)'] },
    allowedMcpServers: [{ serverName: 'existing' }],
  })
  writeFileSync(settings, contents)
  const recorded = recordingPlanFs()
  const { spawnImpl, calls } = stubSpawn()
  const runner = createClaudeRunner({ binary: '/mock/claude', resolveCredential: credential, configDir, spawnImpl, planFs: recorded.fs })
  await runner.run({ prompt: 'plan only', mode: 'plan', cwd })
  assert.equal(dirname(planDirectoryOf(calls[0])), realpathSync(cwd))
  assert.equal(calls[0].options.cwd, cwd)
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, configDir)
  assert.deepEqual(JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]), {
    plansDirectory: recorded.created[0], permissions: { ask: ['ExitPlanMode'] },
  })
  assert.equal(readFileSync(settings, 'utf8'), contents)
  assert.equal(calls[0].args.includes('--strict-mcp-config'), false)
  assert.equal(calls[0].args.includes('--setting-sources'), false)
  assert.deepEqual(readdirSync(cwd), [], 'no gitignore/project settings or plan resources survive')
  assertPlansClean(recorded)
  await runner.close()
})

test('an unwritable plan cwd fails before credentials/spawn and never falls back to a shared directory', async t => {
  const cwd = testDirectory(t)
  let keys = 0
  let spawns = 0
  const attempted = []
  const runner = createClaudeRunner({
    binary: '/mock/claude',
    resolveCredential: async () => { keys += 1; return credential() },
    spawnImpl: () => { spawns += 1; throw new Error('must not spawn') },
    planFs: {
      realpathSync, lstatSync,
      mkdtempSync: prefix => { attempted.push(prefix); throw Object.assign(new Error('read-only working directory'), { code: 'EACCES' }) },
      rmSync: () => { throw new Error('nothing owned to remove') },
    },
  })
  await assert.rejects(runner.run({ prompt: 'plan only', mode: 'plan', cwd }), /read-only working directory/u)
  assert.equal(keys, 0)
  assert.equal(spawns, 0)
  assert.equal(dirname(attempted[0]), realpathSync(cwd))
  assert.deepEqual(readdirSync(cwd), [])
  await runner.close()
})

test('private plan resources close on success, setup errors, bad exits and synchronous/asynchronous spawn/stdin failures', async () => {
  for (const variant of ['success', 'credential', 'binary', 'bridge', 'nonzero', 'invalid', 'sync-spawn', 'async-spawn', 'stdin']) {
    const recorded = recordingPlanFs()
    const bridge = bridgeStub()
    const { spawnImpl } = stubSpawn({
      code: variant === 'nonzero' ? 1 : 0,
      stdout: variant === 'invalid' ? 'not JSON\n' : `${JSON.stringify(PAYLOAD)}\n`,
      hang: ['async-spawn', 'stdin'].includes(variant),
    })
    const runner = createClaudeRunner({
      planFs: recorded.fs,
      binary: variant === 'binary' ? () => { throw new Error('binary setup failed') } : '/mock/claude',
      resolveCredential: variant === 'credential' ? async () => { throw new Error('credential setup failed') } : credential,
      createSearchBridge: variant === 'bridge' ? async () => { throw new Error('bridge setup failed') } : bridge.factory,
      spawnImpl: (...args) => {
        if (variant === 'sync-spawn') throw new Error('spawn failed')
        const child = spawnImpl(...args)
        if (variant === 'async-spawn') queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        if (variant === 'stdin') child.stdin.write = () => { throw new Error('input failed') }
        return child
      },
    })
    if (variant === 'success') await runner.run({ prompt: 'plan only', mode: 'plan' })
    else await assert.rejects(runner.run({ prompt: 'plan only', mode: 'plan' }))
    assert.equal(recorded.created.length, 1, variant)
    assertPlansClean(recorded)
    assert.equal(bridge.closes, ['credential', 'binary', 'bridge'].includes(variant) ? 0 : 1, variant)
    await runner.close()
  }
})

test('abort, timeouts, iterator.return and unload await private-plan cleanup as well as MCP revocation', async () => {
  for (const variant of ['abort', 'timeout', 'watchdog', 'unload', 'key-return', 'bridge-return']) {
    const recorded = recordingPlanFs()
    const bridge = bridgeStub()
    const { spawnImpl } = stubSpawn({ hang: true })
    const controller = new AbortController()
    let child
    let ready
    const spawned = new Promise(resolve => { ready = resolve })
    const runner = createClaudeRunner({
      binary: '/mock/claude', resolveCredential: credential, planFs: recorded.fs, createSearchBridge: bridge.factory,
      spawnImpl: (...args) => { child = spawnImpl(...args); ready(); return child },
      timeoutMs: variant === 'timeout' ? 20 : 1000,
      startupTimeoutMs: variant === 'watchdog' ? 20 : 1000,
    })
    const keepAlive = setInterval(() => {}, 1000)
    try {
      if (variant.endsWith('-return')) {
        for await (const event of runner.stream({ prompt: 'plan only', mode: 'plan' })) {
          if (event.type === (variant === 'key-return' ? 'key' : 'search-bridge')) break
        }
      } else {
        const pending = runner.run({ prompt: 'plan only', mode: 'plan', signal: controller.signal })
        pending.catch(() => undefined)
        await spawned
        if (variant === 'abort') controller.abort()
        if (variant === 'unload') await runner.close()
        await assert.rejects(pending)
      }
      assert.equal(child.signalCode, 'SIGTERM', variant)
      assert.equal(bridge.closes, 1, variant)
      assertPlansClean(recorded)
      await runner.close()
    } finally { clearInterval(keepAlive) }
  }
})

test('cancelled plan setup removes its directory before a late bridge factory settles', async () => {
  for (const phase of ['pre', 'credential', 'binary', 'bridge']) {
    const recorded = recordingPlanFs()
    const bridge = bridgeStub()
    const controller = new AbortController()
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    let release
    const blocked = new Promise(resolve => { release = resolve })
    let spawns = 0
    const runner = createClaudeRunner({
      planFs: recorded.fs,
      binary: phase === 'binary' ? async () => { entered(); await blocked; return '/mock/claude' } : '/mock/claude',
      resolveCredential: phase === 'credential' ? async () => { entered(); await blocked; return credential() } : credential,
      createSearchBridge: phase === 'bridge' ? async () => { entered(); await blocked; return bridge.factory() } : bridge.factory,
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn') },
    })
    if (phase === 'pre') controller.abort()
    const pending = runner.run({ prompt: 'plan only', mode: 'plan', signal: controller.signal })
    if (phase !== 'pre') { await ready; controller.abort() }
    await assert.rejects(pending, /aborted/u)
    assert.equal(recorded.created.length, phase === 'pre' ? 0 : 1)
    assertPlansClean(recorded)
    release()
    await runner.close()
    assert.equal(spawns, 0)
    if (phase === 'bridge') assert.equal(bridge.closes, 1)
  }
})

test('replaced directory identities are never recursively removed, even during cleanup', async () => {
  const recorded = recordingPlanFs()
  const originalLstat = recorded.fs.lstatSync
  let changed = false
  recorded.fs.lstatSync = path => {
    const info = originalLstat(path)
    if (changed && recorded.created.includes(path)) {
      const altered = Object.create(info)
      altered.ino = info.ino + 1
      return altered
    }
    return info
  }
  const { spawnImpl } = stubSpawn()
  const runner = createClaudeRunner({
    binary: '/mock/claude', resolveCredential: credential, planFs: recorded.fs,
    spawnImpl: (...args) => { changed = true; return spawnImpl(...args) },
  })
  try {
    await assert.rejects(runner.run({ prompt: 'plan only', mode: 'plan' }), /ownership changed; refusing/u)
    assert.equal(recorded.removed.length, 0)
    assert.equal(existsSync(recorded.created[0]), true)
    await runner.close()
  } finally {
    changed = false
    const path = recorded.created[0]
    assert.equal(realpathSync(path), path)
    assert.equal(originalLstat(path).isSymbolicLink(), false)
    recorded.fs.rmSync(path, { recursive: true, force: true })
  }
})

test('a bound root replaced by a symlink cannot authorize reading another directory', t => {
  const root = testDirectory(t)
  const planDirectory = join(root, 'private')
  const saved = join(root, 'saved-private')
  const outside = join(root, 'unrelated')
  mkdirSync(planDirectory)
  mkdirSync(outside)
  const secret = join(outside, 'secret.md')
  writeFileSync(secret, '# Never read\n\nnot this run')
  // Verify both exact owned move locations before simulating root replacement.
  assert.equal(realpathSync(planDirectory), planDirectory)
  assert.equal(dirname(planDirectory), root)
  assert.equal(dirname(saved), root)
  assert.equal(existsSync(saved), false)
  renameSync(planDirectory, saved)
  symlinkSync(outside, planDirectory)
  let reads = 0
  const options = { planDirectory, readFile: () => { reads += 1; return '# leaked' } }
  assert.equal(readSubmittedPlan({ planFilePath: join(planDirectory, 'secret.md') }, options), undefined)
  assert.equal(findPlanWrittenDuringRun(options), undefined)
  assert.equal(reads, 0)
})

test('private files cannot override CLI error results, absent results, or nonzero exits', async () => {
  for (const variant of ['error-result', 'absent-result', 'nonzero']) {
    const recorded = recordingPlanFs()
    const { spawnImpl } = stubSpawn({
      stdout: variant === 'absent-result' ? 'not a final result\n' : `${JSON.stringify({ ...PAYLOAD, is_error: variant === 'error-result', result: 'CLI failure' })}\n`,
      code: variant === 'nonzero' ? 2 : 0,
    })
    const runner = createClaudeRunner({
      binary: '/mock/claude', resolveCredential: credential, planFs: recorded.fs,
      spawnImpl: (...args) => {
        writeFileSync(join(planDirectoryOf({ args: args[1] }), 'current.md'), '# Not success\n\nThe CLI failed.')
        return spawnImpl(...args)
      },
    })
    const events = []
    await assert.rejects(async () => { for await (const event of runner.stream({ prompt: 'plan only', mode: 'plan' })) events.push(event) }, /failed|exited/u)
    assert.equal(events.some(event => ['plan', 'result'].includes(event.type)), false, variant)
    assertPlansClean(recorded)
    await runner.close()
  }
})

test('a verification failure after creating a private directory still cleans verified owned resources', async () => {
  const recorded = recordingPlanFs()
  let once = true
  recorded.fs.realpathSync = path => {
    if (recorded.created.includes(path) && once) {
      once = false
      throw Object.assign(new Error('transient verification failure'), { code: 'EIO' })
    }
    return realpathSync(path)
  }
  let spawns = 0
  const runner = createClaudeRunner({
    binary: '/mock/claude', resolveCredential: credential, planFs: recorded.fs,
    spawnImpl: () => { spawns += 1; throw new Error('must not spawn') },
  })
  await assert.rejects(runner.run({ prompt: 'plan only', mode: 'plan' }), /ownership could not be established/u)
  assert.equal(spawns, 0)
  assert.equal(recorded.created.length, 1)
  assertPlansClean(recorded)
  await runner.close()
})
