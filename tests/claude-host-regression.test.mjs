import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'

import { createClaudeCliAdapter } from '../src/claude-adapter.js'
import { createClaudeCodeTool } from '../src/claude-tool.js'
import { planModeForSession, planModeForToolExecution } from '../src/permission.js'

const APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Use the shipped ToolRuntime, including its real catalog collapse, run_code
 * bridge, nested dispatch, schema validation, and durable PTC logs. Only the
 * program substrate and user review are deterministic in-process fixtures;
 * neither native nor PTC tool dispatch is stubbed.
 */
function host(mode, choices = [{ approved: true }]) {
  const ctx = new Context()
  const events = []
  const state = { active: true }
  const session = {
    id: `host-${mode}`,
    header: { cwd: '/test-workspace' },
    append(type, data) { events.push({ type, data }); return { seq: events.length } },
  }
  const agent = { session }
  const reviews = []
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  ctx.provide('codeRuntime', {
    language: 'typescript',
    async run({ program, bindings, signal }) {
      assert.equal(bindings.length, 1)
      assert.equal(bindings[0].global, 'tools', 'use the actual host binding namespace')
      signal.throwIfAborted()
      try {
        const value = await new AsyncFunction('tools', program)(bindings[0].functions)
        return { logs: [], value }
      } catch (error) {
        return { logs: [], error: { kind: 'program', message: error.message } }
      }
    },
  })
  ctx.provide('planMode', { get: target => {
    assert.equal(target.session, session)
    return { ...state }
  } })
  ctx.provide('agents', { currentInitiator: () => agent })
  ctx.provide('sessionProjections', { stateOf: target => (target === session ? { active: state.active } : undefined) })
  const tools = new ToolRuntime(ctx, { mode })
  tools.register(defineTool({
    name: 'exit_plan_mode',
    description: 'Present the completed plan for user review.',
    parameters: { plan: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { approved: { type: 'boolean', const: true, required: true } } },
      render: () => [{ type: 'text', text: APPROVED }],
    },
    async execute(args, exec) {
      assert.equal(exec.agent, agent)
      assert.equal(state.active, true, 'review requires logged plan mode')
      reviews.push(args.plan)
      const choice = choices.shift()
      assert.ok(choice, 'a scripted user review exists')
      if (!choice.approved) throw new Error(`The user chose to keep planning; their feedback: ${choice.feedback}`)
      state.pending = false
      return { approved: true }
    },
  }))
  const signal = new AbortController().signal
  return {
    ctx, tools, session, agent, state, reviews, events,
    execute: block => tools.execute({ callId: block.id, name: block.name, arguments: JSON.parse(block.arguments), agent, signal }),
    boundary() {
      if (typeof state.pending !== 'boolean') return
      state.active = state.pending
      delete state.pending
      session.append('plan/mode', { active: state.active })
    },
  }
}

function runnerFor(events) {
  const calls = []
  return { calls, async *stream(options) { calls.push(options); yield* events } }
}

/** A new adapter per call proves the carried plan is not an in-memory cache. */
async function delegatedTurn(harness, messages, plan) {
  const runner = runnerFor(plan === undefined
    ? [{ type: 'text', text: 'Done' }, { type: 'result', result: { inputTokens: 1, outputTokens: 1 } }]
    : [{ type: 'plan', plan }, { type: 'result', result: { result: plan, inputTokens: 1, outputTokens: 1 } }])
  const inner = { providerInfo: () => ({}), resolveModel: async (_provider, id) => ({ id }) }
  const adapter = createClaudeCliAdapter({ inner, runner, resolveMode: () => planModeForSession(harness.ctx, harness.session) ? 'plan' : 'full' })
  const chunks = []
  // Resume/fork reconstructs this request from persisted blocks, not JS object identity.
  for await (const chunk of adapter.stream({
    provider: 'geek2api', model: 'claude-opus-5-5', messages: JSON.parse(JSON.stringify(messages)),
    tools: harness.tools.wireSchemas(harness.agent).schemas,
  })) chunks.push(chunk)
  assert.notEqual(chunks.at(-1).reason.kind, 'error', JSON.stringify(chunks.at(-1)))
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  return { runner, blocks, call: blocks.find(block => block.type === 'tool-call') }
}

function persistReview(messages, turn, result) {
  messages.push({ role: 'assistant', content: turn.blocks })
  messages.push(createToolResultMessage({ callId: turn.call.id, content: result.content, isError: result.isError }))
}

const contentText = call => call.content.filter(block => block.type === 'text').map(block => block.text).join('')

for (const mode of ['native', 'ptc']) {
  test(`real ${mode} ToolRuntime reviews a plan and a fresh CLI receives all approved constraints`, async () => {
    const harness = host(mode)
    const plan = '# Approved plan\n\n' + 'detail '.repeat(1_300) + '\nNever publish, never expose keys, preserve unrelated changes.'
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Prepare a safe implementation plan.' }] }]
    const first = await delegatedTurn(harness, messages, plan)
    assert.equal(first.call.name, mode === 'ptc' ? 'run_code' : 'exit_plan_mode')
    assert.equal(first.runner.calls[0].mode, 'plan')
    const result = await harness.execute(first.call)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.deepEqual(harness.reviews, [plan])
    assert.equal(harness.state.active, true)
    assert.equal(harness.state.pending, false)
    assert.equal(result.additionalContexts?.length ?? 0, 0, 'real host review does not defer the plan into context')
    assert.equal(result.content.some(block => block.text?.includes(plan)), false, 'review result contains approval only, not the plan')
    persistReview(messages, first, result)
    // Older plan turns cannot be dropped even if enough later chat fills the ordinary budget.
    messages.push(...Array.from({ length: 65 }, () => ({ role: 'user', content: [{ type: 'text', text: 'unrelated '.repeat(100) }] })))
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue the approved plan.' }] })
    harness.boundary()
    const second = await delegatedTurn(harness, messages)
    const prompt = contentText(second.runner.calls[0])
    assert.equal(second.runner.calls[0].mode, 'full')
    assert.ok(prompt.includes(plan), 'approved constraints are complete, including the tail after 8k')
    assert.match(prompt, mode === 'ptc' ? /"approved": true/u : /Plan approved/u)
    assert.match(prompt, /Continue the approved plan/u)
    if (mode === 'ptc') {
      const dispatch = harness.events.find(event => event.type === 'tool/ptc-dispatch')
      assert.equal(dispatch.data.name, 'exit_plan_mode')
      assert.deepEqual(dispatch.data.arguments, { plan })
      assert.equal(dispatch.data.isError, false)
    }
  })

  test(`real ${mode} review rejection carries its original draft into revision, then approved revision into execution`, async () => {
    const harness = host(mode, [{ approved: false, feedback: 'Keep all data read-only and add rollback tests.' }, { approved: true }])
    const draft = '# Initial draft\n\nInvestigate auth; never log credentials; do not publish.'
    const revised = '# Revised draft\n\nKeep data read-only; add rollback tests; never log credentials; do not publish.'
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Plan the auth change.' }] }]
    const first = await delegatedTurn(harness, messages, draft)
    const rejected = await harness.execute(first.call)
    assert.equal(rejected.isError, true)
    assert.match(rejected.content[0].text, /Keep all data read-only and add rollback tests/u)
    assert.equal(harness.state.active, true)
    persistReview(messages, first, rejected)
    const second = await delegatedTurn(harness, messages, revised)
    const revisePrompt = contentText(second.runner.calls[0])
    assert.equal(second.runner.calls[0].mode, 'plan')
    assert.ok(revisePrompt.includes(draft), 'the rejected first draft is still available to the fresh CLI')
    assert.match(revisePrompt, /Keep all data read-only and add rollback tests/u)
    const approved = await harness.execute(second.call)
    assert.equal(approved.isError, false, JSON.stringify(approved))
    persistReview(messages, second, approved)
    harness.boundary()
    const third = await delegatedTurn(harness, messages)
    assert.equal(third.runner.calls[0].mode, 'full')
    assert.ok(contentText(third.runner.calls[0]).includes(revised))
    assert.deepEqual(harness.reviews, [draft, revised])
  })
}

test('real PTC collapse rejects a direct native review while the adapter selects the successful bridge', async () => {
  const harness = host('ptc')
  const denied = await harness.execute({ type: 'tool-call', id: 'native-under-ptc', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Not reachable directly' }) })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'UNKNOWN_TOOL')
  assert.equal(harness.reviews.length, 0)
  const generated = await delegatedTurn(harness, [{ role: 'user', content: [{ type: 'text', text: 'Plan safely.' }] }], '# Reachable through PTC\n\nRead only.')
  const reviewed = await harness.execute(generated.call)
  assert.equal(reviewed.isError, false, JSON.stringify(reviewed))
  assert.equal(harness.reviews.length, 1)
})

test('real native ToolRuntime keeps tools at logged plan state through exit/entry pending transitions', async () => {
  const harness = host('native')
  const modes = []
  harness.tools.register(createClaudeCodeTool({
    modeCeiling: () => 'full',
    planActive: (session, agent) => planModeForToolExecution(harness.ctx, session, agent),
    runner: { async run(options) {
      modes.push(options.mode)
      return { result: options.mode === 'plan' ? '# Read-only delegated plan' : 'Implemented', model: 'test', mode: options.mode, costUsd: 0, durationMs: 1 }
    } },
  }))
  const approved = await harness.execute({ id: 'approval', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Reviewed plan\n\nImplement only from the next step.' }) })
  assert.equal(approved.isError, false)
  const runTool = async id => {
    const result = await harness.execute({ id, name: 'claude_code', arguments: JSON.stringify({ prompt: 'Implement safely', mode: 'full' }) })
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  await runTool('same-batch')
  assert.equal(modes.at(-1), 'plan', 'pending=false, active=true must still plan')
  harness.boundary()
  await runTool('after-accepted-boundary')
  assert.equal(modes.at(-1), 'full', 'committed inactive restores the permission ceiling')
  harness.state.pending = true
  await runTool('pending-entry-current-batch')
  assert.equal(modes.at(-1), 'full', 'pending=true alone cannot change current batch permissions')
  harness.boundary()
  await runTool('after-entry-boundary')
  assert.equal(modes.at(-1), 'plan')
  assert.deepEqual(modes, ['plan', 'full', 'full', 'plan'])
})
