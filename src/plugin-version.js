/**
 * Version self-knowledge for the settings panel.
 *
 * The running version comes from this package. The latest version comes from
 * the Geek2API mirror first — every entry point serves `/dsh/latest.json` and
 * the packed tarballs, synced from GitHub, because GitHub release downloads
 * are unreachable from mainland networks — and from the GitHub releases of
 * this repository when no mirror answers. An
 * in-place update is offered for an install from a release tarball (or the
 * npm registry), and it installs that exact tarball with the host's own pnpm
 * — never through `dsh plugin --profile desktop`, which the desktop app
 * refuses. Release bodies and package-manager output stay host-side.
 *
 * @module dsh-geek2api/plugin-version
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCachedRead } from './cached-read.js'
import { ambientFetch, boundedFetch } from './request.js'

export { ambientFetch, waitForSharedRequest } from './request.js'

export const PACKAGE_NAME = 'dsh-geek2api'
export const GITHUB_REPOSITORY = 'CoderKuo/dsh-geek2api'
export const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`
/** The tarball asset a release must carry for an in-place update. */
export const releaseAssetName = version => `${PACKAGE_NAME}-${version}.tgz`
/** Where every Geek2API entry point serves the mirrored releases. */
export const MIRROR_PATH = '/dsh'

/**
 * Normalize the mirror's `latest.json` as served by one entry point.
 * @param payload - the manifest body.
 * @param host - the entry point that served it.
 * @returns `{ version, tarballUrl, releaseUrl }`, or undefined when unusable.
 */
export function parseMirrorManifest(payload, host) {
  if (payload === null || typeof payload !== 'object' || typeof host !== 'string') return undefined
  const version = typeof payload.version === 'string' ? payload.version : undefined
  if (parseSemver(version) === undefined || payload.tarball !== releaseAssetName(version)) return undefined
  const releaseUrl = typeof payload.releaseUrl === 'string' && /^https:\/\/github\.com\//u.test(payload.releaseUrl) ? payload.releaseUrl : undefined
  return { version, tarballUrl: `${host}${MIRROR_PATH}/${payload.tarball}`, ...(releaseUrl === undefined ? {} : { releaseUrl }) }
}
export const DEFAULT_VERSION_TTL_MS = 5 * 60_000
export const DEFAULT_VERSION_TIMEOUT_MS = 10_000
export const DEFAULT_UPDATE_TIMEOUT_MS = 180_000
export const DEFAULT_SETTLE_DELAY_MS = 250
/** Zero minutes: install the exact requested version regardless of its age. */
export const UPDATE_RELEASE_AGE_MINUTES = 0

/** Parse a strict `x.y.z[-pre][+build]` version; anything else is undefined. */
export function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] }
}

/** Compare two versions: -1/0/1, or undefined when either side is not semver. */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * Classify how the running package reached the profile. Registry specs and
 * packed tarballs (a release download, or a local `.tgz`) may be updated in
 * place; local checkouts belong to the owner's iteration.
 */
export function classifySpec(spec) {
  if (typeof spec !== 'string' || spec === '') return 'unknown'
  if (/\.tgz(?:[?#].*)?$/iu.test(spec) && /^(?:https:\/\/|file:)/iu.test(spec)) return 'release'
  if (/^(?:link|file):/u.test(spec)) return 'link'
  if (/^(?:\d|[~^*])/u.test(spec)) return 'npm'
  return 'unknown'
}

/** Install kinds the panel may update in place. */
export const UPDATABLE_KINDS = Object.freeze(['npm', 'release'])

/**
 * Normalize a GitHub "latest release" body.
 * @param payload - the API body.
 * @returns `{ version, tarballUrl, releaseUrl }`, or undefined when unusable.
 */
export function parseLatestRelease(payload) {
  if (payload === null || typeof payload !== 'object' || payload.draft === true || payload.prerelease === true) return undefined
  const version = typeof payload.tag_name === 'string' ? payload.tag_name.replace(/^v/u, '') : undefined
  if (parseSemver(version) === undefined) return undefined
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find(item => item?.name === releaseAssetName(version) && typeof item.browser_download_url === 'string')
    : undefined
  const tarballUrl = asset !== undefined && /^https:\/\/github\.com\//u.test(asset.browser_download_url) ? asset.browser_download_url : undefined
  const releaseUrl = typeof payload.html_url === 'string' && /^https:\/\/github\.com\//u.test(payload.html_url) ? payload.html_url : undefined
  return { version, ...(tarballUrl === undefined ? {} : { tarballUrl }), ...(releaseUrl === undefined ? {} : { releaseUrl }) }
}

const readManifest = async path => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * A zero exit only proves the command ran. pnpm can skip a too-new version
 * and still exit zero, so the landed manifest is what makes the answer true.
 */
async function confirmInstalled({ profileDir, expected, settleDelayMs, attempts = 3 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const installed = (await readManifest(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json')))?.version
    if (installed === expected) return
    if (attempt < attempts) await new Promise(resolve => { setTimeout(resolve, settleDelayMs) })
  }
  throw new Error('Geek2API plugin update did not install the requested version')
}

/**
 * Find the profile that owns this running installation. pnpm symlinks resolve
 * to the same realpath on both sides. When no realpath matches, fall back to
 * the only profile that declares the dependency at all.
 */
export async function findInstall({ dshHome, ownPackageJsonUrl }) {
  let ownReal
  try {
    ownReal = await realpath(fileURLToPath(ownPackageJsonUrl))
  } catch {
    ownReal = undefined
  }
  let entries = []
  try {
    entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
  } catch {
    entries = []
  }
  const declared = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileDir = join(dshHome, 'profiles', entry.name)
    const spec = (await readManifest(join(profileDir, 'package.json')))?.dependencies?.[PACKAGE_NAME]
    if (typeof spec !== 'string') continue
    declared.push({ profile: entry.name, spec })
    if (ownReal === undefined) continue
    try {
      const installed = await realpath(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'))
      if (installed === ownReal) return { kind: classifySpec(spec), profile: entry.name }
    } catch {
      // Declared, but not resolvable in this profile.
    }
  }
  if (declared.length === 1) return { kind: classifySpec(declared[0].spec), profile: declared[0].profile }
  return { kind: 'unknown' }
}

const isExistingPath = value => typeof value === 'string' && value !== '' && existsSync(value)

/** Anchored to the file name so a directory that merely contains the word cannot match. */
const PNPM_SCRIPT = /[\\/]pnpm\.(?:mjs|cjs|js)$/u

const dshRuntimeRoot = value => (isExistingPath(value)
  && existsSync(join(value, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  ? value
  : undefined)

/**
 * Locate the package manager that owns this profile.
 *
 * `dsh plugin --profile desktop` is refused by the desktop app, so the update
 * installs with pnpm directly. The desktop host puts the bundled pnpm in its
 * own arguments; nothing is guessed from the entry script.
 */
export function resolvePnpm({ argv } = {}) {
  const entries = Array.isArray(argv) ? argv : []
  for (const entry of entries) {
    if (isExistingPath(entry) && PNPM_SCRIPT.test(entry)) return entry
  }
  for (const entry of entries) {
    const root = dshRuntimeRoot(entry)
    if (root === undefined) continue
    const script = join(root, '..', 'pnpm', 'bin', 'pnpm.mjs')
    if (existsSync(script)) return script
  }
  return undefined
}

function resolveLauncher({ argv, execPath }) {
  const pnpm = resolvePnpm({ argv })
  if (pnpm === undefined) return { command: 'pnpm', prefix: [] }
  return { command: execPath, prefix: [pnpm] }
}

/** Run pnpm host-side. Its output is never returned to the browser. */
function spawnRunCommand({ command, args, cwd }, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Geek2API plugin update aborted'))
      return
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Geek2API plugin update timed out')), timeoutMs)
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
        ...(cwd === undefined ? {} : { cwd }),
      })
    } catch (error) {
      settle(reject, error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-8192) })
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.on('error', error => settle(reject, error))
    child.on('close', code => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        settle(reject, reason instanceof Error ? reason : new Error('Geek2API plugin update aborted'))
        return
      }
      settle(resolve, { code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * The running version, the latest registry version, which profile installed
 * this copy, and registry-spec updates against that profile.
 */
export function createGeek2APIPluginManager({
  fetchImpl = ambientFetch,
  runCommand = spawnRunCommand,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  ownPackageJsonUrl = new URL('../package.json', import.meta.url),
  releaseUrl = GITHUB_LATEST_RELEASE_URL,
  hosts,
  now = Date.now,
  ttlMs = DEFAULT_VERSION_TTL_MS,
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  updateTimeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Geek2API plugin manager requires fetch')
  if (typeof runCommand !== 'function') throw new Error('Geek2API plugin manager requires runCommand')
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  const launcher = resolveLauncher({ argv, execPath })
  let updating = false

  /**
   * The newest release from the mirror, through the entry point the pool
   * prefers. Undefined when no entry point serves a usable manifest.
   */
  const fetchFromMirror = async signal => {
    if (typeof hosts?.withFailover !== 'function') return undefined
    try {
      return await hosts.withFailover(async host => {
        const response = await boundedFetch(`${host}${MIRROR_PATH}/latest.json`, { headers: { Accept: 'application/json' } }, { fetchImpl, timeoutMs, signal })
        if (!response.ok) return undefined
        return parseMirrorManifest(await response.json(), host)
      }, { signal })
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  /** The newest release: mirror first, then GitHub. */
  const fetchLatest = async signal => (await fetchFromMirror(signal)) ?? fetchFromGitHub(signal)

  /** The newest GitHub release: its version, tarball asset, and page. */
  const fetchFromGitHub = async signal => {
    let response
    try {
      response = await boundedFetch(releaseUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': PACKAGE_NAME, 'X-GitHub-Api-Version': '2022-11-28' },
      }, { fetchImpl, timeoutMs, signal })
    } catch (error) {
      if (error.aborted) throw error.cause
      throw new Error('Geek2API plugin version check failed')
    }
    if (!response.ok) throw new Error('Geek2API plugin version check failed')
    let release
    try {
      release = parseLatestRelease(await response.json())
    } catch {
      release = undefined
    }
    if (release === undefined) throw new Error('Geek2API plugin version check failed')
    return release
  }

  const readOwnVersion = async () => {
    const version = (await readManifest(fileURLToPath(ownPackageJsonUrl)))?.version
    if (parseSemver(version) === undefined) throw new Error('Geek2API plugin version is unavailable')
    return version
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const [current, install, latest] = await Promise.all([
      readOwnVersion(),
      findInstall({ dshHome, ownPackageJsonUrl }),
      fetchLatest(signal),
    ])
    return {
      current,
      latest: latest.version,
      ...(latest.releaseUrl === undefined ? {} : { releaseUrl: latest.releaseUrl }),
      updateAvailable: compareSemver(latest.version, current) === 1,
      updatable: latest.tarballUrl !== undefined && UPDATABLE_KINDS.includes(install.kind),
      install,
      fetchedAt: now(),
    }
  }

  const cache = createCachedRead(load, { ttlMs, now })

  return Object.freeze({
    read: options => cache.read(options),

    async update({ signal } = {}) {
      signal?.throwIfAborted()
      if (updating) throw new Error('Geek2API plugin update is already running')
      updating = true
      try {
        const install = await findInstall({ dshHome, ownPackageJsonUrl })
        if (install.kind === 'link') throw new Error('Geek2API plugin is installed from a local checkout')
        if (!UPDATABLE_KINDS.includes(install.kind) || install.profile === undefined) {
          throw new Error('Geek2API plugin update could not find the owning profile')
        }
        const latest = await fetchLatest(signal)
        if (latest.tarballUrl === undefined) throw new Error('Geek2API plugin release has no package to install')
        const profileDir = join(dshHome, 'profiles', install.profile)
        let result
        try {
          result = await runCommand({
            command: launcher.command,
            args: [
              ...launcher.prefix,
              'add', `--config.minimumReleaseAge=${UPDATE_RELEASE_AGE_MINUTES}`,
              `${PACKAGE_NAME}@${latest.tarballUrl}`,
            ],
            cwd: profileDir,
          }, { signal, timeoutMs: updateTimeoutMs })
        } catch (error) {
          if (signal?.aborted) throw error
          throw new Error('Geek2API plugin update failed')
        }
        if (result.code !== 0) throw new Error('Geek2API plugin update failed')
        await confirmInstalled({ profileDir, expected: latest.version, settleDelayMs })
        cache.invalidate()
        return { version: latest.version, profile: install.profile }
      } finally {
        updating = false
      }
    },

    invalidate: () => cache.invalidate(),
  })
}
