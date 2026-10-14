#!/usr/bin/env node
/**
 * Multi-key smoke check for the built plugin.
 *
 * Loads several keys from a JSON file (`{ "label": "sk-…" }`), never printing
 * more than a masked tail, and drives the built host bundle against the real
 * gateway through the plugin's own composition: host pool, key ring, group
 * reader, key chooser, and route adapter. It reads each key's balance and
 * model coverage, then streams one short answer per catalog model on whatever
 * key the chooser picks for it.
 *
 *   node scripts/smoke.mjs <keys.json> [model …]
 */

import { readFile } from 'node:fs/promises'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  GEEK2API_MODEL_IDS,
  Geek2APIKeyRing,
  createBalanceReader,
  createGroupReader,
  createHostPool,
  createKeyChooser,
  createRouteAdapter,
} from '../lib/index.js'

const PROVIDER = 'geek2api'
const SESSION_ID = 'smoke-session'

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

const used = []
const logger = {
  warn: (format, ...args) => console.log(`   ! ${format}`, ...args),
  info: (format, ...args) => used.push([format, ...args]),
}

async function turn(adapter, model) {
  const prepared = await adapter.prepareCall(PROVIDER, model)
  let answer = ''
  let finish
  const started = Date.now()
  for await (const chunk of prepared.stream({
    provider: PROVIDER,
    model,
    sessionId: SESSION_ID,
    reasoningEffort: 'low',
    maxTokens: 1024,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: ok' }], source: { kind: 'user' } })],
  })) {
    if (chunk.type === 'text-delta') answer += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { answer: answer.trim(), finish, ms: Date.now() - started }
}

async function main() {
  const [file, ...models] = process.argv.slice(2)
  if (file === undefined) throw new Error('usage: node scripts/smoke.mjs <keys.json> [model …]')
  const keys = JSON.parse(await readFile(file, 'utf8'))
  const hosts = createHostPool({ logger })
  await hosts.probe({ force: true })
  console.log('hosts:', hosts.status().map(entry => `${entry.host.replace('https://', '')}${entry.latencyMs === undefined ? ' ✕' : ` ${entry.latencyMs}ms`}`).join(', '))

  const ring = new Geek2APIKeyRing(fakeCredentials())
  for (const [label, key] of Object.entries(keys)) await ring.add(key, label)
  const groups = createGroupReader({ listKeys: () => ring.secrets(), hosts })
  const balance = createBalanceReader({ listKeys: () => ring.secrets(), hosts })
  const chooser = createKeyChooser({ ring, groups, logger })
  const adapter = createRouteAdapter({ ring, keys: chooser, hosts, fallbackSessionId: SESSION_ID })

  const [reading, money] = await Promise.all([groups.read({ force: true }), balance.read({ force: true })])
  const state = await ring.list()
  for (const entry of state.keys) {
    const g = reading.keys.find(item => item.id === entry.id)
    const b = money.keys.find(item => item.id === entry.id)
    const reach = Object.entries(g?.coverage ?? {}).filter(([, ok]) => ok).map(([id]) => id)
    const usage = b?.usage
    console.log(`key ${entry.label}: ${usage === undefined ? `balance ✕ ${b?.error ?? ''}` : `${usage.mode} $${usage.availableUsd ?? '?'} today $${usage.todayUsd ?? '?'}`}`
      + ` | groups ${g?.groups?.join(',') ?? '—'} | reaches ${reach.join(', ') || (g?.error ?? 'none')}`)
  }

  for (const model of models.length > 0 ? models : GEEK2API_MODEL_IDS) {
    used.length = 0
    try {
      const result = await turn(adapter, model)
      const via = used.find(item => String(item[0]).includes('this request uses key'))
      const keyLabel = via === undefined ? state.keys.find(entry => entry.active)?.label : state.keys.find(entry => entry.id === via[3])?.label
      console.log(`${model.padEnd(28)} ${result.finish?.kind === 'stop' ? `ok  "${result.answer.slice(0, 40)}"` : `FAIL ${String(result.finish?.failure?.message ?? 'no finish').slice(0, 220)}`}  [key ${keyLabel}, ${result.ms}ms]`)
    } catch (error) {
      console.log(`${model.padEnd(28)} THREW ${String(error?.message ?? error).slice(0, 220)}`)
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
