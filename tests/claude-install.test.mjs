import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  CLAUDE_MISSING_MESSAGE,
  claudeBinaryCandidates,
  createClaudeRunner,
  locateClaudeBinary,
  resolveSpawnCommand,
} from '../src/claude-cli.js'
import {
  CLAUDE_INSTALL_COMMAND,
  createClaudeCliManager,
  explainNpmFailure,
  locateNpm,
  parseClaudeVersion,
} from '../src/claude-install.js'
import { searchPath, withProgramDirOnPath } from '../src/locate.js'
import { createGeek2APIRpc } from '../src/rpc.js'

/** A file system made of the listed paths. */
const filesystem = paths => {
  const set = new Set(paths)
  return { set, exists: candidate => set.has(candidate) }
}

/**
 * A spawn stand-in: `respond(command, args, options)` returns what the child
 * prints and how it exits, or `{ error }` for a program that cannot start.
 */
function scriptedSpawn(respond) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    const outcome = respond(command, args, options) ?? {}
    queueMicrotask(() => {
      if (outcome.error !== undefined) {
        child.emit('error', outcome.error)
        return
      }
      outcome.effect?.()
      if (outcome.stdout) child.stdout.emit('data', outcome.stdout)
      if (outcome.stderr) child.stderr.emit('data', outcome.stderr)
      child.exitCode = outcome.code ?? 0
      child.emit('close', outcome.code ?? 0, null)
    })
    return child
  }
  return { spawnImpl, calls }
}

const MAC = { platform: 'darwin', home: '/Users/u', readdir: () => [] }
const WIN = {
  platform: 'win32',
  home: 'C:\\Users\\u',
  env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs' },
}

/** The launcher npm's cmd-shim writes for a JavaScript bin. */
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`

test('reads the version claude --version prints', () => {
  assert.equal(parseClaudeVersion('2.1.3 (Claude Code)\n'), '2.1.3')
  assert.equal(parseClaudeVersion('1.0.0-beta.2 (Claude Code)'), '1.0.0-beta.2')
  assert.equal(parseClaudeVersion('command not found'), undefined)
  assert.equal(parseClaudeVersion(undefined), undefined)
})

test('finds the CLI where each platform installs it', () => {
  // macOS: the native installer wins over an nvm-installed npm copy.
  const mac = filesystem(['/Users/u/.local/bin/claude', '/Users/u/.nvm/versions/node/v22.1.0/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, env: {}, exists: mac.exists }), '/Users/u/.local/bin/claude')
  // nvm versions are tried newest first.
  const nvm = filesystem(['/Users/u/.nvm/versions/node/v9.0.0/bin/claude', '/Users/u/.nvm/versions/node/v20.3.1/bin/claude'])
  assert.equal(
    locateClaudeBinary({ ...MAC, env: {}, exists: nvm.exists, readdir: () => ['v9.0.0', 'v20.3.1', 'not-a-version'] }),
    '/Users/u/.nvm/versions/node/v20.3.1/bin/claude',
  )
  // Windows: npm's launcher under %APPDATA%\npm.
  const win = filesystem(['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'])
  assert.equal(locateClaudeBinary({ ...WIN, exists: win.exists }), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd')
  assert.ok(claudeBinaryCandidates(WIN).includes('C:\\Users\\u\\.local\\bin\\claude.exe'))
  // Nothing installed anywhere.
  assert.equal(locateClaudeBinary({ ...MAC, env: { PATH: '/usr/bin' }, exists: () => false }), undefined)
})

test('PATH is searched with the platform rules, including Windows Path spelling', () => {
  const win = filesystem(['D:\\tools\\claude.exe'])
  assert.equal(searchPath(['claude.exe', 'claude.cmd'], { platform: 'win32', env: { Path: 'C:\\x;"D:\\tools"' }, exists: win.exists }), 'D:\\tools\\claude.exe')
  const mac = filesystem(['/opt/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, env: { PATH: '/usr/bin:/opt/bin' }, exists: mac.exists }), '/opt/bin/claude')
})

test('a configured path wins when it exists and reports absence when it does not', () => {
  const fs = filesystem(['/custom/claude', '/Users/u/.local/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, explicit: '/custom/claude', env: {}, exists: fs.exists }), '/custom/claude')
  assert.equal(locateClaudeBinary({ ...MAC, explicit: '/missing/claude', env: {}, exists: fs.exists }), undefined)
})

test('a Windows npm launcher is started through the program it forwards to, never a shell', () => {
  const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
  const cli = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  const fs = filesystem([shim, cli])
  assert.deepEqual(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => JS_SHIM }), { command: 'node', args: [cli] })

  // A node.exe beside the launcher is the one npm itself would use.
  fs.set.add('C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe')
  assert.equal(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => JS_SHIM }).command, 'C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe')

  // A package that ships a native binary: the launcher points at the .exe.
  const exe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  fs.set.add(exe)
  const nativeShim = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  assert.deepEqual(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => nativeShim }), { command: exe, args: [] })

  // A launcher whose program is gone asks for a reinstall instead of failing obscurely.
  assert.throws(() => resolveSpawnCommand(shim, { platform: 'win32', exists: candidate => candidate === shim, readFile: () => JS_SHIM }), /reinstall/u)

  // Everything else starts as is.
  assert.deepEqual(resolveSpawnCommand('C:\\Users\\u\\.local\\bin\\claude.exe', { platform: 'win32' }), { command: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: [] })
  assert.deepEqual(resolveSpawnCommand('/usr/local/bin/claude', { platform: 'darwin' }), { command: '/usr/local/bin/claude', args: [] })
})

test('the program directory joins PATH so a node launcher finds node', () => {
  assert.equal(withProgramDirOnPath({ PATH: '/usr/bin' }, '/opt/homebrew/bin/claude', 'darwin').PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(withProgramDirOnPath({ PATH: '/opt/homebrew/bin' }, '/opt/homebrew/bin/claude', 'darwin').PATH, '/opt/homebrew/bin')
  assert.equal(withProgramDirOnPath({ Path: 'C:\\Windows' }, 'C:\\npm\\npm.cmd', 'win32').Path, 'C:\\npm;C:\\Windows')
  assert.equal(withProgramDirOnPath({ PATH: '/usr/bin' }, 'claude', 'darwin').PATH, '/usr/bin')
})

test('finds npm on PATH first, then beside the host Node and in the usual places', () => {
  const fs = filesystem(['/usr/bin/npm', '/opt/homebrew/bin/npm'])
  assert.equal(locateNpm({ ...MAC, env: { PATH: '/usr/bin' }, execPath: '/x/node', exists: fs.exists }), '/usr/bin/npm')
  assert.equal(locateNpm({ ...MAC, env: { PATH: '' }, execPath: '/x/node', exists: fs.exists }), '/opt/homebrew/bin/npm')
  const win = filesystem(['C:\\Program Files\\nodejs\\npm.cmd'])
  assert.equal(locateNpm({ ...WIN, env: { Path: 'C:\\Windows' }, execPath: 'C:\\app\\dsh.exe', exists: win.exists }), 'C:\\Program Files\\nodejs\\npm.cmd')
  assert.equal(locateNpm({ ...MAC, env: {}, execPath: '/x/node', exists: () => false }), undefined)
})

test('an npm failure is classified so the panel can say what to do', () => {
  assert.equal(explainNpmFailure({ code: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir' }).code, 'permission')
  assert.equal(explainNpmFailure({ code: 1, stderr: 'npm error code EPERM' }).code, 'permission')
  assert.equal(explainNpmFailure({ code: 1, stderr: 'npm error code ENOTFOUND' }).code, 'network')
  assert.equal(explainNpmFailure({ code: null, error: new Error('timed out after 900s') }).code, 'timeout')
  const other = explainNpmFailure({ code: 7, stderr: '' })
  assert.deepEqual(other, { code: 'failed', detail: 'npm exited with code 7' })
})

test('detects an installed CLI and its version', async () => {
  const fs = filesystem(['/Users/u/.local/bin/claude'])
  const { spawnImpl, calls } = scriptedSpawn(() => ({ stdout: '2.1.3 (Claude Code)\n' }))
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl, configDir: '/tmp/cfg' })
  const status = await cli.status()
  assert.equal(status.installed, true)
  assert.equal(status.version, '2.1.3')
  assert.equal(status.path, '/Users/u/.local/bin/claude')
  assert.equal(status.command, CLAUDE_INSTALL_COMMAND)
  assert.equal(status.install.state, 'idle')
  assert.deepEqual(calls[0].args, ['--version'])
  // The probe runs in the plugin's isolated config home, never the user's.
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/tmp/cfg')
  assert.equal(calls[0].options.shell, undefined)

  // A cached read does not spawn again; a forced one does.
  await cli.status()
  assert.equal(calls.length, 1)
  await cli.status({ force: true })
  assert.equal(calls.length, 2)
  assert.equal(await cli.binary(), '/Users/u/.local/bin/claude')
})

test('a CLI that is found but cannot run is reported with its output', async () => {
  const fs = filesystem(['/Users/u/.local/bin/claude'])
  const { spawnImpl } = scriptedSpawn(() => ({ code: 127, stderr: 'env: node: No such file or directory' }))
  const cli = createClaudeCliManager({ ...MAC, env: {}, exists: fs.exists, spawnImpl })
  const status = await cli.status()
  assert.equal(status.installed, true)
  assert.equal(status.version, undefined)
  assert.match(status.error, /env: node/u)
})

test('without a CLI anywhere it asks npm for its global bin before giving up', async () => {
  const fs = filesystem(['/usr/bin/npm', '/Users/u/.npm-prefix/bin/claude'])
  const { spawnImpl, calls } = scriptedSpawn((command, args) => {
    if (command === '/usr/bin/npm' && args.join(' ') === 'prefix -g') return { stdout: '/Users/u/.npm-prefix\n' }
    if (args[0] === '--version') return { stdout: '2.0.0 (Claude Code)' }
    return { code: 1 }
  })
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl })
  const status = await cli.status()
  assert.equal(status.path, '/Users/u/.npm-prefix/bin/claude')
  assert.equal(status.version, '2.0.0')
  // npm runs with its own directory on PATH so its `env node` resolves.
  assert.match(calls[0].options.env.PATH, /^\/usr\/bin/u)

  fs.set.delete('/Users/u/.npm-prefix/bin/claude')
  const missing = await cli.status({ force: true })
  assert.equal(missing.installed, false)
  assert.equal(await cli.binary(), 'claude', 'the runner then reports the CLI as missing')
})

test('installs with npm install -g and detects the result', async () => {
  const fs = filesystem(['/usr/bin/npm'])
  const { spawnImpl, calls } = scriptedSpawn((command, args) => {
    if (args.join(' ') === 'prefix -g') return { stdout: '/usr\n' }
    if (args.join(' ') === 'install -g @anthropic-ai/claude-code') {
      return { effect: () => fs.set.add('/usr/bin/claude'), stdout: 'added 3 packages in 4s\n' }
    }
    if (args[0] === '--version') return { stdout: '2.1.3 (Claude Code)\n' }
    return { code: 1 }
  })
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl })
  assert.equal((await cli.status()).installed, false)

  const started = cli.install()
  assert.equal(started.state, 'running')
  assert.equal(cli.install().state, 'running', 'a second click joins the install in flight')
  assert.equal((await cli.status()).install.state, 'running')
  await cli.settled()

  const status = await cli.status()
  assert.equal(status.install.state, 'succeeded')
  assert.equal(status.installed, true)
  assert.equal(status.version, '2.1.3')
  assert.equal(calls.filter(call => call.args.join(' ') === 'install -g @anthropic-ai/claude-code').length, 1)
  assert.equal(calls.find(call => call.args[0] === 'install').options.shell, false)
})

test('on Windows npm runs through its .cmd launcher with constant arguments', async () => {
  const npm = 'C:\\Program Files\\nodejs\\npm.cmd'
  const fs = filesystem([npm])
  const { spawnImpl, calls } = scriptedSpawn(() => ({ code: 1, stderr: 'npm error code EPERM\nnpm error syscall rename' }))
  const cli = createClaudeCliManager({ ...WIN, execPath: 'C:\\app\\dsh.exe', exists: fs.exists, spawnImpl })
  cli.install()
  await cli.settled()
  const call = calls.find(entry => entry.args[0] === 'install')
  assert.equal(call.command, `"${npm}"`)
  assert.deepEqual(call.args, ['install', '-g', '@anthropic-ai/claude-code'])
  assert.equal(call.options.shell, true)
  const status = await cli.status()
  assert.equal(status.platform, 'win32')
  assert.equal(status.install.state, 'failed')
  assert.equal(status.install.code, 'permission')
  assert.match(status.install.detail, /EPERM/u)
})

test('without npm the install fails at once and says why', async () => {
  const { spawnImpl, calls } = scriptedSpawn(() => ({ code: 1 }))
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '' }, execPath: '/x/node', exists: () => false, spawnImpl })
  const result = cli.install()
  assert.equal(result.state, 'failed')
  assert.equal(result.code, 'npm-missing')
  assert.equal(calls.length, 0)
})

test('a runner whose CLI is missing says to install it', async () => {
  const { spawnImpl } = scriptedSpawn(() => ({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }))
  const runner = createClaudeRunner({
    binary: async () => 'claude',
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), error => error.message === CLAUDE_MISSING_MESSAGE)
})

test('a runner on Windows starts the program behind the npm launcher', async () => {
  const shim = 'C:\\npm\\claude.cmd'
  const { spawnImpl, calls } = scriptedSpawn(() => ({ stdout: `${JSON.stringify({ is_error: false, result: 'ok' })}\n` }))
  const runner = createClaudeRunner({
    binary: async () => shim,
    resolveCredential: async () => ({ baseUrl: 'https://hk.geek2api.com', token: 'sk-k' }),
    spawnImpl,
    platform: 'win32',
  })
  // The real launcher is read from disk; this one does not exist, so the
  // runner refuses before spawning instead of handing argv to cmd.exe.
  await assert.rejects(() => runner.run({ prompt: 'x' }), /reinstall/u)
  assert.equal(calls.length, 0)
})

test('the RPC surface reports and starts the CLI install', async () => {
  const seen = []
  const claudeCli = {
    status: async options => {
      seen.push(['status', options])
      return { installed: false, command: CLAUDE_INSTALL_COMMAND, install: { state: seen.some(([kind]) => kind === 'install') ? 'running' : 'idle' } }
    },
    install: () => {
      seen.push(['install'])
      return { state: 'running' }
    },
  }
  const handler = createGeek2APIRpc({ ring: {}, balance: {}, hosts: () => ({}), preference: {}, claudeCli })
  const status = await handler('claude-cli/status', { force: true })
  assert.equal(status.ok, true)
  assert.equal(status.value.installed, false)
  assert.deepEqual(seen[0], ['status', { force: true }])
  const installed = await handler('claude-cli/install', {})
  assert.equal(installed.value.install.state, 'running')

  const without = createGeek2APIRpc({ ring: {}, balance: {}, hosts: () => ({}), preference: {} })
  const refused = await without('claude-cli/status', {})
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /unavailable/u)
})
