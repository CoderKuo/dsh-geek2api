/**
 * Point the DSH web row's base search provider at this plugin.
 *
 * The web runtime has one search slot. Subscription plugins (Codex, Kimi)
 * rewrite that slot at runtime whenever the web row restarts, and fall back to
 * the row's *base* config for models they do not own. Writing the runtime slot
 * here as well would make two switchers restart each other forever. Instead
 * this plugin keeps one marked `- id: web` entry in the owning profile's
 * `cordis.patch.yml`: the boot layer hot-applies the file, the base config then
 * names a Geek2API provider, and every router — or the bare slot, when no
 * router holds it — reaches Geek2API for the requests it does not own.
 *
 * Only the marked entry is ever touched. It is rewritten in place, so a
 * sibling plugin that appends its own entry after it never sees this file
 * reorder; an unchanged entry is never rewritten. A profile patch replaces the
 * whole matched config, so the entry restates the web row's other scalar
 * fields. It also records, as a comment, the provider the base named before
 * the entry existed, which is where the auto provider sends requests it does
 * not serve.
 *
 * @module dsh-geek2api/search-composition
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findInstall } from './plugin-version.js'
import { DSH_SEARCH_PROVIDER_FALLBACK, OWN_SEARCH_PROVIDER_IDS } from './search.js'

export const SEARCH_PATCH_FILE = 'cordis.patch.yml'
export const BLOCK_BEGIN = '# >>> dsh-geek2api: web search provider (managed in Settings → Geek2API → Web search)'
export const BLOCK_END = '# <<< dsh-geek2api: web search provider'
const BEGIN_PREFIX = '# >>> dsh-geek2api: web search provider'
const FALLBACK_LINE = /^#\s*fallback:\s*(\S+)\s*$/u
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/u
const EMPTY_LIST = /^\[\]\s*$/u
const LIST_ITEM = /^-(?:\s|$)/u
const ITEM_HEAD = /^- id: web\s*$/u
const CONTINUATION = /^\s+\S/u

const isBegin = line => line.trim().startsWith(BEGIN_PREFIX)
const isEnd = line => line.trim() === BLOCK_END

/**
 * Find this plugin's entry: the begin marker, its comment lines, the single
 * `- id: web` item with its indented lines, and an end marker directly after.
 * Anything else — including another entry a YAML rewrite moved inside the
 * markers — is not part of it.
 * @param lines - the file split into lines.
 * @returns the half-open line range and the recorded fallback, or undefined.
 */
function locate(lines) {
  const start = lines.findIndex(isBegin)
  if (start < 0) return undefined
  let index = start + 1
  let fallback
  while (index < lines.length && lines[index].startsWith('#') && !isEnd(lines[index]) && !isBegin(lines[index])) {
    const match = FALLBACK_LINE.exec(lines[index])
    if (match !== null) fallback = match[1]
    index += 1
  }
  let provider
  if (index < lines.length && ITEM_HEAD.test(lines[index])) {
    index += 1
    while (index < lines.length && CONTINUATION.test(lines[index])) {
      const match = /^\s+searchProvider:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/u.exec(lines[index])
      if (match !== null) provider = match[1]
      index += 1
    }
  }
  if (index < lines.length && isEnd(lines[index])) index += 1
  return { start, end: index, fallback, provider }
}

/** Drop the located entry and any stray end marker left elsewhere. */
function strip(lines) {
  const found = locate(lines)
  const kept = found === undefined ? [...lines] : [...lines.slice(0, found.start), ...lines.slice(found.end)]
  return kept.filter(line => !isEnd(line))
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value)
  return /^[A-Za-z0-9._-]+$/u.test(value) ? value : JSON.stringify(value)
}

/** The entry's lines; the web row's other scalar fields are restated, sorted. */
function entryLines(providerId, fallback, baseConfig) {
  const fields = {}
  for (const [key, value] of Object.entries(baseConfig ?? {})) {
    if (key === 'searchProvider' || !/^[A-Za-z0-9_]+$/u.test(key)) continue
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) fields[key] = value
  }
  fields.searchProvider = providerId
  return [
    BLOCK_BEGIN,
    `# fallback: ${fallback}`,
    '- id: web',
    '  config:',
    ...Object.keys(fields).sort().map(key => `    ${key}: ${yamlScalar(fields[key])}`),
    BLOCK_END,
  ]
}

/** A provider id the auto provider may fall back to. */
export function usableFallback(id) {
  return typeof id === 'string' && PROVIDER_ID.test(id) && !OWN_SEARCH_PROVIDER_IDS.includes(id)
    ? id
    : DSH_SEARCH_PROVIDER_FALLBACK
}

/**
 * Refuse a file this line-level editor cannot extend safely: a flow sequence
 * with entries, or a top-level line that is not a list item or comment.
 */
function assertBlockSequence(lines) {
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#') || CONTINUATION.test(line) || LIST_ITEM.test(line) || EMPTY_LIST.test(line)) continue
    throw new Error('Geek2API web search could not edit the profile patch: it is not a plain YAML list; set the web search provider by hand')
  }
}

/**
 * Maintain this plugin's entry in the owning profile's patch file.
 * @param options - where the file is, the web row's current base config, an
 *   optional exclusive section (DSH's reload lock), and file-system seams.
 * @returns the composition: read the entry, apply a provider, remove it.
 */
export function createSearchComposition({
  resolvePatchPath,
  readBaseConfig,
  runExclusive = run => run(),
  fs = { readFile, writeFile, rename },
} = {}) {
  if (typeof resolvePatchPath !== 'function') throw new Error('Geek2API search composition requires resolvePatchPath')
  if (typeof readBaseConfig !== 'function') throw new Error('Geek2API search composition requires readBaseConfig')

  let chain = Promise.resolve()
  const serialized = run => {
    const next = chain.then(() => runExclusive(run))
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  const load = async () => {
    const path = await resolvePatchPath()
    if (typeof path !== 'string' || path === '') throw new Error('Geek2API web search could not find the profile patch file')
    let content = ''
    try {
      content = await fs.readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const lines = content === '' ? [] : content.split(/\r?\n/u)
    if (lines.length > 0 && lines.at(-1) === '') lines.pop()
    return { path, content, eol, lines }
  }

  const render = ({ eol }, lines) => (lines.length === 0 ? '' : `${lines.join(eol)}${eol}`)

  const save = async (file, lines) => {
    const next = render(file, lines)
    if (next === file.content) return false
    const temporary = `${file.path}.geek2api.tmp`
    await fs.writeFile(temporary, next, { mode: 0o600 })
    await fs.rename(temporary, file.path)
    return true
  }

  /** The file with this plugin's entry pointing at `providerId`. */
  const applied = (file, providerId) => {
    const found = locate(file.lines)
    assertBlockSequence(found === undefined ? file.lines : [...file.lines.slice(0, found.start), ...file.lines.slice(found.end)])
    const base = readBaseConfig() ?? {}
    const fallback = found?.fallback !== undefined
      ? usableFallback(found.fallback)
      : usableFallback(base.searchProvider)
    const entry = entryLines(providerId, fallback, base)
    if (found !== undefined) {
      // A YAML rewrite can leave our end marker below a row appended later;
      // put it back after our item so the next apply finds nothing to change.
      const before = file.lines.slice(0, found.start).filter(line => !isEnd(line))
      const after = file.lines.slice(found.end).filter(line => !isEnd(line))
      while (after.length > 0 && after.at(-1).trim() === '') after.pop()
      return { fallback, lines: [...before, ...entry, ...after] }
    }
    const lines = file.lines.filter(line => !EMPTY_LIST.test(line) && !isEnd(line))
    while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
    return { fallback, lines: [...lines, ...entry] }
  }

  /** The file without this plugin's entry, or undefined when it holds none. */
  const removed = file => {
    if (locate(file.lines) === undefined && !file.lines.some(isEnd)) return undefined
    const lines = strip(file.lines)
    while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
    if (!lines.some(line => LIST_ITEM.test(line)) && !lines.some(line => EMPTY_LIST.test(line))) lines.push('[]')
    return lines
  }

  return Object.freeze({
    /** The entry as the file holds it now. */
    async read() {
      const { lines } = await load()
      const found = locate(lines)
      return found === undefined
        ? { present: false }
        : { present: true, provider: found.provider, fallback: usableFallback(found.fallback) }
    },

    /**
     * Point the base search provider at `providerId`, keeping the recorded
     * fallback when the entry already exists.
     * @returns whether the file changed, and the fallback the entry records.
     */
    async apply(providerId) {
      if (!OWN_SEARCH_PROVIDER_IDS.includes(providerId)) {
        throw new Error(`Geek2API web search cannot select "${String(providerId)}"`)
      }
      // Every web restart reconciles; an entry that already matches is
      // confirmed without taking DSH's reload lock.
      const current = await load()
      const planned = applied(current, providerId)
      if (render(current, planned.lines) === current.content) return { changed: false, fallback: planned.fallback }
      return serialized(async () => {
        const file = await load()
        const next = applied(file, providerId)
        return { changed: await save(file, next.lines), fallback: next.fallback }
      })
    },

    /** Remove the entry, leaving an empty list when nothing else remains. */
    async remove() {
      if (removed(await load()) === undefined) return { changed: false }
      return serialized(async () => {
        const file = await load()
        const lines = removed(file)
        return { changed: lines === undefined ? false : await save(file, lines) }
      })
    },
  })
}

/**
 * Run `operation` inside DSH's reload transaction, so a patch write never
 * overlaps a profile reload or a settings write. A reconcile started from
 * inside one of those (a web restart during a reload, a volatile update
 * during a settings write) inherits its context, and DSH refuses to nest the
 * transaction; that one runs unlocked, after the transaction that started it.
 * @param hmr - DSH's `hmr` service, when the host has one.
 * @param operation - the write.
 * @returns the operation's result.
 */
export async function runInReloadTransaction(hmr, operation) {
  if (typeof hmr?.runExclusive !== 'function') return operation()
  let started = false
  try {
    return await hmr.runExclusive(() => {
      started = true
      return operation()
    })
  } catch (error) {
    if (!started && /cannot be nested/u.test(error?.message ?? '')) return operation()
    throw error
  }
}

/**
 * The composition for the profile this plugin runs in.
 * @param options - the plugin context (for `profileContext` and `hmr`), the
 *   web row's Loader entry, and where to look for the owning profile when the
 *   host does not name its patch file.
 * @returns the composition.
 */
export function createProfileSearchComposition({ ctx, webEntry, dshHome, ownPackageJsonUrl }) {
  return createSearchComposition({
    // The running profile names its own patch file; an older host does not,
    // so the install that owns this copy locates it instead.
    resolvePatchPath: async () => {
      const profile = ctx.get?.('profileContext')
      if (typeof profile?.patchPath === 'string' && profile.patchPath !== '') return profile.patchPath
      const install = await findInstall({ dshHome, ownPackageJsonUrl })
      return install.profile === undefined ? undefined : join(dshHome, 'profiles', install.profile, SEARCH_PATCH_FILE)
    },
    readBaseConfig: () => webEntry()?.options?.config ?? {},
    runExclusive: operation => runInReloadTransaction(ctx.get?.('hmr'), operation),
  })
}
