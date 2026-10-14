import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  compareSemver,
  createGeek2APIPluginManager,
  NPM_REGISTRY_LATEST_URL,
  PACKAGE_NAME,
  parseSemver,
  resolvePnpm,
} from '../src/plugin-version.js'
import { createGeek2APIRpc } from '../src/rpc.js'

const writeManifest = async (path, manifest) => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(manifest))
}

/** Fake DSH home whose `web` profile installed the package from the registry. */
async function npmInstall(root, version = '1.0.3') {
  const installedDir = join(root, 'profiles', 'web', 'node_modules', PACKAGE_NAME)
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), {
    dependencies: { [PACKAGE_NAME]: version },
  })
  await writeManifest(join(installedDir, 'package.json'), { name: PACKAGE_NAME, version })
  return pathToFileURL(join(installedDir, 'package.json'))
}

/** Fake DSH home whose `web` profile links a local checkout. */
async function linkInstall(root, version = '1.0.3') {
  const checkout = join(root, 'checkout')
  await writeManifest(join(checkout, 'package.json'), { name: PACKAGE_NAME, version })
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), {
    dependencies: { [PACKAGE_NAME]: 'link:../../checkout' },
  })
  const modules = join(root, 'profiles', 'web', 'node_modules')
  await mkdir(modules, { recursive: true })
  await symlink(checkout, join(modules, PACKAGE_NAME), 'dir')
  return pathToFileURL(join(checkout, 'package.json'))
}

const registryOk = version => async () => ({ ok: true, status: 200, async json() { return { version } } })

const rpc = pluginManager => createGeek2APIRpc({
  ring: {},
  balance: {},
  hosts: () => ({}),
  preference: {},
  pluginManager,
})

test('semver parsing and comparison drive the update badge', () => {
  assert.deepEqual(parseSemver(' 1.0.3 '), { major: 1, minor: 0, patch: 3, pre: undefined })
  assert.equal(parseSemver('v1.0.3'), undefined)
  assert.equal(parseSemver('1.0'), undefined)
  assert.equal(compareSemver('1.0.3', '1.0.4'), -1)
  assert.equal(compareSemver('1.0.4', '1.0.3'), 1)
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareSemver('not-a-version', '1.0.3'), undefined)
})

test('version check asks the registry for an uncompressed document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-encoding-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const original = globalThis.fetch
  let acceptEncoding
  globalThis.fetch = async (_url, init) => {
    acceptEncoding = new Headers(init?.headers).get('accept-encoding')
    if (acceptEncoding !== 'identity') {
      return { ok: true, status: 200, async json() { throw new SyntaxError('gzip body') } }
    }
    return { ok: true, status: 200, async json() { return { version: '1.0.3' } } }
  }
  try {
    const value = await createGeek2APIPluginManager({
      env: { DSH_HOME: root },
      ownPackageJsonUrl,
    }).read({ force: true })
    assert.equal(acceptEncoding, 'identity')
    assert.equal(value.latest, '1.0.3')
    assert.equal(value.updateAvailable, false)
  } finally {
    globalThis.fetch = original
  }
})

test('version read combines own manifest, registry latest, and the owning npm profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-npm-'))
  const ownPackageJsonUrl = await npmInstall(root)
  let requests = 0
  let observed
  let clock = 1000
  const manager = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    now: () => clock,
    fetchImpl: (url, init) => {
      requests += 1
      observed = { url, redirect: init.redirect }
      return registryOk('1.0.4')()
    },
  })
  const first = await manager.read()
  assert.deepEqual(first, {
    current: '1.0.3',
    latest: '1.0.4',
    updateAvailable: true,
    install: { kind: 'npm', profile: 'web' },
    fetchedAt: 1000,
  })
  assert.deepEqual(observed, { url: NPM_REGISTRY_LATEST_URL, redirect: 'error' })
  await manager.read()
  assert.equal(requests, 1, 'fresh cached reads stay off the network')
  await manager.read({ force: true })
  assert.equal(requests, 2)
})

test('registry failures and malformed payloads surface one sanitized error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-down-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const failing = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  await assert.rejects(() => failing.read(), /^Error: Geek2API plugin version check failed$/u)
  const malformed = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { version: 'not-a-version' } } }),
  })
  await assert.rejects(() => malformed.read(), /^Error: Geek2API plugin version check failed$/u)
})

test('linked checkouts are reported but never updated in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-link-'))
  const ownPackageJsonUrl = await linkInstall(root)
  const manager = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => {
      throw new Error('runCommand must not run for linked installs')
    },
  })
  const info = await manager.read()
  assert.equal(info.install.kind, 'link')
  assert.equal(info.install.profile, 'web')
  assert.equal(info.updateAvailable, true)
  await assert.rejects(() => manager.update(), /^Error: Geek2API plugin is installed from a local checkout$/u)
})

/** A fake desktop runtime: argv carries the host entry, the dsh runtime, and bundled pnpm. */
async function desktopRuntime(root) {
  const runtimeDir = join(root, 'resources', 'app.asar', 'dsh')
  const hostEntry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const pnpm = join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  await writeManifest(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.1.7-rc.2',
  })
  await writeManifest(hostEntry, { name: '@deepseek-ai/dsh-desktop-host', version: '0.1.7-rc.2' })
  await writeManifest(pnpm, { name: 'pnpm', version: '11.7.0' })
  return {
    runtimeDir,
    hostEntry,
    pnpm,
    argv: [
      join(root, 'DeepSeek Harness'),
      hostEntry,
      runtimeDir,
      join(root, 'profiles', 'desktop'),
      join(root, 'resources', 'runtime', 'primary-runtime'),
      pnpm,
      join(root, 'resources', 'runtime', 'bin'),
    ],
  }
}

const installRecorder = async ({ args, cwd }) => {
  await writeManifest(join(cwd, 'node_modules', PACKAGE_NAME, 'package.json'), {
    name: PACKAGE_NAME,
    version: args.at(-1).split('@').at(-1),
  })
  return { code: 0, stdout: '', stderr: '' }
}

test('update installs the exact version into the owning profile, pinned and age-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-update-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const calls = []
  let registryRequests = 0
  const manager = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    execPath: '/node',
    argv: ['/node', '/dsh/bin.js'],
    fetchImpl: () => {
      registryRequests += 1
      return registryOk('1.0.4')()
    },
    runCommand: async (call, options) => {
      calls.push(call)
      return installRecorder(call, options)
    },
  })
  const updated = await manager.update()
  assert.deepEqual(updated, { version: '1.0.4', profile: 'web' })
  assert.equal(calls[0].command, 'pnpm')
  assert.deepEqual(calls[0].args, [
    'add', '--save-exact', '--config.minimumReleaseAge=0', `${PACKAGE_NAME}@1.0.4`,
  ])
  assert.equal(calls[0].cwd, join(root, 'profiles', 'web'))
  await manager.read()
  assert.equal(registryRequests, 2, 'a successful update invalidates the cached version')
})

test('desktop hosts install with the bundled pnpm, never by launching the desktop host again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-desktop-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const runtime = await desktopRuntime(root)
  assert.equal(resolvePnpm({ argv: runtime.argv }), runtime.pnpm)
  const calls = []
  const manager = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    execPath: '/Applications/DeepSeek Harness',
    argv: runtime.argv,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async (call, options) => {
      calls.push(call)
      return installRecorder(call, options)
    },
  })
  assert.deepEqual(await manager.update(), { version: '1.0.4', profile: 'web' })
  const [call] = calls
  assert.equal(call.command, '/Applications/DeepSeek Harness')
  assert.deepEqual(call.args, [
    runtime.pnpm, 'add', '--save-exact', '--config.minimumReleaseAge=0', `${PACKAGE_NAME}@1.0.4`,
  ])
  const flattened = JSON.stringify(call)
  assert.equal(flattened.includes(runtime.hostEntry), false)
  assert.equal(flattened.includes('plugin'), false)
})

test('an update that installs nothing is a failure, not a reported success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-verify-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const manager = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    settleDelayMs: 1,
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  await assert.rejects(
    () => manager.update(),
    /^Error: Geek2API plugin update did not install the requested version$/u,
  )
})

test('the package-manager resolver trusts only real pnpm entries and owned runtime roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-resolve-'))
  const runtime = await desktopRuntime(root)
  const elsewhere = await mkdtemp(join(tmpdir(), 'geek2api-version-resolve-other-'))
  const otherPnpm = join(elsewhere, 'resources', 'pnpm', 'bin', 'pnpm.mjs')

  assert.equal(resolvePnpm({ argv: runtime.argv }), runtime.pnpm)
  assert.equal(resolvePnpm({ argv: ['/node', '--expose-internals', '/dsh/bin.js'] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', runtime.hostEntry] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', '/somewhere/pnpm-not-really'] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', join(root, 'missing', 'pnpm.mjs')] }), undefined)

  await writeManifest(otherPnpm, { name: 'pnpm', version: '11.7.0' })
  const runtimeDir = join(elsewhere, 'resources', 'runtime')
  await writeManifest(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.1.7-rc.2',
  })
  assert.equal(
    resolvePnpm({ argv: ['/node', join(elsewhere, 'index.js'), runtimeDir] }),
    otherPnpm,
  )
})

test('update failures stay generic and unknown installs refuse to guess a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geek2api-version-fail-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const failing = createGeek2APIPluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => ({ code: 1, stdout: '', stderr: 'pnpm exploded with secret-ish output' }),
  })
  await assert.rejects(
    () => failing.update(),
    error => error.message === 'Geek2API plugin update failed' && !error.message.includes('secret-ish'),
  )

  const emptyHome = await mkdtemp(join(tmpdir(), 'geek2api-version-none-'))
  const stray = join(emptyHome, 'elsewhere', 'package.json')
  await writeManifest(stray, { name: PACKAGE_NAME, version: '1.0.3' })
  const unknown = createGeek2APIPluginManager({
    env: { DSH_HOME: emptyHome },
    ownPackageJsonUrl: pathToFileURL(stray),
    fetchImpl: registryOk('1.0.4'),
  })
  const info = await unknown.read()
  assert.deepEqual(info.install, { kind: 'unknown' })
  await assert.rejects(() => unknown.update(), /^Error: Geek2API plugin update could not find the owning profile$/u)
})

test('loopback RPC exposes version and update endpoints with sanitized errors', async () => {
  const projection = {
    current: '1.0.3',
    latest: '1.0.4',
    updateAvailable: true,
    install: { kind: 'npm', profile: 'web' },
    fetchedAt: 1000,
  }
  const forced = []
  const handler = rpc({
    async read({ force } = {}) {
      forced.push(force)
      return projection
    },
    async update() {
      return { version: '1.0.4', profile: 'web' }
    },
  })
  assert.deepEqual(await handler('plugin/version', {}), { ok: true, value: projection })
  await handler('plugin/version', { force: true })
  assert.deepEqual(forced, [false, true])
  assert.deepEqual(await handler('plugin/update', {}), {
    ok: true,
    value: { version: '1.0.4', profile: 'web' },
  })

  const failing = rpc({
    async read() { throw new Error('Geek2API plugin version check failed') },
    async update() { throw new Error('pnpm leaked internals') },
  })
  assert.deepEqual(await failing('plugin/version', {}), {
    ok: false,
    error: { code: 'geek2api/request-failed', message: 'Geek2API plugin version check failed', details: {} },
  })
  assert.deepEqual(await failing('plugin/update', {}), {
    ok: false,
    error: { code: 'geek2api/request-failed', message: 'Geek2API request failed', details: {} },
  })

  const missing = rpc(undefined)
  assert.deepEqual(await missing('plugin/version', {}), {
    ok: false,
    error: { code: 'geek2api/request-failed', message: 'Geek2API plugin version is unavailable', details: {} },
  })
})
