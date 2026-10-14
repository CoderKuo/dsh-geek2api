import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

async function preflight(exchangeStatus) {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  const step = workflow.split('- name: Show the OIDC identity npm will match')[1]?.split('- name: Publish')[0]
  const code = /node <<'EOF'\n([\s\S]*?)\n\s*EOF/u.exec(step ?? '')?.[1]
  assert.ok(code, 'the trusted-publisher preflight must contain its actual Node program')
  const lines = []
  const calls = []
  const token = `fixture-secret-${'x'.repeat(2_000)}`
  const claims = {
    repository: 'BaronCyrus/dsh-geek2api',
    repository_owner: 'BaronCyrus',
    workflow: 'Publish',
    workflow_ref: 'BaronCyrus/dsh-geek2api/.github/workflows/publish.yml@refs/heads/main',
    ref: 'refs/heads/main',
    aud: 'npm:registry.npmjs.org',
    iss: 'https://token.actions.githubusercontent.com',
  }
  const oidc = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  const promise = runInNewContext(code, {
    URL,
    Buffer,
    console: { log: value => lines.push(String(value)), error: value => lines.push(String(value)) },
    process: {
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/oidc?existing=true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-capability' },
      exit: code => { throw new Error(`EXIT_${code}`) },
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options })
      if (calls.length === 1) return { ok: true, json: async () => ({ value: oidc }) }
      assert.equal(String(url), 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/dsh-geek2api')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers.Authorization, `Bearer ${oidc}`)
      return { ok: exchangeStatus >= 200 && exchangeStatus < 300, status: exchangeStatus, arrayBuffer: async () => Buffer.from(JSON.stringify({ token })) }
    },
  })
  return { promise, lines, calls, token }
}

test('publisher preflight prints safe identity claims, never an exchange credential or its truncated prefix', async () => {
  const run = await preflight(200)
  await run.promise
  assert.ok(run.lines.includes('repository=BaronCyrus/dsh-geek2api'))
  assert.ok(run.lines.includes('environment='))
  assert.ok(run.lines.includes('exchange_status=200'))
  assert.equal(new URL(run.calls[0].url).searchParams.get('audience'), 'npm:registry.npmjs.org')
  assert.equal(run.lines.join('\n').includes(run.token.slice(0, 50)), false)
  assert.equal(run.lines.join('\n').includes('fixture-request-capability'), false)
})

test('publisher preflight accepts the real registry exchange Created response', async () => {
  const run = await preflight(201)
  await run.promise
  assert.ok(run.lines.includes('exchange_status=201'))
  assert.equal(run.lines.join('\n').includes(run.token.slice(0, 50)), false)
})

test('tag publication uses the verified versioned tarball, not a separately packed workspace', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes('run: pnpm pack --pack-destination .artifacts'))
  assert.ok(workflow.includes('artifact=".artifacts/dsh-geek2api-${version:?}.tgz"'))
  assert.ok(workflow.includes('npm publish "${artifact:?}" --access public'))
  assert.ok(workflow.includes('if [ ! -f "$artifact" ]; then'))
})

test('publisher preflight fails closed when npm rejects the configured publisher', async () => {
  const run = await preflight(403)
  await assert.rejects(run.promise, /EXIT_1/u)
  assert.ok(run.lines.includes('exchange_status=403'))
  assert.equal(run.lines.join('\n').includes(run.token.slice(0, 50)), false)
})
