import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BLOCK_BEGIN, BLOCK_END, createSearchComposition } from '../src/search-composition.js'

const BASE = { searchProvider: 'deepseek-official', fetchProvider: 'http' }

async function scratch(content) {
  const dir = await mkdtemp(join(tmpdir(), 'geek2api-search-'))
  const path = join(dir, 'cordis.patch.yml')
  if (content !== undefined) await writeFile(path, content)
  return { dir, path }
}

function compose(path, base = () => BASE, extra = {}) {
  return createSearchComposition({ resolvePatchPath: async () => path, readBaseConfig: base, ...extra })
}

const USER_PATCH = [
  '# Your patch layer for this dsh profile.',
  '- id: kimi-subscription',
  '  name: dsh-kimi-subscription',
  '  config:',
  '    searchProvider: auto',
  '- id: permission',
  '  config:',
  '    defaultPreset: danger-full-access',
  '',
].join('\n')

test('apply appends one marked web entry and leaves every other line alone', async t => {
  const { dir, path } = await scratch(USER_PATCH)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const composition = compose(path)

  const first = await composition.apply('geek2api-auto')
  assert.deepEqual(first, { changed: true, fallback: 'deepseek-official' })
  const written = await readFile(path, 'utf8')
  assert.ok(written.startsWith(USER_PATCH), 'the user patch is kept byte for byte')
  assert.equal(written.slice(USER_PATCH.length), [
    BLOCK_BEGIN,
    '# fallback: deepseek-official',
    '- id: web',
    '  config:',
    // A profile patch replaces the whole matched config, so the other web
    // fields are restated.
    '    fetchProvider: http',
    '    searchProvider: geek2api-auto',
    BLOCK_END,
    '',
  ].join('\n'))

  // Applying the same selection again does not touch the file.
  assert.deepEqual(await composition.apply('geek2api-auto'), { changed: false, fallback: 'deepseek-official' })
  assert.deepEqual(await composition.read(), { present: true, provider: 'geek2api-auto', fallback: 'deepseek-official' })
})

test('a later selection rewrites the entry in place and keeps the recorded fallback', async t => {
  const { dir, path } = await scratch(USER_PATCH)
  t.after(() => rm(dir, { recursive: true, force: true }))
  let base = { ...BASE, searchProvider: 'kimi-subscription' }
  const composition = compose(path, () => base)
  await composition.apply('geek2api-auto')

  // A sibling plugin appends its own entry after ours; after the reload the
  // web base names this plugin's provider.
  const sibling = '# >>> other plugin\n- id: web\n  config:\n    searchProvider: other\n# <<< other plugin\n'
  await writeFile(path, `${await readFile(path, 'utf8')}${sibling}`)
  base = { ...BASE, searchProvider: 'geek2api-auto' }

  const outcome = await composition.apply('geek2api')
  assert.deepEqual(outcome, { changed: true, fallback: 'kimi-subscription' })
  const written = await readFile(path, 'utf8')
  assert.ok(written.endsWith(sibling), 'our entry did not move behind the sibling')
  assert.match(written, /# fallback: kimi-subscription\n- id: web\n {2}config:\n {4}fetchProvider: http\n {4}searchProvider: geek2api\n/u)
})

test('without an entry, a base that already names this plugin falls back to DSH search', async t => {
  const { dir, path } = await scratch('[]\n')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const composition = compose(path, () => ({ searchProvider: 'geek2api-auto', fetchProvider: 'http' }))
  const outcome = await composition.apply('geek2api')
  assert.equal(outcome.fallback, 'deepseek-official')
  const written = await readFile(path, 'utf8')
  // The empty-list placeholder gives way to the entry.
  assert.doesNotMatch(written, /^\[\]$/mu)
  assert.ok(written.startsWith(BLOCK_BEGIN))
})

test('remove restores the file, down to an empty list when nothing else remains', async t => {
  const { dir, path } = await scratch(USER_PATCH)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const composition = compose(path)
  await composition.apply('geek2api-auto')
  assert.deepEqual(await composition.remove(), { changed: true })
  assert.equal(await readFile(path, 'utf8'), USER_PATCH)
  assert.deepEqual(await composition.remove(), { changed: false })
  assert.deepEqual(await composition.read(), { present: false })

  const lone = await scratch('[]\n')
  t.after(() => rm(lone.dir, { recursive: true, force: true }))
  const only = compose(lone.path)
  await only.apply('geek2api')
  await only.remove()
  assert.equal(await readFile(lone.path, 'utf8'), '[]\n')
})

test('an entry another writer moved inside the markers survives removal', async t => {
  // A YAML round trip keeps the end marker as a trailing comment, so a row
  // appended later can land between our item and the marker.
  const content = [
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    BLOCK_BEGIN,
    '# fallback: deepseek-official',
    '- id: web',
    '  config:',
    '    fetchProvider: http',
    '    searchProvider: geek2api-auto',
    '- id: codex-subscription',
    '  name: dsh-codex-subscription',
    '  config:',
    '    searchProvider: auto',
    BLOCK_END,
    '',
  ].join('\n')
  const { dir, path } = await scratch(content)
  t.after(() => rm(dir, { recursive: true, force: true }))
  await compose(path).remove()
  assert.equal(await readFile(path, 'utf8'), [
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '- id: codex-subscription',
    '  name: dsh-codex-subscription',
    '  config:',
    '    searchProvider: auto',
    '',
  ].join('\n'))
})

test('after a YAML rewrite drifts the end marker, one apply restores it and the next changes nothing', async t => {
  // What DSH's config editor (yaml parseDocument → String) produced when it
  // appended a row after ours: the marker became a trailing comment.
  const drifted = [
    '- id: kimi-subscription',
    '  config:',
    '    searchProvider: default',
    BLOCK_BEGIN,
    '# fallback: deepseek-official',
    '- id: web',
    '  config:',
    '    fetchProvider: http',
    '    searchProvider: geek2api-auto',
    '- id: geek2api',
    '  name: dsh-geek2api',
    '  config:',
    '    searchProvider: auto',
    '',
    BLOCK_END,
    '',
  ].join('\n')
  const { dir, path } = await scratch(drifted)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const composition = compose(path)
  assert.equal((await composition.apply('geek2api-auto')).changed, true)
  assert.equal(await readFile(path, 'utf8'), [
    '- id: kimi-subscription',
    '  config:',
    '    searchProvider: default',
    BLOCK_BEGIN,
    '# fallback: deepseek-official',
    '- id: web',
    '  config:',
    '    fetchProvider: http',
    '    searchProvider: geek2api-auto',
    BLOCK_END,
    '- id: geek2api',
    '  name: dsh-geek2api',
    '  config:',
    '    searchProvider: auto',
    '',
  ].join('\n'))
  assert.equal((await composition.apply('geek2api-auto')).changed, false)
})

test('a missing file is created, CRLF files keep CRLF, and a flow list is refused', async t => {
  const missing = await scratch()
  t.after(() => rm(missing.dir, { recursive: true, force: true }))
  await compose(missing.path).apply('geek2api-auto')
  assert.ok((await readFile(missing.path, 'utf8')).startsWith(BLOCK_BEGIN))

  const crlf = await scratch('- id: permission\r\n  config:\r\n    defaultPreset: read-only\r\n')
  t.after(() => rm(crlf.dir, { recursive: true, force: true }))
  await compose(crlf.path).apply('geek2api')
  const text = await readFile(crlf.path, 'utf8')
  assert.equal(text.split('\r\n').length - 1, text.split('\n').length - 1, 'every line ends in CRLF')

  const flow = await scratch('[{ id: permission, config: { defaultPreset: read-only } }]\n')
  t.after(() => rm(flow.dir, { recursive: true, force: true }))
  await assert.rejects(compose(flow.path).apply('geek2api'), /not a plain YAML list/u)
  assert.equal(await readFile(flow.path, 'utf8'), '[{ id: permission, config: { defaultPreset: read-only } }]\n')
})

test('only this plugin\'s providers can be applied, and writes run inside the exclusive section', async t => {
  const { dir, path } = await scratch('[]\n')
  t.after(() => rm(dir, { recursive: true, force: true }))
  let exclusive = 0
  const composition = compose(path, () => BASE, {
    runExclusive: async run => {
      exclusive += 1
      return run()
    },
  })
  await assert.rejects(composition.apply('deepseek-official'), /cannot select/u)
  await composition.apply('geek2api')
  // Confirming an entry that already matches, or removing one that is not
  // there, never takes the lock: every web restart does one of the two.
  await composition.apply('geek2api')
  await composition.remove()
  await composition.remove()
  assert.equal(exclusive, 2)

  const unlocated = createSearchComposition({ resolvePatchPath: async () => undefined, readBaseConfig: () => BASE })
  await assert.rejects(unlocated.apply('geek2api'), /could not find the profile patch file/u)
})
