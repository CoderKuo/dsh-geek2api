#!/usr/bin/env node
/**
 * Live check for the built plugin.
 *
 * Drives the *built* host bundle against the real Geek2API gateway with the
 * key already stored in the DSH credentials file, through the same route the
 * plugin registers (`createRouteAdapter` over a key chooser and group reader):
 * it reads the balance and the key's groups, streams one answer per HTTP
 * model, rehearses rotation with a deliberately invalid key in front of the
 * real one, and reports how the host adapter classifies a key rejection — the
 * classification the harness's retry policy reads.
 *
 * It prints no key material, only a masked tail. Run it from the repository
 * root after `pnpm run build`:
 *
 *   node scripts/live-check.mjs [--with-cli] [--with-search] [--with-vision] [--key-label LABEL]
 *
 * `--with-cli` also runs each CLI-backed Claude model through the local
 * Claude Code CLI; `--with-search` runs one web search per backend. Both
 * spend more quota than the default run.
 * `--with-vision` checks DeepSeek with two color images through the host's
 * attachment service seam; the prompt does not disclose the colors.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readStoredKey } from './stored-key.mjs'
import { createVisionFixture } from './vision-fixture.mjs'

import {
  CLI_BACKED_MODEL_IDS,
  CLAUDE_CLI_MODES,
  Geek2APIKeyRing,
  SEARCH_BACKENDS,
  createBalanceReader,
  createClaudeCliAdapter,
  createClaudeRunner,
  createGroupReader,
  createKeyChooser,
  createGeek2APIRpc,
  createGeek2APISearchProvider,
  createHostPool,
  createRouteAdapter,
} from '../lib/index.js'

const PROVIDER = 'geek2api'
const SESSION_ID = 'live-check-session'
const HOSTS = createHostPool()
const HTTP_MODELS = ['deepseek-v4.1-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'grok-4.6', 'claude-opus-5-5', 'gemini-3.8-flash', 'glm-5.3']

/** In-memory stand-in for the DSH credential-record service. */
function fakeCredentials() {
  let record
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

const logger = {
  warn: (format, ...args) => console.log(`   ! ${format}`, ...args),
  info: (format, ...args) => console.log(`   · ${format}`, ...args),
}

/** A group reader with no evidence, so key choice falls back to ring order. */
const NO_GROUPS = Object.freeze({
  read: async () => ({ keys: [], descriptions: {}, requirements: {}, fetchedAt: Date.now() }),
  hasReading: () => true,
  covers: () => undefined,
  groupsOf: () => undefined,
  requiredGroups: () => undefined,
})

/** The plugin's composition, around one ring. */
async function routeWith(entries, { groupReader, resolveAttachments } = {}) {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  for (const [key, label] of entries) await ring.add(key, label)
  const groups = groupReader ?? createGroupReader({ listKeys: () => ring.secrets(), hosts: HOSTS })
  const keys = createKeyChooser({ ring, groups, logger })
  const adapter = createRouteAdapter({ ring, keys, hosts: HOSTS, fallbackSessionId: SESSION_ID, resolveAttachments })
  return { ring, groups, keys, adapter }
}

/** One turn through an adapter; the finish reason and the streamed text. */
async function turn(adapter, model, text = 'Reply with exactly: ok', { image } = {}) {
  const prepared = await adapter.prepareCall(PROVIDER, model)
  let answer = ''
  let finish
  for await (const chunk of prepared.stream({
    provider: PROVIDER,
    model,
    sessionId: SESSION_ID,
    reasoningEffort: 'high',
    maxTokens: 2048,
    messages: [createUserMessage({ content: [{ type: 'text', text }, ...(image === undefined ? [] : [image])], source: { kind: 'user' } })],
  })) {
    if (chunk.type === 'text-delta') answer += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { answer: answer.trim(), finish }
}

const describe = ({ answer, finish }) => (finish?.kind === 'stop'
  ? `→ ${answer.slice(0, 60)}`
  : `→ FAILED: ${String(finish?.failure?.message ?? 'no finish').slice(0, 140)}`)

async function main() {
  const labelIndex = process.argv.indexOf('--key-label')
  const label = labelIndex < 0 ? undefined : process.argv[labelIndex + 1]
  if (labelIndex >= 0 && (label === undefined || label.startsWith('--'))) throw new Error('--key-label needs a key label')
  const key = await readStoredKey({ label })
  const mask = text => String(text).split(key).join(`…${key.slice(-4)}`)
  console.log(`stored key: …${key.slice(-4)} (${key.length} chars)\n`)
  let visionFixture
  const route = await routeWith([[key, 'live-check']], { resolveAttachments: () => visionFixture?.attachments })

  console.log('1) balance')
  const balance = createBalanceReader({ listKeys: () => route.ring.secrets(), hosts: HOSTS })
  const value = await balance.read()
  const row = value.keys[0]
  console.log(`   account: remaining $${value.account.remainingUsd} of $${value.account.hardLimitUsd} (used $${value.account.totalUsageUsd})`)
  console.log(`   key "${row.label}": available $${row.usage?.availableUsd} / limit $${row.usage?.limitUsd} (${row.usage?.resetPeriod ?? 'no period'})${row.error === undefined ? '' : ` ERROR ${row.error}`}\n`)

  console.log('2) groups')
  const groups = await route.groups.read()
  const entry = groups.keys[0]
  console.log(`   groups: ${entry.groups?.join(', ') ?? `unread (${entry.error})`}`)
  console.log(`   reaches: ${Object.entries(entry.coverage).map(([id, ok]) => `${ok ? '✓' : '✗'} ${id}`).join('  ')}`)
  console.log(`   projection carries key material: ${JSON.stringify(groups).includes(key) ? 'YES (bug)' : 'no'}\n`)

  console.log('3) one answer per HTTP model, through the registered route')
  for (const id of HTTP_MODELS) {
    console.log(`   ${id.padEnd(16)} ${mask(describe(await turn(route.adapter, id)))}`)
  }

  console.log('\n4) an invalid key in front of the real one')
  const passOver = await routeWith([['sk-invalid-live-check-0001', 'deliberately invalid'], [key, 'real key']])
  console.log(`   with group evidence (the reader saw the gateway reject it): ${mask(describe(await turn(passOver.adapter, 'deepseek-v4.1-flash')))}`)
  console.log('   without group evidence, the rotation itself:')
  const rotation = await routeWith([['sk-invalid-live-check-0001', 'deliberately invalid'], [key, 'real key']], { groupReader: NO_GROUPS })
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const active = await rotation.ring.activeKey()
    console.log(`   attempt ${attempt}: using "${active.label}" ${mask(describe(await turn(rotation.adapter, 'deepseek-v4.1-flash')))}`)
    // The rotation lands asynchronously after the failed stream.
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const state = await rotation.ring.list()
  console.log(`   ring now: ${state.keys.map(item => `${item.label}=${item.disabled ? `disabled(${item.disabledReason})` : 'usable'}`).join(', ')}`)

  console.log('\n5) how the host adapter classifies a rejected key (what the retry policy reads)')
  const rejected = await routeWith([['sk-invalid-live-check-0002', 'rejected by the gateway']])
  const { finish } = await turn(rejected.adapter, 'deepseek-v4.1-flash')
  console.log(`   finish: ${mask(JSON.stringify(finish)?.slice(0, 200))}`)

  if (process.argv.includes('--with-cli')) {
    console.log('\n6) the model-shaped bridge: choosing a Claude model runs the CLI')
    const bridged = createClaudeCliAdapter({
      inner: route.adapter,
      runner: createClaudeRunner({
        resolveCredential: async ({ model } = {}) => {
          const choice = await route.keys.forRun(model ?? 'claude-opus-5-5')
          const { key: token, ...described } = choice
          return { ...described, baseUrl: HOSTS.current(), token }
        },
      }),
      resolveMode: () => 'read-only',
      resolveCwd: () => process.cwd(),
    })
    for (const id of CLI_BACKED_MODEL_IDS) {
      const started = Date.now()
      const result = await turn(bridged, id, 'Reply with exactly: cli-bridge-ok')
      console.log(`   ${id.padEnd(18)} ${mask(describe(result))} (${Math.round((Date.now() - started) / 1000)}s)`)
    }
  } else {
    console.log('\n6) model-shaped bridge skipped (pass --with-cli to run the real CLI)')
    console.log(`   CLI-backed models: ${CLI_BACKED_MODEL_IDS.join(', ')} · modes: ${Object.keys(CLAUDE_CLI_MODES).join(', ')}`)
  }

  if (process.argv.includes('--with-search')) {
    console.log('\n7) one web search per backend')
    for (const backend of SEARCH_BACKENDS) {
      const provider = createGeek2APISearchProvider({ ring: route.ring, hosts: HOSTS, backend: () => backend, covers: route.keys.covers, onKeyFailure: route.keys.onKeyFailure })
      const started = Date.now()
      try {
        const found = await provider.search({ query: 'latest Node.js release', maxResults: 8 })
        console.log(`   ${backend.padEnd(9)} → ${found.sources.length} sources in ${((Date.now() - started) / 1000).toFixed(1)}s; first: ${found.sources[0]?.url ?? '—'}`)
      } catch (error) {
        console.log(`   ${backend.padEnd(9)} → ${error.code}: ${mask(error.message).slice(0, 200)}`)
      }
    }
  } else {
    console.log('\n7) web search skipped (pass --with-search to run one search per backend)')
  }

  console.log('\n8) what the settings panel receives over RPC')
  const rpcRing = new Geek2APIKeyRing(fakeCredentials())
  const handler = createGeek2APIRpc({
    ring: rpcRing,
    balance: createBalanceReader({ listKeys: () => rpcRing.secrets(), hosts: HOSTS }),
    groups: createGroupReader({ listKeys: () => rpcRing.secrets(), hosts: HOSTS }),
    hosts: HOSTS,
    preference: { writable: false, set: async () => {} },
  })
  const added = await handler('keys/add', { key, label: 'rpc check' })
  console.log(`   keys/add ok=${added.ok}; status=${JSON.stringify(added.value.keys)}`)
  const projection = await handler('balance')
  const active = projection.value.keys.find(item => item.id === projection.value.activeId)
  console.log(`   activeId=${projection.value.activeId} label=${active?.label} available=$${active?.usage?.availableUsd} reset=${active?.usage?.resetPeriod}`)
  const groupProjection = await handler('groups')
  console.log(`   groups ok=${groupProjection.ok}: ${groupProjection.value?.keys?.[0]?.groups?.join(', ')}`)
  console.log(`   projections carry key material: ${JSON.stringify([projection, groupProjection]).includes(key) ? 'YES (bug)' : 'no'}`)

  if (process.argv.includes('--with-vision')) {
    console.log('\n9) DeepSeek identifies images through the registered route')
    for (const color of ['red', 'blue']) {
      visionFixture = createVisionFixture(color)
      const result = await turn(route.adapter, 'deepseek-v4.1-flash',
        'What is the dominant color in this image? Reply with exactly one lowercase English color word.',
        { image: visionFixture.block })
      console.log(`   ${color} image ${mask(describe(result))}`)
      if (result.finish?.kind !== 'stop' || result.answer.toLowerCase() !== color || visionFixture.reads.length !== 1) {
        throw new Error(`DeepSeek vision check failed for the ${color} image`)
      }
    }
  }
}

await main()
