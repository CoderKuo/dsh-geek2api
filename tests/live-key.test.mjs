import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import { readStoredKey } from '../scripts/stored-key.mjs'

async function file(t, record, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'geek2api-live-key-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'credentials.yaml')
  await writeFile(path, stringify({ version: 2, records: { 'geek2api/keys': record }, ...extra }), { mode: 0o600 })
  return path
}

const grant = keys => ({ kind: 'grant', payload: { version: 1, activeId: 'second', keys } })
const KEYS = [
  { id: 'first', label: 'First', key: 'sk-fixture-first', addedAt: 1 },
  { id: 'second', label: 'Grok', key: 'sk-fixture-second', addedAt: 2 },
]

test('live checks use the plugin-owned active key and do not change the credential file', async t => {
  const filePath = await file(t, grant(KEYS), { refs: { GEEK2API_API_KEY: 'sk-fixture-unrelated-reference' } })
  const before = await readFile(filePath, 'utf8')
  assert.equal(await readStoredKey({ filePath }), 'sk-fixture-second')
  assert.equal(await readStoredKey({ filePath, label: 'First' }), 'sk-fixture-first')
  assert.equal(await readFile(filePath, 'utf8'), before)
})

test('live checks refuse missing, disabled and ambiguous labels', async t => {
  const filePath = await file(t, grant([{ ...KEYS[0], disabledAt: 3 }, KEYS[1], { ...KEYS[1], id: 'duplicate' }]))
  for (const label of ['First', 'Missing', 'Grok']) {
    await assert.rejects(() => readStoredKey({ filePath, label }), /one usable key/u)
  }
})

test('a reference, legacy entry or unrelated record never substitutes for a missing plugin key', async t => {
  const filePath = await file(t, undefined, {
    GEEK2API_API_KEY: 'sk-fixture-legacy',
    refs: { GEEK2API_API_KEY: 'sk-fixture-reference' },
    records: { 'another-plugin/keys': grant(KEYS) },
  })
  await assert.rejects(() => readStoredKey({ filePath }), /added under Settings/u)
})

test('a YAML parse error never returns its secret-bearing source line', async t => {
  const filePath = await file(t, grant(KEYS))
  await writeFile(filePath, 'secret: "sk-fixture-private-unclosed\n')
  await assert.rejects(() => readStoredKey({ filePath }), error => {
    assert.equal(error.message, 'Geek2API plugin credentials could not be read safely')
    assert.equal(String(error).includes('sk-fixture'), false)
    return true
  })
})
