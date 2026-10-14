/** Profile preferences for the models advertised in Geek2API's picker. */
import { GEEK2API_MODELS, GEEK2API_MODEL_IDS } from './catalog.js'
import { fieldValue } from './preferences.js'

/** Store exclusions so new catalog models are selected by default as well. */
export function readHiddenModels(preference) {
  const value = fieldValue(preference?.hiddenModels)
  if (!Array.isArray(value)) return []
  const hidden = new Set(value)
  return GEEK2API_MODEL_IDS.filter(id => hidden.has(id))
}

export function createModelSelectionController({ readPreference, writePreference, isWritable, onChange }) {
  const hidden = () => readHiddenModels(readPreference())
  let advertised = hidden().join(',')

  const reconcile = () => {
    const next = hidden().join(',')
    if (next === advertised) return
    onChange?.()
    advertised = next
  }

  const status = () => {
    const excluded = new Set(hidden())
    return {
      writable: isWritable() === true,
      models: GEEK2API_MODELS.map(({ id, name }) => ({ id, name, selected: !excluded.has(id) })),
    }
  }

  return Object.freeze({
    status,
    reconcile,
    isVisible: id => !hidden().includes(id),
    async update({ selectedIds } = {}) {
      if (!Array.isArray(selectedIds) || selectedIds.some(id => !GEEK2API_MODEL_IDS.includes(id))) {
        throw new Error('That Geek2API model selection is not supported')
      }
      if (isWritable() !== true) throw new Error('Geek2API settings are not writable in this profile')
      const selected = new Set(selectedIds)
      try {
        await writePreference({ hiddenModels: GEEK2API_MODEL_IDS.filter(id => !selected.has(id)) })
      } catch {
        throw new Error('Geek2API could not save the model selection')
      }
      reconcile()
      return status()
    },
  })
}
