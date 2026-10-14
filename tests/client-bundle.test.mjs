import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Every member the bundle may ask for, tolerant of React's surface. */
function stubRequire(id) {
  if (id === 'react' || id === 'react/jsx-runtime') {
    return new Proxy({}, { get: () => () => ({}) })
  }
  throw new Error(`client bundle required an undeclared module: ${id}`)
}

test('the client bundle carries the loader wrapper and exports apply/inject', { skip: existsSync(bundlePath) ? false : 'lib/client.js is not built yet' }, () => {
  const source = readFileSync(bundlePath, 'utf8')
  const loads = []
  const sandbox = {
    window: { __ModuleLoader__: { load: spec => loads.push(spec) } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.equal(loads.length, 1)
  const spec = loads[0]
  // The loader keys the bundle by package name; a mismatch makes it invisible.
  assert.equal(spec.id, manifest.name)
  assert.equal(typeof spec.factory, 'function')
  const exports = spec.factory(stubRequire)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'connection', 'modelDirectories'])
})

test('every channel call carries a payload object', () => {
  // The connection envelope requires `payload`; `JSON.stringify` drops an
  // `undefined` field, so a call without one is refused as an invalid
  // client-request message. Both callers must default it, because call sites
  // legitimately write `call('status')`.
  const source = readFileSync(path.join(root, 'src', 'client.jsx'), 'utf8')
  const copy = readFileSync(path.join(root, 'src', 'client-copy.js'), 'utf8')
  const helpers = [...source.matchAll(/\(endpoint, payload([^)]*)\) => rpc\.call\(/gu)]
  assert.equal(helpers.length, 1, 'one caller serves the settings panel and the composer')
  assert.match(helpers[0][1], /=\s*\{\}/u)
  assert.equal(source.match(/rpc\.call\(/gu)?.length, 1, 'nothing reaches the channel around the caller')
  assert.match(source, /plugin\/update/u)
  assert.match(copy, /更新插件/u)
})

test('the balance card does not show the account-level billing line', () => {
  // Geek2API's account billing counts every token on the account, including
  // keys not stored here, so it reads as a wrong total beside the key sums.
  const source = readFileSync(path.join(root, 'src', 'client.jsx'), 'utf8')
  assert.doesNotMatch(source, /balance\?\.account\b/u)
  assert.doesNotMatch(source, /siteAccount|含同账号/u)
  // One card lists the keys and their balances, so its empty-state note
  // renders once rather than once per list.
  assert.equal(source.match(/t\('empty'\)/gu)?.length, 1)
})

test('the panel styles itself only with host design tokens that exist', () => {
  const style = readFileSync(path.join(root, 'src', 'client-style.js'), 'utf8')
  // Tokens the host never defined left controls unstyled before.
  assert.doesNotMatch(style, /--dsw-alias-border-default|--dsw-alias-state-warning-primary/u)
  assert.match(style, /--dsw-alias-settings-card-fill/u)
})

test('both languages carry the same copy keys', async () => {
  const { zh, en } = await import('../src/client-copy.js')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('the package declares the client surface the loader requires', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  for (const declared of manifest.dsh.client.inject) {
    assert.ok(
      manifest.peerDependencies[declared] !== undefined || declared.startsWith('@deepseek-ai/dsh-client-'),
      `${declared} must be a declared peer`,
    )
  }
})

test('the shipped patch registers only this plugin, without rewriting Connection', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  const ids = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*$/gmu)].map(match => match[1])
  assert.deepEqual(ids, ['geek2api'])
  assert.match(patch, new RegExp(`name: '${manifest.name}'`, 'u'))
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-client-connection/u)
})
