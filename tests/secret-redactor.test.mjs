import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeltaRedactor, redactSecrets } from '../src/secret-redactor.js'

test('redaction covers raw and JSON-escaped quote/backslash keys', () => {
  const key = 'sk-private-"quoted"-\\backslash'
  assert.equal(redactSecrets(`value ${key}`, [key]), 'value [redacted]')
  const serialized = redactSecrets(JSON.stringify({ summary: `echo ${key}`, title: key }), [key])
  assert.deepEqual(JSON.parse(serialized), { summary: 'echo [redacted]', title: '[redacted]' })
})

test('every possible delta split of a secret and its escaped form redacts before emission', () => {
  const key = 'sk-private-"quoted"-\\backslash'
  for (const value of [key, JSON.stringify(key).slice(1, -1)]) {
    for (let split = 1; split < value.length; split++) {
      const redactor = createDeltaRedactor([key])
      const result = redactor.write(`说明 ${value.slice(0, split)}`) + redactor.write(`${value.slice(split)} done`) + redactor.flush()
      assert.equal(result, '说明 [redacted] done')
    }
  }
})

test('character-by-character credentials/capabilities and block-boundary prefixes cannot reconstruct a secret', () => {
  const key = 'sk-test-only-streamed-secret'
  const cap = 'deadbeef1234567890abcdef'
  const redactor = createDeltaRedactor([key, cap])
  let result = ''
  for (const char of `one ${key} two ${cap}.`) result += redactor.write(char)
  result += redactor.flush()
  assert.equal(result, 'one [redacted] two [redacted].')
  const boundary = createDeltaRedactor([key])
  const across = boundary.write(key.slice(0, 5)) + boundary.flush({ boundary: true }) + boundary.write(key.slice(5)) + boundary.flush()
  assert.equal(across.includes(key), false)
})

test('ordinary streaming text and incomplete end-of-output prefixes remain unchanged', () => {
  const redactor = createDeltaRedactor(['sk-sensitive-value'])
  const input = ['你好 ', 'plain ', 'source', 's']
  const output = input.map(s => redactor.write(s)).join('') + redactor.flush()
  assert.equal(output, input.join(''))
})
