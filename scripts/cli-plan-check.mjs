#!/usr/bin/env node
/**
 * Real official Claude CLI + built plan bridge, using a local fake gateway.
 * No real credentials, quota, DSH instance or project files are involved.
 *
 *   node scripts/cli-plan-check.mjs [--binary /path/to/claude]
 *
 * Verifies stdio ExitPlanMode, simultaneous plans, private file fallback,
 * no-plan returns, actual plan-mode denials, MCP search and resource cleanup.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { createClaudeRunner, createClaudeSearchBridge, findClaudeBinary } from '../lib/index.js'

const args = process.argv.slice(2)
const binary = findClaudeBinary(args.includes('--binary') ? args[args.indexOf('--binary') + 1] : '')
const directory = await mkdtemp(join(tmpdir(), 'geek2api-cli-plan-check-'))
const ownedDirectory = await realpath(directory)
const configDir = join(directory, 'config')
const cases = new Map()
const failures = []
let searchCalls = 0

for (const id of ['a', 'b', 'file-only', 'no-plan', 'blocked']) {
  const cwd = join(directory, id)
  await mkdir(cwd)
  cases.set(id, { id, cwd, calls: 0, controls: 0, exitControls: 0, errors: [], plan: `# Plan ${id}\n\nPreserve constraint ${id.toUpperCase()}_SENTINEL_426.` })
}
await mkdir(join(configDir, 'plans'), { recursive: true })
const savedSettings = JSON.stringify({ permissions: { allow: ['ExitPlanMode'], deny: ['WebFetch'] } })
await writeFile(join(configDir, 'settings.json'), savedSettings)
const stale = join(configDir, 'plans', 'unrelated.md')
await writeFile(stale, '# Unrelated\n\nThis is not the current request.')
// Even a misleading future mtime in the shared directory must not be evidence.
const future = new Date(Date.now() + 120_000)
await utimes(stale, future, future)

function texts(body) {
  return [...(Array.isArray(body.system) ? body.system : []), ...(body.messages ?? []).flatMap(message => typeof message.content === 'string' ? [{ text: message.content }] : message.content ?? [])]
    .filter(part => typeof part?.text === 'string').map(part => part.text).join('\n')
}

function privatePlanPath(state, body) {
  assert.ok(state.planDirectory, `${state.id}: no private plansDirectory was passed`)
  const root = realpathSync(state.planDirectory)
  for (const match of texts(body).matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+\.md/gu)) {
    try {
      const parent = realpathSync(dirname(match[0]))
      if (parent === root || parent.startsWith(`${root}${sep}`)) return match[0]
    } catch { /* not this run's plan file */ }
  }
  const exitSchema = (body.tools ?? []).find(tool => tool.name === 'ExitPlanMode')?.input_schema
  const pathParents = [...texts(body).matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+\.md/gu)].map(match => dirname(match[0]))
  throw new Error(`${state.id}: official CLI did not announce a private plan file; candidate directories=${JSON.stringify(pathParents)}; public ExitPlanMode schema=${JSON.stringify(exitSchema)}`)
}

function respond(res, body, content) {
  const tool = content.type === 'tool_use'
  const message = { id: 'msg_plan_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...message, content: [content], stop_reason: tool ? 'tool_use' : 'end_turn' }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message })
  event('content_block_start', { index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } })
  event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  event('message_stop', {})
  res.end()
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch { body = {} }
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
      res.end(req.url.includes('count_tokens') ? '{"input_tokens":1}' : '{}')
      return
    }
    try {
      if (!(body.tools ?? []).some(tool => tool.name === 'Write')) return respond(res, body, { type: 'text', text: 'Auxiliary fixture answer.' })
      const marker = /PLAN_FIXTURE:([a-z-]+)/u.exec(texts(body))?.[1]
      const state = cases.get(marker)
      assert.ok(state, 'a model turn lost its fixture marker')
      assert.ok((body.tools ?? []).some(tool => tool.name === 'ExitPlanMode'), `${marker}: ExitPlanMode is missing from the real CLI catalog`)
      assert.ok(!(body.tools ?? []).some(tool => tool.name === 'WebSearch'), `${marker}: native WebSearch must stay disabled`)
      assert.ok((body.system ?? []).some(part => part.text?.startsWith("You are Claude Code, Anthropic's official CLI")), 'official identity changed')
      const step = state.calls++
      const tool = (name, input) => ({ type: 'tool_use', id: `fixture_${marker}_${step}`, name, input })
      if (marker === 'blocked') return respond(res, body, step < 12 ? tool('Write', { file_path: join(state.cwd, 'must-not-exist.txt'), content: 'must remain blocked' }) : { type: 'text', text: 'Unexpectedly exceeded the denial budget.' })
      if (marker === 'no-plan') return respond(res, body, { type: 'text', text: 'Read-only exploration; no plan was written.' })
      const search = (body.tools ?? []).find(item => /^mcp__geek2api_search_[a-f0-9]+__web_search$/u.test(item.name ?? ''))
      if (marker === 'a' && step === 0) {
        assert.ok(search, 'plan mode lost its read-only search bridge')
        return respond(res, body, tool(search.name, { query: 'plan fixture', max_results: 1 }))
      }
      const writeStep = marker === 'a' ? 1 : 0
      if (step === writeStep) {
        state.file = privatePlanPath(state, body)
        return respond(res, body, tool('Write', { file_path: state.file, content: state.plan }))
      }
      if (marker === 'file-only') return respond(res, body, { type: 'text', text: 'The private plan was written; returning without ExitPlanMode.' })
      return respond(res, body, tool('ExitPlanMode', { allowedPrompts: [] }))
    } catch (error) {
      failures.push(String(error.message))
      respond(res, body, { type: 'text', text: 'Fixture assertion failed.' })
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const runner = createClaudeRunner({
  binary,
  configDir,
  resolveCredential: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-only-not-a-real-credential', label: 'local plan fixture' }),
  timeoutMs: 90_000,
  createSearchBridge: ({ signal }) => createClaudeSearchBridge({
    signal,
    search: async () => {
      searchCalls++
      return { content: 'Local mocked search.', sources: [{ url: 'https://example.com/fixture', title: 'Fixture source' }] }
    },
  }),
  spawnImpl: (program, argv, options) => {
    const state = [...cases.values()].find(item => item.cwd === options.cwd)
    assert.ok(state, 'unknown fixture workspace')
    assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'stdio', 'permission callbacks are not routed over stdio')
    assert.equal(options.env.CLAUDE_CONFIG_DIR, configDir, 'per-run plans must not change the credential/config home')
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
    state.planDirectory = settings.plansDirectory
    assert.ok(typeof state.planDirectory === 'string' && state.planDirectory !== '')
    const child = spawn(program, argv, options)
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        try {
          const frame = JSON.parse(line)
          if (frame.type === 'control_request') {
            state.controls++
            if (frame.request?.tool_name === 'ExitPlanMode') state.exitControls++
          }
        } catch { /* the runner owns stream parsing */ }
      }
    })
    return child
  },
})

async function run(id) {
  const state = cases.get(id)
  const events = []
  for await (const event of runner.stream({ prompt: `PLAN_FIXTURE:${id}\nExplore read-only and hand the plan to DSH.`, model: 'claude-opus-5-5', mode: 'plan', cwd: state.cwd })) {
    events.push(event)
    if (event.type === 'tool-error') state.errors.push(event.text)
  }
  return events
}

try {
  const parallel = await Promise.all(['a', 'b'].map(run))
  assert.deepEqual(failures, [], 'the real CLI fixture failed before plan submission')
  for (const [index, id] of ['a', 'b'].entries()) {
    assert.deepEqual(cases.get(id).errors, [], `${id}: a permitted plan operation failed`)
    assert.equal(parallel[index].find(event => event.type === 'plan')?.plan, cases.get(id).plan, `${id}: received another run's plan`)
    assert.equal(cases.get(id).exitControls, 1, `${id}: native ExitPlanMode never reached the host control handler`)
  }
  assert.notEqual(cases.get('a').planDirectory, cases.get('b').planDirectory)
  assert.equal(searchCalls, 1)
  console.log('PASS: real stdio ExitPlanMode; concurrent plan ownership; plan-mode MCP search')

  const fallback = await run('file-only')
  assert.deepEqual(cases.get('file-only').errors, [])
  assert.equal(fallback.find(event => event.type === 'plan')?.plan, cases.get('file-only').plan)
  const noPlan = await run('no-plan')
  assert.equal(noPlan.some(event => event.type === 'plan'), false, 'a no-plan return picked up an unrelated file')
  console.log('PASS: private file fallback; no stale/shared-plan pickup')

  await assert.rejects(run('blocked'), /too many denied permission prompts/u)
  await assert.rejects(access(join(cases.get('blocked').cwd, 'must-not-exist.txt')), error => error.code === 'ENOENT')
  assert.ok(cases.get('blocked').calls <= 9, 'actual CLI permission denials exceeded the bounded budget')
  assert.deepEqual(failures, [])
  assert.equal(await readFile(join(configDir, 'settings.json'), 'utf8'), savedSettings, 'existing permission settings were modified')
  for (const state of cases.values()) await assert.rejects(access(state.planDirectory), error => error.code === 'ENOENT')
  console.log('PASS: actual CLI denial budget; no project writes; private plan resources cleaned')
  console.log('Claude responses and search were local fixtures, not live Claude upstream or desktop DSH integration.')
} finally {
  await runner.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  assert.equal(await realpath(directory), ownedDirectory)
  assert.ok(ownedDirectory.startsWith(`${await realpath(tmpdir())}${sep}geek2api-cli-plan-check-`))
  // Delete only this script's verified private fixture directory.
  await rm(ownedDirectory, { recursive: true, force: true })
}
