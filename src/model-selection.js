/**
 * The models advertised in Geek2API's picker: the built-in catalog plus the
 * models the user added by id, less the ones the user hid.
 *
 * This controller owns the live catalog. The route serves it, the group
 * reader measures each key's coverage of it, and the panel edits both
 * preferences through it.
 *
 * @module dsh-geek2api/model-selection
 */

import { cappedCatalogModel, customCatalogModel, GEEK2API_MODELS, GEEK2API_MODEL_IDS } from './catalog.js'
import { CUSTOM_MODEL_PROTOCOLS, MAX_CUSTOM_MODELS, readCustomModels, validateCustomModels } from './custom-models.js'
import { fieldValue } from './preferences.js'

/**
 * Store exclusions so new catalog models are selected by default as well.
 * @param preference - the preference source.
 * @param ids - the ids the catalog currently advertises.
 * @returns the hidden ids, in catalog order.
 */
export function readHiddenModels(preference, ids = GEEK2API_MODEL_IDS) {
  const value = fieldValue(preference?.hiddenModels)
  if (!Array.isArray(value)) return []
  const hidden = new Set(value)
  return ids.filter(id => hidden.has(id))
}

export function createModelSelectionController({ readPreference, writePreference, isWritable, onChange, onCatalogChange, contextLimitFor = () => undefined }) {
  /**
   * The catalog for the current preference, rebuilt only when the custom list
   * or a gateway context cap changes: the route recognizes an unchanged
   * catalog by identity. Caps come from the keys' model lists (a group that
   * limits the input per request, like the free DeepSeek group's 200K), so a
   * session compacts before the gateway refuses it.
   */
  let memo = { key: '[]', limits: '{}', base: GEEK2API_MODELS, custom: [], models: GEEK2API_MODELS, ids: GEEK2API_MODEL_IDS }
  const catalog = () => {
    const custom = readCustomModels(fieldValue((readPreference() ?? {}).customModels))
    const key = JSON.stringify(custom)
    const base = key === memo.key ? memo.base : [...GEEK2API_MODELS, ...custom.map(customCatalogModel)]
    const caps = {}
    for (const model of base ?? []) {
      const limit = contextLimitFor(model.id)
      if (Number.isInteger(limit) && limit < model.contextWindow) caps[model.id] = limit
    }
    const limits = JSON.stringify(caps)
    if (key !== memo.key || limits !== memo.limits) {
      const models = Object.freeze(base.map(model => cappedCatalogModel(model, caps[model.id])))
      memo = { key, limits, base, custom, models, ids: Object.freeze(models.map(model => model.id)) }
    }
    return memo
  }
  const hidden = () => readHiddenModels(readPreference(), catalog().ids)
  const signature = () => ({ hidden: hidden().join(','), catalog: catalog().key })
  let advertised = signature()

  const reconcile = () => {
    const next = signature()
    if (next.hidden === advertised.hidden && next.catalog === advertised.catalog) return
    const catalogChanged = next.catalog !== advertised.catalog
    advertised = next
    if (catalogChanged) onCatalogChange?.()
    onChange?.()
  }

  const status = () => {
    const excluded = new Set(hidden())
    const { custom } = catalog()
    const customIds = new Set(custom.map(entry => entry.id))
    return {
      writable: isWritable() === true,
      models: catalog().models.map(({ id, name }) => ({
        id,
        name,
        selected: !excluded.has(id),
        ...(customIds.has(id) ? { custom: true } : {}),
      })),
      customModels: custom.map(entry => ({ ...entry })),
      protocols: [...CUSTOM_MODEL_PROTOCOLS],
      maxCustomModels: MAX_CUSTOM_MODELS,
    }
  }

  const requireWritable = () => {
    if (isWritable() !== true) throw new Error('Geek2API settings are not writable in this profile')
  }

  return Object.freeze({
    status,
    reconcile,
    /** The pi-ai models the route serves, built-in first. */
    models: () => catalog().models,
    /** Every id the route serves, built-in first. */
    ids: () => catalog().ids,
    isVisible: id => !hidden().includes(id),
    async update({ selectedIds } = {}) {
      const ids = catalog().ids
      if (!Array.isArray(selectedIds) || selectedIds.some(id => !ids.includes(id))) {
        throw new Error('That Geek2API model selection is not supported')
      }
      requireWritable()
      const selected = new Set(selectedIds)
      try {
        await writePreference({ hiddenModels: ids.filter(id => !selected.has(id)) })
      } catch {
        throw new Error('Geek2API could not save the model selection')
      }
      reconcile()
      return status()
    },
    /**
     * Replace the custom model list. A new model is visible at once; a removed
     * one leaves the picker, and sessions that used it fail with an unknown
     * model instead of silently switching to another.
     */
    async updateCustom({ customModels } = {}) {
      const next = validateCustomModels(customModels)
      requireWritable()
      try {
        await writePreference({ customModels: next.map(entry => ({ ...entry })) })
      } catch {
        throw new Error('Geek2API could not save the custom models')
      }
      reconcile()
      return status()
    },
  })
}
