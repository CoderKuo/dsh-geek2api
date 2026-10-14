/** Read only the plugin-owned key record; never use a reference or ambient key. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

import { Geek2APIKeyRing } from '../lib/index.js'

export async function readStoredKey({
  filePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml'),
  label,
} = {}) {
  let record
  try {
    const doc = parseDocument(readFileSync(filePath, 'utf8'), { prettyErrors: false, logLevel: 'silent' })
    if (doc.errors.length) throw new Error('invalid credential document')
    record = doc.toJS()?.records?.['geek2api/keys']
  } catch {
    // YAML diagnostics can quote source lines containing secrets.
    throw new Error('Geek2API plugin credentials could not be read safely')
  }
  const ring = new Geek2APIKeyRing({
    readRecord: async id => id === 'geek2api/keys' ? record : undefined,
    modifyRecord: async () => { throw new Error('Geek2API live checks cannot change stored credentials') },
  })
  if (label !== undefined) {
    const matches = (await ring.secrets()).filter(entry => entry.label === label && !entry.disabled)
    if (matches.length !== 1) throw new Error('Geek2API live check needs one usable key with that label')
    return matches[0].key
  }
  const active = await ring.activeKey()
  if (active === undefined) throw new Error('Geek2API live check needs a usable key added under Settings → Geek2API')
  return active.key
}
