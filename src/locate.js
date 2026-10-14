/**
 * Finding programs on macOS, Linux, and Windows.
 *
 * A desktop app launched from Finder or the Start menu inherits a much shorter
 * PATH than a terminal, so a lookup that trusts PATH alone misses an npm or
 * Claude Code install the user can run from their shell. These helpers walk
 * PATH the way the platform's own shell would, and know the usual install
 * directories it may lack.
 *
 * @module dsh-geek2api/locate
 */

import { existsSync, readdirSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** The path flavour of `platform`, so a Windows layout is testable on macOS. */
export const pathFor = platform => (platform === 'win32' ? win32 : posix)

const listDirectory = directory => {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/** The environment's PATH key: Windows spells it `Path` and compares case-insensitively. */
export function pathKey(env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env ?? {}).find(name => name.toUpperCase() === 'PATH') ?? 'Path'
}

/** Numeric `vX.Y.Z` ordering, newest first, for nvm's per-version directories. */
function newestFirst(a, b) {
  const parts = value => value.replace(/^v/u, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * The `bin` directories of every Node version nvm installed, newest first.
 * @param options - home directory, environment, and a directory reader.
 * @returns absolute directories; empty when nvm is absent.
 */
export function nvmBinDirs({ home, env = process.env, platform = process.platform, readdir = listDirectory } = {}) {
  if (platform === 'win32') return []
  const path = pathFor(platform)
  const root = path.join(env.NVM_DIR ?? path.join(home, '.nvm'), 'versions', 'node')
  return readdir(root)
    .filter(name => /^v\d/u.test(name))
    .sort(newestFirst)
    .map(name => path.join(root, name, 'bin'))
}

/**
 * Look a program up on PATH.
 * @param names - file names to try in each directory, in order (on Windows
 *   pass the real file names, e.g. `claude.exe` and `claude.cmd`).
 * @param options - platform, environment, and an existence check.
 * @returns the first existing absolute path, or undefined.
 */
export function searchPath(names, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const path = pathFor(platform)
  const value = env?.[pathKey(env, platform)]
  if (typeof value !== 'string' || value === '') return undefined
  for (const raw of value.split(platform === 'win32' ? ';' : ':')) {
    const directory = raw.trim().replace(/^"(.*)"$/u, '$1')
    if (directory === '') continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * An environment whose PATH starts with the directory a program lives in.
 *
 * npm's and the npm-installed CLI's launchers start with `#!/usr/bin/env node`,
 * and nvm, Homebrew, and the official installers put `node` beside them; a
 * GUI-launched host whose PATH lacks that directory would otherwise fail with
 * `env: node: No such file or directory`.
 * @param env - the environment to extend; not modified.
 * @param program - the program's path; a bare name leaves PATH alone.
 * @param platform - which path rules apply.
 * @returns a new environment.
 */
export function withProgramDirOnPath(env, program, platform = process.platform) {
  const path = pathFor(platform)
  if (typeof program !== 'string' || !path.isAbsolute(program)) return { ...env }
  const key = pathKey(env, platform)
  const separator = platform === 'win32' ? ';' : ':'
  const directory = path.dirname(program)
  const current = typeof env?.[key] === 'string' ? env[key] : ''
  const entries = current.split(separator).filter(entry => entry !== '')
  if (entries.includes(directory)) return { ...env }
  return { ...env, [key]: [directory, ...entries].join(separator) }
}
