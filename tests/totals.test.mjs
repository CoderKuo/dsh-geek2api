import assert from 'node:assert/strict'
import test from 'node:test'

import { sumBalances } from '../src/totals.js'

test('a key quota is a cap on the wallet, not money: it stays out of the sums', () => {
  const rows = [
    { id: 'a', usage: { mode: 'quota', availableUsd: 499.07, usedUsd: 0.93, limitUsd: 500 } },
    { id: 'b', usage: { mode: 'subscription', planName: 'Plus', availableUsd: 500, usedUsd: 0, limitUsd: 500, resetPeriod: 'monthly' } },
  ]
  const totals = sumBalances(rows)
  assert.equal(totals.counted, 2)
  assert.equal(totals.capped, 1)
  assert.equal(totals.remainingUsd, 500)
  assert.equal(totals.usedUsd, 0)
  assert.equal(totals.limitUsd, 500)
  assert.equal(totals.unread, 0)
  assert.equal(totals.unlimited, 0)
})

test('keys on the same subscription plan count it once', () => {
  const totals = sumBalances([
    { id: 'a', usage: { mode: 'subscription', planName: 'Plus', availableUsd: 30, usedUsd: 20, limitUsd: 50 } },
    { id: 'b', usage: { mode: 'subscription', planName: 'Plus', availableUsd: 30, usedUsd: 20, limitUsd: 50 } },
    { id: 'c', usage: { mode: 'subscription', planName: 'Max', availableUsd: 100, usedUsd: 0, limitUsd: 100 } },
  ])
  assert.equal(totals.shared, 1)
  assert.equal(totals.remainingUsd, 130)
  assert.equal(totals.limitUsd, 150)
})

test('counts only what it can read and reports the rest', () => {
  const rows = [
    { id: 'a', usage: { availableUsd: 10, usedUsd: 1, limitUsd: 11 } },
    { id: 'b', error: 'this API key was rejected (401)' },
  ]
  const totals = sumBalances(rows)
  assert.equal(totals.keys, 2)
  assert.equal(totals.counted, 1)
  assert.equal(totals.unread, 1)
  assert.equal(totals.remainingUsd, 10)
  assert.equal(totals.limitUsd, 11)
})

test('an unlimited key is reported instead of inflating a limit', () => {
  const totals = sumBalances([
    { id: 'a', usage: { availableUsd: 100, usedUsd: 5, limitUsd: 105 } },
    { id: 'b', usage: { unlimitedQuota: true, availableUsd: 0, usedUsd: 0 } },
  ])
  assert.equal(totals.limitUsd, 105)
  assert.equal(totals.unlimited, 1)
})

test('a key without a period limit contributes only what it reports', () => {
  const totals = sumBalances([{ id: 'a', usage: { availableUsd: 2, usedUsd: 1 } }])
  assert.equal(totals.remainingUsd, 2)
  assert.equal(totals.limitUsd, 0)
})

test('an empty or malformed row list totals to zero', () => {
  assert.deepEqual(sumBalances([]), { keys: 0, counted: 0, unread: 0, unlimited: 0, shared: 0, capped: 0, remainingUsd: 0, usedUsd: 0, limitUsd: 0 })
  assert.equal(sumBalances(undefined).keys, 0)
  assert.equal(sumBalances([null, 7]).keys, 2)
  assert.equal(sumBalances([null, 7]).counted, 0)
})

test('keys of one account share a wallet that is counted once, by account reference', () => {
  const totals = sumBalances([
    { id: 'a', usage: { mode: 'wallet', accountRef: 'acct-1', availableUsd: 40, usedUsd: 3 } },
    { id: 'b', usage: { mode: 'wallet', accountRef: 'acct-1', availableUsd: 40, usedUsd: 9 } },
    { id: 'c', usage: { mode: 'wallet', accountRef: 'acct-2', availableUsd: 40, usedUsd: 1 } },
  ])
  assert.equal(totals.counted, 3)
  assert.equal(totals.shared, 1)
  assert.equal(totals.remainingUsd, 80, 'two accounts, even with equal balances')
  assert.equal(totals.usedUsd, 4)
})

test('without an account reference, wallets with the same balance are the same wallet', () => {
  const totals = sumBalances([
    { id: 'a', usage: { mode: 'wallet', availableUsd: 4226.232196 } },
    { id: 'b', usage: { mode: 'wallet', availableUsd: 4226.232196 } },
    { id: 'c', usage: { mode: 'wallet', availableUsd: 12.5 } },
    { id: 'd', usage: { mode: 'quota', availableUsd: 4226.232196, limitUsd: 5000 } },
  ])
  assert.equal(totals.shared, 1)
  assert.equal(Math.round((totals.remainingUsd) * 1e6) / 1e6, Math.round((4226.232196 + 12.5) * 1e6) / 1e6, 'one wallet, counted once; the key cap is not money')
  assert.equal(totals.capped, 1)
  assert.equal(totals.limitUsd, 0)
})
