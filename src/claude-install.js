/**
 * Detecting, and installing, the local Claude Code CLI.
 *
 * Claude models on this route run through the official CLI, so the settings
 * panel shows whether this device has one (and which version), and offers to
 * install it with `npm install -g @anthropic-ai/claude-code` — the same command
 * on macOS and Windows. Installation runs on the host, never in a shell built
 * from user text: npm's arguments are constants.
 *
 * @module dsh-geek2api/claude-install
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import {
  CLAUDE_NPM_PACKAGE,
  DEFAULT_CLAUDE_CONFIG_DIR,
  claudeFileNames,
  locateClaudeBinary,
  resolveSpawnCommand,
} from './claude-cli.js'
import { nvmBinDirs, pathFor, searchPath, withProgramDirOnPath } from './locate.js'

export const CLAUDE_INSTALL_COMMAND = `npm install -g ${CLAUDE_NPM_PACKAGE}`

const INSTALL_ARGS = Object.freeze(['install', '-g', CLAUDE_NPM_PACKAGE])
const PREFIX_ARGS = Object.freeze(['prefix', '-g'])
const VERSION_TIMEOUT_MS = 20_000
const PREFIX_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** A detection is reused this long; the panel's refresh and an install bypass it. */
const DETECTION_TTL_MS = 5 * 60 * 1000
const MAX_CAPTURE_CHARS = 64 * 1024
const DETAIL_LINES = 8
const DETAIL_CHARS = 800

/**
 * The version `claude --version` prints, e.g. `2.1.3 (Claude Code)`.
 * @param output - the command's stdout.
 * @returns the semantic version, or undefined.
 */
export function parseClaudeVersion(output) {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(typeof output === 'string' ? output : '')?.[1]
}

/** The last lines of a command's output, bounded for display. */
function detailOf(...texts) {
  const lines = texts
    .filter(text => typeof text === 'string')
    .join('\n')
    .split(/\r?\n/u)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  const tail = lines.slice(-DETAIL_LINES).join('\n')
  return tail.length > DETAIL_CHARS ? tail.slice(-DETAIL_CHARS) : tail
}

/**
 * Where npm usually lives, in the order tried after PATH.
 * @param options - platform, home, environment, the host's own Node, and a directory reader.
 * @returns absolute candidate paths.
 */
export function npmCandidates({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, readdir } = {}) {
  const path = pathFor(platform)
  const name = platform === 'win32' ? 'npm.cmd' : 'npm'
  const beside = typeof execPath === 'string' && execPath !== '' ? [path.join(path.dirname(execPath), name)] : []
  if (platform === 'win32') {
    return [
      ...beside,
      ...(env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, name)] : []),
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', name),
    ]
  }
  return [
    ...beside,
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    path.join(home, '.volta', 'bin', 'npm'),
    ...nvmBinDirs({ home, env, platform, readdir }).map(directory => path.join(directory, 'npm')),
  ]
}

/**
 * Locate npm: PATH first (the one the user's terminal runs), then the usual places.
 * @param options - as {@link npmCandidates}, plus an existence check.
 * @returns an absolute path, or undefined.
 */
export function locateNpm({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, exists = existsSync, readdir } = {}) {
  const onPath = searchPath(platform === 'win32' ? ['npm.cmd'] : ['npm'], { platform, env, exists })
  if (onPath !== undefined) return onPath
  return npmCandidates({ platform, home, env, execPath, readdir }).find(candidate => exists(candidate))
}

/**
 * Classify an npm failure so the panel can say what to do about it.
 * @param result - the captured npm run.
 * @returns `{ code, detail }`.
 */
export function explainNpmFailure(result) {
  const detail = detailOf(result?.error?.message, result?.stderr, result?.stdout)
  if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/iu.test(detail)) return { code: 'permission', detail }
  if (/\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|network/iu.test(detail)) return { code: 'network', detail }
  if (/timed out after/iu.test(detail)) return { code: 'timeout', detail }
  return { code: 'failed', detail: detail === '' ? `npm exited with code ${result?.code ?? 'unknown'}` : detail }
}

/**
 * Run a command to completion and capture its output. Never rejects: a
 * missing program or a timeout comes back as `error`.
 */
function runCaptured(spawnImpl, command, args, options, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = spawnImpl(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = outcome => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, ...outcome })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish({ code: null, error: new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`) })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      stdout = (stdout + String(chunk)).slice(-MAX_CAPTURE_CHARS)
    })
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-MAX_CAPTURE_CHARS)
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => finish({ code, error: undefined }))
  })
}

/**
 * The CLI manager behind the settings panel and the runner.
 * @param options - the configured CLI path (a function, so a settings change
 *   applies without a restart), plus platform, environment, and process seams.
 * @returns `{ binary, detect, install, status }`.
 */
export function createClaudeCliManager({
  explicitPath = () => '',
  platform = process.platform,
  home = homedir(),
  env = process.env,
  execPath = process.execPath,
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  spawnImpl = spawn,
  exists = existsSync,
  readFile = file => readFileSync(file, 'utf8'),
  readdir,
  now = () => Date.now(),
} = {}) {
  const path = pathFor(platform)
  const configured = () => {
    const value = explicitPath()
    return typeof value === 'string' ? value.trim() : ''
  }
  const locateOptions = () => ({ platform, home, env, exists, readdir })
  const npm = () => locateNpm({ ...locateOptions(), execPath })

  /**
   * Run npm. On Windows npm is a `.cmd` launcher, which Node starts only
   * through `cmd.exe`; that is safe here because every argument is a constant.
   */
  const runNpm = (program, args, timeoutMs) => runCaptured(
    spawnImpl,
    platform === 'win32' ? `"${program}"` : program,
    args,
    { env: withProgramDirOnPath(env, program, platform), shell: platform === 'win32' },
    timeoutMs,
  )

  /** npm's global bin directory, read once; a GUI PATH often lacks it. */
  let globalBin
  const npmGlobalBin = async () => {
    if (globalBin !== undefined) return globalBin === '' ? undefined : globalBin
    const program = npm()
    if (program === undefined) return undefined
    const result = await runNpm(program, PREFIX_ARGS, PREFIX_TIMEOUT_MS)
    const prefix = result.code === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? '' : ''
    globalBin = prefix === '' ? '' : (platform === 'win32' ? prefix : path.join(prefix, 'bin'))
    return globalBin === '' ? undefined : globalBin
  }

  const locate = async () => {
    const found = locateClaudeBinary({ explicit: configured(), ...locateOptions() })
    if (found !== undefined || configured() !== '') return found
    const bin = await npmGlobalBin()
    if (bin === undefined) return undefined
    return claudeFileNames(platform).map(name => path.join(bin, name)).find(candidate => exists(candidate))
  }

  const probe = async () => {
    const found = await locate()
    if (found === undefined) {
      return configured() === ''
        ? { installed: false }
        : { installed: false, configuredPath: configured() }
    }
    let command
    try {
      command = resolveSpawnCommand(found, { platform, exists, readFile })
    } catch (error) {
      return { installed: true, path: found, error: error.message }
    }
    const result = await runCaptured(spawnImpl, command.command, [...command.args, '--version'], {
      env: {
        ...withProgramDirOnPath(env, found, platform),
        CLAUDE_CONFIG_DIR: configDir,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    }, VERSION_TIMEOUT_MS)
    const version = result.code === 0 ? parseClaudeVersion(result.stdout) : undefined
    if (version !== undefined) return { installed: true, path: found, version }
    return {
      installed: true,
      path: found,
      error: detailOf(result.error?.message, result.stderr, result.stdout) || `exited with code ${result.code ?? 'unknown'}`,
    }
  }

  let detection
  let detecting
  const detect = async ({ force = false } = {}) => {
    if (!force && detection !== undefined && now() - detection.checkedAt < DETECTION_TTL_MS) return detection
    if (detecting !== undefined) return detecting
    detecting = probe()
      .catch(error => ({ installed: false, error: error instanceof Error ? error.message : String(error) }))
      .then(value => {
        detection = { ...value, checkedAt: now() }
        return detection
      })
      .finally(() => {
        detecting = undefined
      })
    return detecting
  }

  let installation = { state: 'idle' }
  let installing

  const install = () => {
    if (installing !== undefined) return installation
    const program = npm()
    if (program === undefined) {
      installation = { state: 'failed', code: 'npm-missing', finishedAt: now() }
      return installation
    }
    installation = { state: 'running', startedAt: now(), npm: program }
    installing = runNpm(program, INSTALL_ARGS, INSTALL_TIMEOUT_MS)
      .then(async result => {
        // npm may have just created its global directory; read it again.
        globalBin = undefined
        if (result.code !== 0) {
          installation = { state: 'failed', ...explainNpmFailure(result), finishedAt: now() }
          await detect({ force: true })
          return
        }
        const found = await detect({ force: true })
        installation = found.installed && found.version !== undefined
          ? { state: 'succeeded', finishedAt: now() }
          : { state: 'failed', code: 'not-found-after-install', detail: detailOf(result.stdout, result.stderr), finishedAt: now() }
      })
      .catch(error => {
        installation = { state: 'failed', code: 'failed', detail: error instanceof Error ? error.message : String(error), finishedAt: now() }
      })
      .finally(() => {
        installing = undefined
      })
    return installation
  }

  return Object.freeze({
    /**
     * The CLI the runner should start: the last detected one while it still
     * exists, otherwise a fresh lookup — so a CLI installed after startup,
     * from the panel or a terminal, is used without restarting.
     */
    async binary() {
      if (detection?.path !== undefined && exists(detection.path)) return detection.path
      const found = await locate()
      return found ?? (configured() === '' ? 'claude' : configured())
    },
    detect,
    install,
    /** Wait for an install in flight; for tests and scripts. */
    settled: () => installing ?? Promise.resolve(),
    /**
     * What the settings panel shows. While an install runs, the last detection
     * stands instead of probing a half-written package.
     */
    async status({ force = false } = {}) {
      const value = installing === undefined ? await detect({ force }) : detection
      return {
        installed: value?.installed === true,
        ...(value?.version === undefined ? {} : { version: value.version }),
        ...(value?.path === undefined ? {} : { path: value.path }),
        ...(value?.configuredPath === undefined ? {} : { configuredPath: value.configuredPath }),
        ...(value?.error === undefined ? {} : { error: value.error }),
        ...(value?.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
        platform,
        command: CLAUDE_INSTALL_COMMAND,
        install: { ...installation },
      }
    },
  })
}
