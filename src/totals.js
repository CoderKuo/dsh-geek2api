/**
 * Totals across the keys a balance read returned.
 *
 * Keys of one Geek2API account spend the same wallet, so a wallet is counted
 * once however many of its keys are stored. Two wallet rows are the same
 * wallet when the gateway names the same account (`accountRef`) or, when it
 * names none, when they report the same balance to the micro-dollar. Key
 * quotas and subscriptions are the key's own and add up.
 *
 * @module dsh-geek2api/totals
 */

const amount = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Which pool of money a row draws on; rows with the same pool count once. */
function poolOf(row, usage) {
  if (usage.mode !== 'wallet') return `key:${row?.id}`
  if (typeof usage.accountRef === 'string') return `account:${usage.accountRef}`
  const remaining = amount(usage.availableUsd)
  return remaining === undefined ? `key:${row?.id}` : `wallet:${remaining.toFixed(6)}`
}

/**
 * Add up the balance rows the host returned.
 * @param rows - the `keys` array of a balance projection.
 * @returns summed amounts plus the conditions that make a sum incomplete:
 *   keys whose read failed, keys with no limit at all, and how many wallet
 *   rows were folded into a wallet already counted.
 */
export function sumBalances(rows) {
  const total = { keys: 0, counted: 0, unread: 0, unlimited: 0, shared: 0, remainingUsd: 0, usedUsd: 0, limitUsd: 0 }
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    total.keys += 1
    const usage = row?.usage
    if (usage === undefined) {
      total.unread += 1
      continue
    }
    total.counted += 1
    const pool = poolOf(row, usage)
    if (seen.has(pool)) {
      total.shared += 1
      continue
    }
    seen.add(pool)
    if (usage.unlimitedQuota === true) {
      total.unlimited += 1
      continue
    }
    const remaining = amount(usage.availableUsd)
    const used = amount(usage.usedUsd)
    const limit = amount(usage.limitUsd)
    if (remaining !== undefined) total.remainingUsd += remaining
    if (used !== undefined) total.usedUsd += used
    if (limit !== undefined) total.limitUsd += limit
  }
  return total
}
