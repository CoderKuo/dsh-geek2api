import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDelegatedContent,
  CLI_BACKED_MODEL_IDS,
  CLI_IMAGE_LIMITS,
  createClaudeCliAdapter,
  delegationInstructions,
  renderDelegatedPrompt,
  TITLE_MODEL_ID,
  TITLE_MODEL_ROUTES,
} from '../src/claude-adapter.js'

/** The reasoning note every delegated turn opens with, before the CLI is up. */
const LAUNCH = '▸ 启动 Claude Code CLI…\n'
const LAUNCH_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: LAUNCH },
]

/** An inner adapter that records what it was asked for. */
function innerAdapter({ model = { id: 'gpt-6.1-sol' } } = {}) {
  const calls = []
  return {
    calls,
    providerInfo: provider => ({ id: provider, displayName: 'Geek2API' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 20, retryableCodes: [] }),
    listModels: async () => [model],
    resolveModel: async (_provider, id) => ({ ...model, id }),
    prepareCall: async (_provider, id) => {
      calls.push({ kind: 'inner-prepare', id })
      return { model: { ...model, id }, stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: 'inner' } })() }
    },
    stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: 'inner' } })(),
  }
}

/** A runner that replays a scripted event list. */
function stubRunner(events, { onCall } = {}) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      onCall?.(options)
      for (const event of events) yield event
    },
  }
}

async function consume(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('the Claude runtime decides per call whether a Claude model runs through the CLI', async () => {
  const inner = innerAdapter()
  const runner = stubRunner([{ type: 'text', text: 'cli' }, { type: 'result', result: { result: 'cli', inputTokens: 1, outputTokens: 2 } }])
  let runtime = 'http'
  const adapter = createClaudeCliAdapter({
    inner,
    runner,
    isCliModel: id => runtime === 'cli' && CLI_BACKED_MODEL_IDS.includes(id),
    resolveMode: () => 'edit',
    resolveCwd: () => '/work',
  })
  assert.deepEqual([...CLI_BACKED_MODEL_IDS], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
  assert.equal(TITLE_MODEL_ID, 'claude-haiku-4-5-20251001')

  const http = await adapter.prepareCall('geek2api', 'claude-opus-5-5')
  assert.deepEqual(await consume(http.stream({ model: 'claude-opus-5-5' })), [{ type: 'text-delta', index: 0, text: 'inner' }])
  assert.equal(runner.calls.length, 0, 'HTTP runtime keeps Claude on the pi-ai path')

  runtime = 'cli'
  await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  assert.equal(runner.calls.length, 1, 'the CLI runtime takes over without rebuilding the adapter')
  await consume(adapter.stream({ provider: 'geek2api', model: 'gpt-6.1-sol', messages: [] }))
  assert.equal(runner.calls.length, 1, 'other models never leave the pi-ai path')
})

test('only the CLI-backed ids leave the pi-ai path', async () => {
  const inner = innerAdapter()
  const runner = stubRunner([{ type: 'text', text: 'cli' }, { type: 'result', result: { result: 'cli', inputTokens: 1, outputTokens: 2 } }])
  const adapter = createClaudeCliAdapter({ inner, runner, modelIds: CLI_BACKED_MODEL_IDS, resolveMode: () => 'edit', resolveCwd: () => '/work' })

  const passthrough = await adapter.prepareCall('geek2api', 'gpt-6.1-sol')
  assert.deepEqual(await consume(passthrough.stream({ model: 'gpt-6.1-sol' })), [{ type: 'text-delta', index: 0, text: 'inner' }])
  assert.deepEqual(inner.calls, [{ kind: 'inner-prepare', id: 'gpt-6.1-sol' }])
  assert.equal(runner.calls.length, 0)

  const delegated = await adapter.prepareCall('geek2api', 'claude-opus-5-5')
  assert.equal(delegated.model.id, 'claude-opus-5-5')
  assert.equal(runner.calls.length, 0, 'the CLI starts only when the stream is consumed')
  await consume(delegated.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].mode, 'edit')
  assert.equal(runner.calls[0].cwd, '/work')
  assert.equal(runner.calls[0].model, 'claude-opus-5-5')
})

test('a delegated turn streams the CLI text and finishes clean', async () => {
  const runner = stubRunner([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'result', result: { result: 'Hello', inputTokens: 3, outputTokens: 4 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'read-only' })
  const chunks = await consume(adapter.stream({
    provider: 'geek2api',
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.deepEqual(chunks, [
    ...LAUNCH_CHUNKS,
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: LAUNCH } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Hel' },
    { type: 'text-delta', index: 1, text: 'lo' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('thinking and tool activity stream live as reasoning, the answer as text', async () => {
  const runner = stubRunner([
    { type: 'block', kind: 'reasoning' },
    { type: 'reasoning', text: '先看仓库' },
    { type: 'tool', id: 't1', summary: 'Bash · git status' },
    { type: 'tool', id: 't1', summary: 'Bash · git status' },
    { type: 'tool-error', id: 't1', text: 'not a git repository' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '第一段' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '第二段' },
    { type: 'result', result: { result: '', inputTokens: 0, outputTokens: 9 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  const ends = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(ends, [
    { type: 'reasoning', text: LAUNCH },
    { type: 'reasoning', text: '先看仓库\n▸ Bash · git status\n  ✗ not a git repository\n' },
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])
  // Every delta addresses an open block of its own type.
  const open = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType)
    if (chunk.type === 'block-end') open.delete(chunk.index)
    if (chunk.type === 'text-delta') assert.equal(open.get(chunk.index), 'text')
    if (chunk.type === 'reasoning-delta') assert.equal(open.get(chunk.index), 'reasoning')
  }
  assert.equal(open.size, 0)
})

test('usage reports the last request as context and keeps cache hits', async () => {
  const runner = stubRunner([
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 29_246, cacheWriteTokens: 13_634 } },
    { type: 'text', text: 'a' },
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 43_323, cacheWriteTokens: 385 } },
    { type: 'result', result: { result: 'a', inputTokens: 4, outputTokens: 357, cacheReadTokens: 72_569, cacheWriteTokens: 14_019 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 2,
    outputTokens: 357,
    cacheReadTokens: 43_323,
    cacheWriteTokens: 385,
  })
})

test('usage falls back to the CLI totals when no request was observed', async () => {
  const runner = stubRunner([
    { type: 'result', result: { result: '', inputTokens: 4, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 4,
    outputTokens: 5,
    cacheReadTokens: 6,
    cacheWriteTokens: 7,
  })
})

test('a delegated turn reports a CLI failure without blaming a key', async () => {
  const runner = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('Claude Code CLI failed: Failed to authenticate. API Error: 401 无效的令牌')
    },
  }
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  assert.deepEqual(chunks.slice(0, -1), [...LAUNCH_CHUNKS, { type: 'block-end', index: 0, block: { type: 'reasoning', text: LAUNCH } }])
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
  assert.match(finish.reason.failure.message, /401 无效的令牌/u)
})

/** The reasoning text a turn's chunks carry. */
const reasoningOf = chunks => chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')

test('every CLI turn names the key it used, and a key passed over for its groups is said so', async () => {
  const plain = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner: stubRunner([{ type: 'key', label: 'cc', model: 'claude-opus-5-5', groups: ['cc'] }, { type: 'result', result: { result: '', inputTokens: 0, outputTokens: 0 } }]),
  })
  assert.match(reasoningOf(await consume(plain.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))), /▸ 使用 Key「cc」（分组：cc）/u)

  const switched = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner: stubRunner([{ type: 'key', label: 'cc', switchedFrom: 'no-cc', model: 'claude-opus-5-5', groups: ['cc'] }, { type: 'result', result: { result: '', inputTokens: 0, outputTokens: 0 } }]),
  })
  assert.match(reasoningOf(await consume(switched.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))), /当前 Key「no-cc」的分组不能用 claude-opus-5-5，本轮改用 Key「cc」/u)

  const uncovered = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner: stubRunner([{ type: 'key', label: 'no-cc', uncovered: true, model: 'claude-opus-5-5', required: ['cc', 'cc-sale'] }, { type: 'result', result: { result: '', inputTokens: 0, outputTokens: 0 } }]),
  })
  assert.match(reasoningOf(await consume(uncovered.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))), /已存的 Key 都没有能用 claude-opus-5-5 的分组（需要 cc \/ cc-sale）/u)
})

test('an official-CLI refusal from a key without a Claude group blames the key, not the CLI', async () => {
  const refusal = 'Claude Code CLI failed: Failed to authenticate. API Error: 403 {"error":{"type":"geek2api_<nil>","message":"Request blocked: this endpoint only accepts requests from the official Claude Code CLI. (request id: r1)"}}'
  const runnerWith = key => ({
    async *stream() {
      yield { type: 'key', ...key }
      throw new Error(refusal)
    },
  })
  const failureOf = async key => {
    const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner: runnerWith(key) })
    return (await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1).reason.failure.message
  }
  const byGroup = await failureOf({ label: 'no-cc', model: 'claude-opus-5-5', groups: ['codex', 'deepseek-officially'], required: ['cc', 'cc-sale'], covers: false })
  assert.match(byGroup, /Key「no-cc」所在分组（codex、deepseek-officially）不包含能用 claude-opus-5-5 的分组（cc \/ cc-sale）/u)
  assert.match(byGroup, /不需要更新 CLI/u)
  assert.doesNotMatch(byGroup, /\b403\b/u)
  assert.match(byGroup, /request id: r1/u)

  // The other way Geek2API refuses such a key: a routing miss, not a client check.
  const routingMiss = async () => {
    const adapter = createClaudeCliAdapter({
      inner: innerAdapter(),
      runner: {
        async *stream() {
          yield { type: 'key', label: 'no-cc', model: 'claude-opus-5-5', groups: ['codex'], required: ['cc'], covers: false }
          throw new Error("Claude Code CLI failed: API Error: 400 Model 'claude-opus-5-5' is not available. Use GET /v1/models to see supported models. (request id: r2)")
        },
      },
    })
    return (await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1).reason.failure.message
  }
  const miss = await routingMiss()
  assert.match(miss, /Key「no-cc」所在分组（codex）不包含能用 claude-opus-5-5 的分组（cc）/u)
  assert.doesNotMatch(miss, /\b400\b/u)

  // Geek2API's own routing miss names no groups: a run whose key was never
  // read says so, and still blames the key rather than the CLI.
  const unknownAdapter = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner: {
      async *stream() {
        yield { type: 'key', id: 'k1', label: 'fresh', model: 'claude-opus-5-5' }
        throw new Error("Claude Code CLI failed: API Error: 400 {\"error\":{\"message\":\"Model 'claude-opus-5-5' is not available. Use GET /v1/models to see supported models.\"}}")
      },
    },
  })
  const fromText = (await consume(unknownAdapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1).reason.failure.message
  assert.match(fromText, /Key「fresh」所在分组（未读到）不包含能用 claude-opus-5-5 的分组（Claude 分组）/u)
  assert.match(fromText, /不需要更新 CLI/u)

  // The 403 wording names no groups: a fresh reading decides.
  const asked = []
  const refreshed = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner: runnerWith({ id: 'k1', label: 'fresh', model: 'claude-opus-5-5' }),
    explainKey: async key => {
      asked.push(key.id)
      return { ...key, groups: ['codex'], required: ['cc'], covers: false }
    },
  })
  const byReading = (await consume(refreshed.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1).reason.failure.message
  assert.deepEqual(asked, ['k1'])
  assert.match(byReading, /Key「fresh」所在分组（codex）不包含能用 claude-opus-5-5 的分组（cc）/u)

  // A key whose groups do cover Claude: the CLI explanation stands, naming the key.
  const byClient = await failureOf({ label: 'cc', model: 'claude-opus-5-5', groups: ['cc'], covers: true })
  assert.match(byClient, /认为它不是官方 Claude Code CLI 发出的/u)
  assert.match(byClient, /本轮使用 Key「cc」，分组：cc/u)
})

test('the request signal reaches the CLI so a cancelled turn kills it', async () => {
  const runner = stubRunner([{ type: 'result', result: { result: 'x', inputTokens: 0, outputTokens: 0 } }])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const controller = new AbortController()
  await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [], signal: controller.signal }))
  assert.equal(runner.calls[0].signal, controller.signal)
})

test('a session title runs on the small model, read-only, outside the workspace', async () => {
  const runner = stubRunner([{ type: 'text', text: '修复登录' }, { type: 'result', result: { result: '修复登录', inputTokens: 1, outputTokens: 2 } }])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'full', resolveCwd: () => '/work' })
  const chunks = await consume(adapter.stream({
    provider: 'geek2api',
    model: 'claude-opus-5-5',
    purpose: 'session-title',
    system: 'Return only the title.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '登录页报错了' }] }],
  }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // A title is read back as text: no progress notes in it.
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false)
  assert.equal(runner.calls.length, 1)
  const call = runner.calls[0]
  assert.equal(call.model, TITLE_MODEL_ID)
  assert.equal(call.mode, 'read-only')
  assert.equal(call.enableSearch, false, 'titles allocate no MCP server or search approval')
  assert.notEqual(call.cwd, '/work')
  assert.equal(call.appendSystemPrompt, 'Return only the title.')
  assert.equal(call.prompt, '登录页报错了')
})

test('a submitted plan becomes one exit_plan_mode call and not assistant text', async () => {
  const runner = stubRunner([
    { type: 'reasoning', text: 'looked around' },
    { type: 'plan', plan: '# Ship\n\nDo it.' },
    { type: 'result', result: { result: '# Ship\n\nDo it.', inputTokens: 2, outputTokens: 3, mode: 'plan' } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'plan', resolveCwd: () => '/work' })
  const chunks = await consume(adapter.stream({
    provider: 'geek2api',
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plan the change' }] }],
    tools: [{ name: 'exit_plan_mode' }],
  }))
  const tool = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(tool.block.name, 'exit_plan_mode')
  assert.equal(JSON.parse(tool.block.arguments).plan, '# Ship\n\nDo it.')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  assert.match(runner.calls[0].appendSystemPrompt, /ExitPlanMode/u)
  assert.equal(runner.calls[0].appendSystemPrompt.includes('直接输出最终结果'), false)
  assert.equal(runner.calls[0].mode, 'plan')
})

test('a session title stays read-only while the session is in plan mode', async () => {
  const runner = stubRunner([{ type: 'result', result: { result: 'title', inputTokens: 1, outputTokens: 1 } }])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'plan', resolveCwd: () => '/work' })
  await consume(adapter.stream({
    provider: 'geek2api',
    model: 'claude-opus-5-5',
    purpose: 'session-title',
    system: 'Return only the title.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '登录页报错了' }] }],
  }))
  assert.equal(runner.calls[0].mode, 'read-only')
  assert.equal(runner.calls[0].appendSystemPrompt, 'Return only the title.')
})

test('every CLI-backed model is routed to the CLI with its own id', async () => {
  for (const id of CLI_BACKED_MODEL_IDS) {
    const runner = stubRunner([{ type: 'result', result: { result: '', inputTokens: 0, outputTokens: 0 } }])
    const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
    await consume(adapter.stream({ provider: 'geek2api', model: id, messages: [] }))
    assert.equal(runner.calls[0].model, id)
  }
})

test('a delegated prompt drops the harness system prompt and marks what it cannot carry', () => {
  const request = {
    system: '补充：回答用中文',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'DSH 系统提示：你有 bash 工具……' }] },
      { role: 'user', content: [{ type: 'text', text: '看看这个文件' }, { type: 'image', source: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', name: 'read' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 't', content: [{ type: 'text', text: '文件内容 abc' }] }] },
    ],
  }
  const prompt = renderDelegatedPrompt(request)
  // The CLI has its own system prompt and its own tools.
  assert.equal(prompt.includes('DSH 系统提示'), false)
  assert.match(prompt, /用户：看看这个文件/u)
  assert.match(prompt, /\[图片\]/u)
  assert.match(prompt, /\[调用工具 read\]/u)
  assert.match(prompt, /助手：好/u)
  // A structured tool result keeps its text.
  assert.match(prompt, /\[工具结果\]\n文件内容 abc/u)
  // The delegation itself travels as appended system instructions.
  const instructions = delegationInstructions(request, '/work/repo')
  assert.match(instructions, /委派给 Claude Code/u)
  assert.match(instructions, /工作目录：\/work\/repo/u)
  assert.match(instructions, /补充：回答用中文/u)
  assert.equal(prompt.includes('工作目录'), false)
  const planning = delegationInstructions(request, '/work/repo', { plan: true })
  assert.match(planning, /ExitPlanMode/u)
  assert.equal(planning.includes('直接输出最终结果'), false)
})

test('a long conversation is trimmed to its most recent turns', () => {
  const messages = []
  for (let i = 0; i < 200; i += 1) messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 轮 ` + 'x'.repeat(500) }] })
  const prompt = renderDelegatedPrompt({ messages }, '/work')
  assert.ok(prompt.length < 52_000, `prompt length ${prompt.length}`)
  assert.match(prompt, /较早对话已截断/u)
  assert.match(prompt, /第 199 轮/u)
  assert.equal(prompt.includes('第 0 轮'), false)
})

/** An attachment store with two images and one file, recording its reads. */
function fakeAttachments({ failId } = {}) {
  const reads = []
  return {
    reads,
    imageHostPath: ref => `/home/u/.dsh/attachments/${ref.attachmentId.slice(7, 9)}/${ref.attachmentId.slice(7)}`,
    fileHostPath: ref => `/home/u/.dsh/files/${ref.name}`,
    async readImageRequest(ref, policy) {
      reads.push({ id: ref.attachmentId, policy })
      if (ref.attachmentId === failId) throw new Error('integrity check failed')
      return { data: new Uint8Array(ref.bytes), mediaType: 'image/png', width: 64, height: 32, bytes: ref.bytes }
    },
  }
}

const imageRef = (hex, bytes = 30, name) => ({
  attachmentId: `sha256:${hex.repeat(64 / hex.length)}`,
  mediaType: 'image/jpeg',
  bytes,
  width: 640,
  height: 320,
  ...(name === undefined ? {} : { name }),
})

test('a delegated turn sends its images as image blocks, in place, with their read-only copies', async () => {
  const attachments = fakeAttachments()
  const first = imageRef('a1', 30, 'shot.png')
  const second = imageRef('b2', 60)
  const content = await buildDelegatedContent({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看第一张' }, { type: 'image', attachment: first }] },
      { role: 'assistant', content: [{ type: 'text', text: '红色方块' }] },
      { role: 'user', content: [{ type: 'image', attachment: second }, { type: 'text', text: '和这张比呢' }, { type: 'file', attachment: { attachmentId: 'sha256:ff', name: 'notes.md', bytes: 5 } }] },
    ],
  }, { attachments })
  assert.deepEqual(content.map(block => block.type), ['text', 'image', 'text', 'image', 'text'])
  assert.match(content[0].text, /^用户：看第一张\n\[图片 shot\.png（64x32px）；只读副本：\/home\/u\/\.dsh\/attachments\/a1\/a1a1/u)
  assert.deepEqual(content[1].source, { type: 'base64', media_type: 'image/png', data: Buffer.from(new Uint8Array(30)).toString('base64') })
  assert.match(content[2].text, /助手：红色方块\n\n用户：\[图片 b2b2b2b2（64x32px）/u)
  assert.match(content[4].text, /和这张比呢\n\[文件 notes\.md；只读副本：\/home\/u\/\.dsh\/files\/notes\.md\]/u)
  // Each image is read as the same request version the HTTP route sends.
  assert.deepEqual(attachments.reads[0].policy, { maxPixels: CLI_IMAGE_LIMITS.maxPixels, maxBytes: CLI_IMAGE_LIMITS.maxBytesPerImage })
})

test('the oldest images give way to the bounds, and an unreadable one is described instead', async () => {
  const attachments = fakeAttachments({ failId: imageRef('c3').attachmentId })
  const content = await buildDelegatedContent({
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: imageRef('a1', 30) }, { type: 'text', text: '旧图' }] },
      { role: 'user', content: [{ type: 'image', attachment: imageRef('b2', 30) }, { type: 'image', attachment: imageRef('c3', 30) }, { type: 'text', text: '新图' }] },
    ],
  }, { attachments, limits: { ...CLI_IMAGE_LIMITS, maxImages: 1 } })
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.equal(content.filter(block => block.type === 'image').length, 1)
  assert.match(text, /\[图片 a1a1a1a1：超出本回合的图片上限，未随消息附上，需要时请用 Read 工具读取；只读副本：/u)
  assert.match(text, /\[图片 c3c3c3c3：读取失败，未随消息附上/u)
  assert.match(text, /\[图片 b2b2b2b2（64x32px）/u)
})

test('without an attachment store the images are named, not dropped silently', async () => {
  const content = await buildDelegatedContent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: imageRef('a1') }] }],
  }, { attachments: undefined })
  assert.deepEqual(content, [{ type: 'text', text: '用户：看图\n[图片 a1a1a1a1：当前运行环境无法读取附件]' }])
})

test('the adapter hands the CLI content blocks, the delegation instructions, and the store it was given', async () => {
  const runner = stubRunner([{ type: 'result', result: { result: 'ok', inputTokens: 0, outputTokens: 0 } }])
  const attachments = fakeAttachments()
  const adapter = createClaudeCliAdapter({
    inner: innerAdapter(),
    runner,
    resolveMode: () => 'edit',
    resolveCwd: () => '/work',
    resolveAttachments: () => attachments,
  })
  await consume(adapter.stream({
    provider: 'geek2api',
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', attachment: imageRef('a1') }] }],
  }))
  const call = runner.calls[0]
  assert.equal(call.prompt, undefined)
  assert.deepEqual(call.content.map(block => block.type), ['text', 'image'])
  assert.match(call.appendSystemPrompt, /委派给 Claude Code/u)
  assert.match(call.appendSystemPrompt, /工作目录：\/work/u)
})

test('the CLI starting and its own retries show up live in the reasoning block', async () => {
  const runner = stubRunner([
    { type: 'started', version: '2.1.295', model: 'claude-sonnet-5-5' },
    { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 1240, status: 503, error: 'server_error' },
    { type: 'retry', attempt: 2, maxRetries: 10, delayMs: 2500, status: 429, error: '' },
    { type: 'text', text: '好了' },
    { type: 'result', result: { result: '好了', inputTokens: 0, outputTokens: 1 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))
  const reasoning = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning').block.text
  assert.equal(reasoning, [
    LAUNCH,
    '▸ Claude Code CLI 已启动（2.1.295 · claude-sonnet-5-5）\n',
    '  ↻ 网关返回 HTTP 503（server_error），CLI 自动重试 1/10，1.2 秒后\n',
    '  ↻ 网关返回 HTTP 429，CLI 自动重试 2/10，2.5 秒后\n',
  ].join(''))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

/** A runner that reports some retries and then fails with `message`. */
function failingRunner(message, retries = 0) {
  return {
    async *stream() {
      for (let attempt = 1; attempt <= retries; attempt += 1) yield { type: 'retry', attempt, maxRetries: 10, status: 503 }
      throw new Error(message)
    },
  }
}

test('a busy gateway is named as such once the CLI has given up retrying', async () => {
  const raw = 'Claude Code CLI failed: API Error: 503 {"error":{"type":"geek2api_concurrency_queue_full","message":"账号并发排队已满，请稍后重试。(Per-account wait queues are full. Please retry shortly.) (request id: 01M4QQ)"},"type":"geek2api_error"}'
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner: failingRunner(raw, 10) })
  const finish = (await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1)
  assert.equal(finish.reason.failure.code, 'PI_AI_ERROR')
  assert.match(finish.reason.failure.message, /Claude 上游暂时繁忙/u)
  assert.match(finish.reason.failure.message, /已自动重试 10 次/u)
  assert.match(finish.reason.failure.message, /geek2api_concurrency_queue_full/u)
  assert.match(finish.reason.failure.message, /request id: 01M4QQ/u)
})

test('a client-policy refusal of the CLI keeps the gateway words but drops the auth status', async () => {
  const raw = 'Claude Code CLI failed: Failed to authenticate. API Error: 403 {"error":{"type":"geek2api_<nil>","message":"Request blocked: this endpoint only accepts requests from the official Claude Code CLI. (request id: 01M4QNSF)"}}'
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner: failingRunner(raw) })
  const message = (await consume(adapter.stream({ provider: 'geek2api', model: 'claude-opus-5-5', messages: [] }))).at(-1).reason.failure.message
  assert.match(message, /不是 API Key 失效/u)
  assert.match(message, /request id: 01M4QNSF/u)
  assert.equal(/\b403\b/u.test(message), false)
})

/** An inner adapter that records which model each prepared call and dispatch used. */
function routingInner() {
  const seen = []
  const streamFor = prepared => options => (async function* () {
    seen.push({ prepared, dispatched: options.model, purpose: options.purpose })
    yield { type: 'text-delta', index: 0, text: `from ${options.model}` }
  })()
  return {
    seen,
    providerInfo: provider => ({ id: provider }),
    listModels: async () => [],
    resolveModel: async (_provider, id) => ({ id }),
    prepareCall: async (_provider, id) => ({ model: { id }, stream: streamFor(id) }),
    stream: options => streamFor('unprepared')(options),
  }
}

test('a gpt-6-astra session title runs on gpt-6.1-sol; its turns stay on Astra', async () => {
  assert.deepEqual({ ...TITLE_MODEL_ROUTES }, { 'gpt-6-astra': 'gpt-6.1-sol' })
  const inner = routingInner()
  const adapter = createClaudeCliAdapter({ inner, runner: stubRunner([]) })

  // The prepared path, which the LLM service uses: the model shown stays Astra.
  const prepared = await adapter.prepareCall('geek2api', 'gpt-6-astra')
  assert.equal(prepared.model.id, 'gpt-6-astra')
  const title = await consume(prepared.stream({ provider: 'geek2api', model: 'gpt-6-astra', purpose: 'session-title', messages: [] }))
  assert.deepEqual(title, [{ type: 'text-delta', index: 0, text: 'from gpt-6.1-sol' }])
  assert.deepEqual(inner.seen.at(-1), { prepared: 'gpt-6.1-sol', dispatched: 'gpt-6.1-sol', purpose: 'session-title' })

  const turn = await adapter.prepareCall('geek2api', 'gpt-6-astra')
  await consume(turn.stream({ provider: 'geek2api', model: 'gpt-6-astra', messages: [] }))
  assert.deepEqual(inner.seen.at(-1), { prepared: 'gpt-6-astra', dispatched: 'gpt-6-astra', purpose: undefined })

  // The direct path reroutes the same way.
  await consume(adapter.stream({ provider: 'geek2api', model: 'gpt-6-astra', purpose: 'session-title', messages: [] }))
  assert.deepEqual(inner.seen.at(-1), { prepared: 'gpt-6.1-sol', dispatched: 'gpt-6.1-sol', purpose: 'session-title' })
})

test('models without a title route keep titling themselves', async () => {
  const inner = routingInner()
  const adapter = createClaudeCliAdapter({ inner, runner: stubRunner([]) })
  for (const model of ['gpt-6.1-sol', 'deepseek-v4.1-flash']) {
    const prepared = await adapter.prepareCall('geek2api', model)
    await consume(prepared.stream({ provider: 'geek2api', model, purpose: 'session-title', messages: [] }))
    assert.deepEqual(inner.seen.at(-1), { prepared: model, dispatched: model, purpose: 'session-title' })
  }
})

const planCall = (plan, id = 'plan-review', extra = {}) => ({ type: 'tool-call', id, name: 'exit_plan_mode', arguments: JSON.stringify({ plan, ...extra }) })
const reviewResult = (text, id = 'plan-review', isError = false) => ({ type: 'tool-result', toolCallId: id, isError, content: [{ type: 'text', text }] })

const planAdapter = plan => createClaudeCliAdapter({
  inner: innerAdapter(),
  runner: stubRunner([{ type: 'plan', plan }, { type: 'result', result: { result: plan, inputTokens: 1, outputTokens: 2 } }]),
  resolveMode: () => 'plan',
})

test('plan review chooses the current request catalog, including PTC and both modes', async () => {
  for (const [tools, expected] of [
    [[{ name: 'exit_plan_mode' }], 'exit_plan_mode'],
    [[{ name: 'run_code' }], 'run_code'],
    [[{ name: 'exit_plan_mode' }, { name: 'run_code' }], 'exit_plan_mode'],
  ]) {
    const plan = '# Review\n\nDo not publish or reveal credentials.'
    const chunks = await consume(planAdapter(plan).stream({ model: 'claude-opus-5-5', messages: [], tools }))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    assert.equal(call.name, expected)
    const args = JSON.parse(call.arguments)
    if (expected === 'run_code') {
      assert.equal(args.code, `return await tools.exit_plan_mode(${JSON.stringify({ plan })})`)
      assert.equal(args.description, 'Present completed plan for user review')
      assert.deepEqual(Object.keys(args).sort(), ['code', 'description'])
    } else assert.deepEqual(args, { plan })
  }
})

test('missing review capabilities fail closed without an unknown native tool call', async () => {
  const empty = await consume(planAdapter(' \n ').stream({ model: 'claude-opus-5-5', messages: [], tools: [{ name: 'exit_plan_mode' }] }))
  assert.equal(empty.some(chunk => chunk.block?.type === 'tool-call'), false)
  assert.match(empty.at(-1).reason.failure.message, /empty plan/u)
  for (const tools of [undefined, [], [{ name: 'read' }]]) {
    const chunks = await consume(planAdapter('# Review\n\nNo implementation yet.').stream({ model: 'claude-opus-5-5', messages: [], tools }))
    assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /neither exit_plan_mode nor run_code/u)
  }
})

test('durable plans and review feedback bypass the general 8k block cap, not the 48k prompt budget', async () => {
  const plan = '# Safe implementation\n\n' + 'p'.repeat(9_000) + '\nNever commit, publish, or discard user changes.'
  const feedback = 'The user chose to keep planning; their feedback: ' + 'f'.repeat(9_000) + '\nAdd a migration rollback.'
  const messages = [
    { role: 'assistant', content: [planCall(plan, 'plan-review', { apiKey: 'SECRET-PLAN-METADATA' })] },
    { role: 'user', content: [reviewResult(feedback, 'plan-review', true)] },
    ...Array.from({ length: 90 }, () => ({ role: 'user', content: [{ type: 'text', text: 'noise'.repeat(300) }] })),
    { role: 'assistant', content: [{ type: 'tool-call', name: 'credential_tool', arguments: JSON.stringify({ token: 'SECRET-UNRELATED-TOOL' }) }] },
    { role: 'user', content: [{ type: 'text', text: 'Revise the draft, keeping all original constraints.' }] },
  ]
  const prompt = renderDelegatedPrompt(JSON.parse(JSON.stringify({ messages })))
  assert.ok(prompt.includes(plan), 'all original plan constraints survive a fork/resume-shaped serialization and old-turn trimming')
  assert.ok(prompt.includes(feedback), 'review feedback is carried whole')
  assert.match(prompt, /Revise the draft/u)
  assert.match(prompt, /未批准\/失败/u)
  assert.doesNotMatch(prompt, /SECRET-/u)
  assert.match(prompt, /较早对话已截断/u)
  assert.ok(prompt.length < 48_100)
  const content = await buildDelegatedContent({ messages })
  assert.ok(content.map(block => block.text ?? '').join('').includes(plan))
})

test('only the exact persisted PTC plan-review program is decoded; arbitrary programs and tool secrets stay private', () => {
  const plan = '# PTC review\n\nKeep user data intact.'
  const safe = { type: 'tool-call', id: 'ptc-review', name: 'run_code', arguments: JSON.stringify({ code: `return await tools.exit_plan_mode(${JSON.stringify({ plan })})`, description: 'Review' }) }
  const request = { messages: [
    { role: 'assistant', content: [safe] },
    { role: 'user', content: [reviewResult('{"approved":true}', 'ptc-review')] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'run_code', arguments: JSON.stringify({ code: `return await tools.exit_plan_mode(${JSON.stringify({ plan: 'SECRET-OTHER-PROGRAM', token: 'SECRET-TOKEN' })})` }) }] },
    { role: 'user', content: [{ type: 'text', text: 'Proceed with the approved plan.' }] },
  ] }
  const prompt = renderDelegatedPrompt(request)
  assert.ok(prompt.includes(plan))
  assert.match(prompt, /"approved":true/u)
  assert.doesNotMatch(prompt, /SECRET-/u)
  assert.equal(renderDelegatedPrompt({ messages: [{ role: 'assistant', content: [{ ...safe, arguments: JSON.stringify({ code: `return await tools.exit_plan_mode({"plan":"SECRET-EXTRA-STATEMENT"}); evil()` }) }] }] }).includes('SECRET-'), false)
})

test('the latest revised plan supersedes an older draft when recent chat is trimmed', () => {
  const revised = '# Revised\n\nNo production writes; use a staging fixture.'
  const prompt = renderDelegatedPrompt({ messages: [
    { role: 'assistant', content: [planCall('# Obsolete\n\nOLD-DRAFT', 'old')] },
    { role: 'user', content: [reviewResult('Keep planning', 'old', true)] },
    { role: 'assistant', content: [planCall(revised, 'new')] },
    { role: 'user', content: [reviewResult('Plan approved', 'new')] },
    ...Array.from({ length: 60 }, () => ({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000) }] })),
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ] })
  assert.ok(prompt.includes(revised))
  assert.match(prompt, /Plan approved/u)
  assert.doesNotMatch(prompt, /OLD-DRAFT/u)
})

test('oversize plans fail before review, and oversize durable context fails before spawning a new CLI', async () => {
  const huge = '# Oversize\n\n' + 'x'.repeat(48_000)
  const emitted = await consume(planAdapter(huge).stream({ model: 'claude-opus-5-5', messages: [], tools: [{ name: 'run_code' }] }))
  assert.equal(emitted.some(chunk => chunk.block?.type === 'tool-call'), false)
  assert.match(emitted.at(-1).reason.failure.message, /48,000.*before review/u)
  const runner = stubRunner([])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const options = { model: 'claude-opus-5-5', messages: [
    { role: 'assistant', content: [planCall('# Approved\n\n' + 'x'.repeat(40_000))] },
    { role: 'user', content: [reviewResult('Plan approved')] },
    { role: 'user', content: [{ type: 'text', text: 'Keep this additional constraint: ' + 'y'.repeat(9_000) }] },
  ] }
  assert.throws(() => renderDelegatedPrompt(options), /48,000.*not truncated/u)
  const chunks = await consume(adapter.stream(options))
  assert.equal(runner.calls.length, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /48,000.*not truncated/u)
})

test('ordinary tool results keep their existing 8k cap', () => {
  const prompt = renderDelegatedPrompt({ messages: [{ role: 'user', content: [reviewResult('x'.repeat(8_000) + 'TRUNCATE-ME', 'ordinary-tool')] }] })
  assert.equal(prompt.includes('TRUNCATE-ME'), false)
  assert.equal(prompt.includes('x'.repeat(8_000)), true)
})
