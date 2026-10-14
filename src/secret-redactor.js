/**
 * Redaction of plugin-owned credentials and ephemeral bridge capabilities.
 * Work on decoded strings where possible; JSON-escaped forms also cover
 * diagnostics containing serialized data. Delta redaction holds only the
 * longest suffix that could still become a secret in the next chunk.
 */

const strings = values => [...new Set(values.filter(value => typeof value === 'string' && value !== ''))].sort((a, b) => b.length - a.length)
const variants = values => strings(values.flatMap(value => typeof value === 'string' ? [value, JSON.stringify(value).slice(1, -1)] : []))

export function redactSecrets(text, values) {
  let safe = String(text)
  for (const secret of variants(values)) safe = safe.split(secret).join('[redacted]')
  return safe
}

/** Protect secrets fragmented across consecutive decoded text deltas. */
export function createDeltaRedactor(values) {
  const secrets = variants(values)
  let pending = ''
  return {
    write(text) {
      const safe = redactSecrets(pending + text, secrets)
      let held = 0
      for (const secret of secrets) {
        const maximum = Math.min(safe.length, secret.length - 1)
        for (let length = maximum; length > held; length--) {
          if (safe.endsWith(secret.slice(0, length))) { held = length; break }
        }
      }
      pending = held === 0 ? '' : safe.slice(-held)
      return held === 0 ? safe : safe.slice(0, -held)
    },
    /**
     * At a block/tool boundary, mask a still-ambiguous prefix so a subsequent
     * block cannot reconstruct the credential. At end of output it is safe
     * to flush an incomplete prefix literally; no later delta can complete it.
     */
    flush({ boundary = false } = {}) {
      const result = boundary && pending !== '' ? '[redacted]' : pending
      pending = ''
      return result
    },
  }
}
