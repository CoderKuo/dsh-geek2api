/**
 * Browser half: the Geek2API settings page and the composer balance chip.
 *
 * Every number here comes from the host over the plugin's own loopback RPC
 * channel; no key material crosses it, and each read is a bounded projection
 * the host built.
 *
 * @module dsh-geek2api/client
 */

import * as react from 'react'

import { en, zh } from './client-copy.js'
import { STYLE } from './client-style.js'
import { sumBalances } from './totals.js'

const NS = 'settings.geek2api'
const PROVIDER = 'geek2api'
const CHANNEL = '/geek2api'
const REFRESH_MS = 60_000
const INSTALL_POLL_MS = 2_000
/** How long after a search change the panel re-reads what DSH applied (the patch hot-reloads). */
const SEARCH_SETTLE_MS = 1_500
const OWN_SEARCH_IDS = { auto: 'geek2api-auto', geek2api: 'geek2api' }
const FOREIGN_NAMES = { codex: 'Codex', kimi: 'Kimi' }
/** The catalog's models by family, for the "reaches" line under each key. */
const MODEL_FAMILIES = [
  ['Claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']],
  ['GPT', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']],
  ['DeepSeek', ['deepseek-v4.1-flash', 'deepseek-v4-pro']],
  ['Grok', ['grok-4.6', 'grok-4.7']],
  ['Gemini', ['gemini-3.8-flash']],
  ['GLM', ['glm-5.3']],
  ['Kimi', ['kimi-k3']],
]

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The one way this bundle talks to the host. The transport drops an
 * `undefined` payload and the channel's envelope requires the field, so every
 * call carries an object.
 */
function channelCaller(rpc) {
  return (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then(response => {
    if (!response?.ok) throw new Error(response?.error?.message ?? 'Geek2API RPC failed')
    return response.value
  })
}

const useCaller = rpc => react.useMemo(() => channelCaller(rpc), [rpc])

/** Substitute `{name}` placeholders in a copy string. */
const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (match, name) => (values[name] === undefined ? match : String(values[name])))

function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
  }
}

/** The clock time of an epoch-millisecond reading, for a "last read at" note. */
function readTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

function clearMessage(error) {
  const text = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return text.length > 200 ? text.slice(0, 200) : text
}

const RESET_KEYS = { monthly: 'resetMonthly', weekly: 'resetWeekly', daily: 'resetDaily' }

/** What a key draws on: the shared wallet, a subscription plan, or its own quota. */
function planLabel(usage, t) {
  if (usage?.mode === 'wallet') return t('planWallet')
  if (usage?.mode === 'subscription') return fill(t('planSubscription'), { name: usage.planName ?? '' })
  if (usage?.mode === 'quota') return t('planQuota')
  return undefined
}
const resetLabel = (period, t) => (RESET_KEYS[period] === undefined ? undefined : t(RESET_KEYS[period]))

/** Active key's usage row, preferring the key the ring currently points at. */
function activeUsage(balance) {
  if (balance === undefined) return undefined
  return balance.keys?.find(entry => entry.id === balance.activeId) ?? balance.keys?.[0]
}

/** How much of a key's limit is left, for its bar; undefined without a limit. */
function remainingShare(usage) {
  if (usage?.unlimitedQuota === true || typeof usage?.limitUsd !== 'number' || usage.limitUsd <= 0) return undefined
  if (typeof usage.availableUsd !== 'number') return undefined
  return Math.max(0, Math.min(1, usage.availableUsd / usage.limitUsd))
}

/** Which catalog families a key reaches, from its per-model coverage. */
function reachOf(coverage) {
  return MODEL_FAMILIES.flatMap(([name, models]) => {
    const known = models.filter(id => typeof coverage?.[id] === 'boolean')
    if (known.length === 0) return []
    const reached = known.filter(id => coverage[id] === true)
    const state = reached.length === 0 ? 'no' : reached.length === known.length ? 'ok' : 'partial'
    return [{ name, state, reached, missing: known.filter(id => coverage[id] === false) }]
  })
}

// ── primitives ──────────────────────────────────────────────────────────────

function Card({ title, aside, children }) {
  return (
    <section className="pkc-card">
      <header className="pkc-head">
        <h3 className="pkc-title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Button({ variant, size, children, ...rest }) {
  return <button type="button" className="pkc-btn" data-variant={variant} data-size={size} {...rest}>{children}</button>
}

function Segmented({ label, options, value, disabled, onChange }) {
  return (
    <div className="pkc-seg" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          type="button"
          role="radio"
          key={option.value}
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => value !== option.value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ── accounts and keys ───────────────────────────────────────────────────────

/** A key's groups and what they reach. */
function KeyGroups({ group, descriptions, loading, t }) {
  if (group === undefined) {
    return loading ? <span className="pkc-meta">{t('groupsChecking')}</span> : null
  }
  if (group.rejected === true) return <span className="pkc-error">{t('groupsRejected')}</span>
  const reach = reachOf(group.coverage)
  const names = Array.isArray(group.groups) ? group.groups : []
  return (
    <>
      <div className="pkc-groups">
        <span className="pkc-label">{t('groupsTitle')}</span>
        {names.length === 0
          ? <span className="pkc-meta">{group.error === undefined ? '—' : `${t('groupsUnknown')}: ${group.error}`}</span>
          : names.map(name => <span className="pkc-tag" key={name} title={descriptions?.[name] ?? name}>{name}</span>)}
      </div>
      {reach.length > 0 && (
        <div className="pkc-reach">
          {reach.map(family => (
            <span
              key={family.name}
              data-state={family.state}
              title={[...family.reached.map(id => `✓ ${id}`), ...family.missing.map(id => `✗ ${id}`)].join('\n')}
            >
              {family.state === 'ok' ? '✓' : family.state === 'partial' ? '◐' : '✕'} {family.name}
              {family.state === 'partial' && ` (${t('groupsPartial')})`}
            </span>
          ))}
        </div>
      )}
      {group.extraModels > 0 && <span className="pkc-meta">{fill(t('groupsExtra'), { count: group.extraModels })}</span>}
      {group.stale !== undefined && <span className="pkc-meta">{t('groupsStale')}</span>}
    </>
  )
}

function KeyRow({ entry, row, group, descriptions, groupsLoading, busy, renaming, onRename, onAction, t }) {
  const usage = row?.usage
  const share = remainingShare(usage)
  const figures = [
    usage?.unlimitedQuota === true
      ? [t('keyRemaining'), t('keyUnlimited')]
      : usage?.availableUsd === undefined ? undefined : [t('keyRemaining'), formatUsd(usage.availableUsd)],
    usage?.usedUsd === undefined ? undefined : [t('keyUsed'), formatUsd(usage.usedUsd)],
    usage?.limitUsd === undefined ? undefined : [t('accountLimit'), formatUsd(usage.limitUsd)],
  ].filter(Boolean)
  const meta = [
    planLabel(usage, t),
    usage?.keyName === undefined ? undefined : `${t('keyName')} ${usage.keyName}`,
    resetLabel(usage?.resetPeriod, t),
    usage?.todayUsd === undefined ? undefined : `${t('keyToday')} ${formatUsd(usage.todayUsd)}`,
    usage?.expiresAt === undefined ? undefined : fill(t('keyExpires'), { date: new Date(usage.expiresAt).toLocaleDateString() }),
  ].filter(Boolean).join(' · ')
  const editing = renaming?.id === entry.id

  return (
    <div className="pkc-row">
      <div className="pkc-row-top">
        <span className="pkc-row-name">
          {editing
            ? (
              <form className="pkc-form" onSubmit={event => { event.preventDefault(); onRename.submit() }}>
                <input
                  className="pkc-input"
                  type="text"
                  maxLength={60}
                  autoFocus
                  placeholder={t('keyRenamePlaceholder')}
                  value={renaming.label}
                  onChange={event => onRename.change(event.target.value)}
                  onKeyDown={event => event.key === 'Escape' && onRename.cancel()}
                />
                <Button type="submit" variant="primary" disabled={busy || renaming.label.trim() === ''}>{t('keyRenameSave')}</Button>
                <Button variant="ghost" onClick={onRename.cancel}>{t('keyRenameCancel')}</Button>
              </form>
            )
            : <span className="pkc-name">{entry.label}</span>}
          {entry.active && <span className="pkc-chip" data-tone="success">{t('keyActive')}</span>}
          {entry.disabled && <span className="pkc-chip" data-tone="danger">{entry.disabledReason ? `${t('keyDisabled')} · ${entry.disabledReason}` : t('keyDisabled')}</span>}
        </span>
        {!editing && (
          <span className="pkc-actions">
            {!entry.active && !entry.disabled && <Button disabled={busy} onClick={() => onAction('keys/select', { id: entry.id })}>{t('keyUse')}</Button>}
            {entry.disabled && <Button disabled={busy} onClick={() => onAction('keys/enable', { id: entry.id })}>{t('keyEnable')}</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => onRename.start(entry)}>{t('keyRename')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => onAction('keys/remove', { id: entry.id })}>{t('keyRemove')}</Button>
          </span>
        )}
      </div>
      <span className="pkc-meta">{meta}</span>
      {figures.length > 0
        ? (
          <div className="pkc-figures">
            {figures.map(([label, value]) => <span key={label}>{label}<b>{value}</b></span>)}
          </div>
        )
        : <span className="pkc-meta">{row?.error === undefined ? t('keyNoBalance') : `${t('loadFailed')}: ${row.error}`}</span>}
      {share !== undefined && (
        <div className="pkc-bar" data-level={share < 0.1 ? 'low' : share < 0.3 ? 'warn' : 'ok'} role="presentation">
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      {row?.stale !== undefined && (
        <span className="pkc-warn">{fill(t('staleNote'), { time: readTime(row.stale.fetchedAt), error: row.stale.error ?? '' })}</span>
      )}
      <KeyGroups group={group} descriptions={descriptions} loading={groupsLoading} t={t} />
    </div>
  )
}

function AccountsCard({ call, t }) {
  const [status, setStatus] = react.useState()
  const [balance, setBalance] = react.useState()
  const [groups, setGroups] = react.useState()
  const [groupsLoading, setGroupsLoading] = react.useState(true)
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [draft, setDraft] = react.useState({ key: '', label: '' })
  const [renaming, setRenaming] = react.useState()
  const generation = react.useRef(0)

  const readGroups = react.useCallback((force = false) => {
    setGroupsLoading(true)
    return call('groups', { force })
      .then(setGroups)
      .catch(() => undefined)
      .finally(() => setGroupsLoading(false))
  }, [call])

  const load = react.useCallback((force = false) => {
    const current = ++generation.current
    setBusy(true)
    setError(undefined)
    void readGroups(force)
    return Promise.all([call('status'), call('balance', { force })])
      .then(([nextStatus, nextBalance]) => {
        if (generation.current !== current) return
        setStatus(nextStatus)
        setBalance(nextBalance)
      })
      .catch(failure => {
        if (generation.current === current) setError(clearMessage(failure))
      })
      .finally(() => {
        if (generation.current === current) setBusy(false)
      })
  }, [call, readGroups])

  react.useEffect(() => {
    load(false)
    return () => {
      generation.current += 1
    }
  }, [load])

  const mutate = (endpoint, payload) => {
    setBusy(true)
    setError(undefined)
    return call(endpoint, payload)
      .then(nextStatus => {
        setStatus(nextStatus)
        void readGroups(false)
        return call('balance', { force: true })
      })
      .then(setBalance)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  const addKey = event => {
    event.preventDefault()
    if (draft.key.trim() === '') return
    mutate('keys/add', { key: draft.key, label: draft.label }).then(() => setDraft({ key: '', label: '' }))
  }

  const rename = {
    start: entry => setRenaming({ id: entry.id, label: entry.label }),
    change: label => setRenaming(current => ({ ...current, label })),
    cancel: () => setRenaming(undefined),
    submit: () => {
      if (renaming === undefined || renaming.label.trim() === '') return
      mutate('keys/rename', { id: renaming.id, label: renaming.label }).then(() => setRenaming(undefined))
    },
  }

  const keys = status?.keys ?? []
  const rows = balance?.keys ?? []
  // The headline figures are what these keys can spend together, not
  // Geek2API's account-level billing, which counts every token on the
  // account and is not shown.
  const totals = sumBalances(rows)
  const staleCount = rows.filter(row => row.stale !== undefined).length

  return (
    <Card
      title={t('accountsTitle')}
      aside={(
        <span className="pkc-actions">
          <Button disabled={busy} onClick={() => load(true)}>{busy ? t('refreshing') : t('refresh')}</Button>
          {keys.length > 0 && <Button variant="danger" disabled={busy} onClick={() => mutate('keys/remove-all', {})}>{t('removeAll')}</Button>}
        </span>
      )}
    >
      {keys.length === 0
        ? <p className="pkc-note">{t('empty')}</p>
        : (
          <>
            <div className="pkc-stats">
              <div className="pkc-stat">
                <span className="pkc-stat-label">{t('totalRemaining')}</span>
                <span className="pkc-stat-value">
                  {totals.counted === 0 ? '—' : formatUsd(totals.remainingUsd) ?? '—'}
                  {totals.unlimited > 0 && ` + ${t('keyUnlimited')}`}
                </span>
              </div>
              <div className="pkc-stat">
                <span className="pkc-stat-label">{t('totalUsed')}</span>
                <span className="pkc-stat-value">{totals.counted === 0 ? '—' : formatUsd(totals.usedUsd) ?? '—'}</span>
              </div>
              <div className="pkc-stat">
                <span className="pkc-stat-label">{t('totalLimit')}</span>
                <span className="pkc-stat-value">
                  {totals.counted === 0 ? '—' : totals.unlimited > 0 ? t('keyUnlimited') : formatUsd(totals.limitUsd) ?? '—'}
                </span>
              </div>
            </div>
            {(totals.unread > 0 || staleCount > 0 || totals.shared > 0) && (
              <p className="pkc-note">
                {[
                  totals.shared > 0 ? fill(t('totalShared'), { count: totals.shared }) : undefined,
                  totals.unread > 0 ? fill(t('totalPartial'), { count: totals.unread }) : undefined,
                  staleCount > 0 ? fill(t('totalStale'), { count: staleCount }) : undefined,
                ].filter(Boolean).join(' ')}
              </p>
            )}
            <div className="pkc-list">
              {keys.map(entry => (
                <KeyRow
                  key={entry.id}
                  entry={entry}
                  row={rows.find(row => row.id === entry.id)}
                  group={groups?.keys?.find(group => group.id === entry.id)}
                  descriptions={groups?.descriptions}
                  groupsLoading={groupsLoading}
                  busy={busy}
                  renaming={renaming}
                  onRename={rename}
                  onAction={mutate}
                  t={t}
                />
              ))}
            </div>
            <p className="pkc-note">{t('keysHint')}</p>
          </>
        )}
      <form className="pkc-add" onSubmit={addKey}>
        <span className="pkc-label">{t('addTitle')}</span>
        <div className="pkc-form">
          <input
            className="pkc-input"
            type="password"
            autoComplete="off"
            placeholder={t('addKeyPlaceholder')}
            value={draft.key}
            onChange={event => setDraft(current => ({ ...current, key: event.target.value }))}
          />
          <input
            className="pkc-input"
            type="text"
            placeholder={t('addLabelPlaceholder')}
            value={draft.label}
            onChange={event => setDraft(current => ({ ...current, label: event.target.value }))}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || draft.key.trim() === ''}>{t('add')}</Button>
        </div>
      </form>
      {status !== undefined && status.writable !== true && <p className="pkc-note">{t('notWritable')}</p>}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('error')}: ${error}`}</p>}
    </Card>
  )
}

// ── endpoints ───────────────────────────────────────────────────────────────

/** The entry points, their measured latency, and an editor for the list. */
function HostsCard({ call, t }) {
  const [status, setStatus] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [draft, setDraft] = react.useState()

  const run = react.useCallback((endpoint, payload) => {
    setBusy(true)
    setError(undefined)
    return call(endpoint, payload)
      .then(setStatus)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }, [call])

  react.useEffect(() => {
    void run('hosts/probe', {})
  }, [run])

  const hosts = Array.isArray(status?.hosts) ? status.hosts : []
  const save = list => run('hosts/update', { apiHosts: list }).then(() => setDraft(undefined))
  return (
    <Card
      title={t('hostsTitle')}
      aside={<Button disabled={busy} onClick={() => run('hosts/probe', {})}>{busy ? t('hostsProbing') : t('hostsProbe')}</Button>}
    >
      <p className="pkc-note">{t('hostsIntro')}</p>
      <div className="pkc-list">
        {hosts.map(entry => (
          <div className="pkc-status" key={entry.host}>
            <span
              className="pkc-dot"
              data-tone={entry.coolingUntil !== undefined ? 'danger' : entry.latencyMs !== undefined ? 'success' : 'warn'}
            />
            <span className="pkc-mono">{entry.host}</span>
            {entry.current && <span className="pkc-chip" data-tone="success">{t('hostsCurrent')}</span>}
            <span className="pkc-meta">
              {entry.coolingUntil !== undefined
                ? t('hostsCooling')
                : entry.latencyMs !== undefined ? `${entry.latencyMs} ms` : t('hostsDown')}
            </span>
          </div>
        ))}
      </div>
      <details className="pkc-advanced" onToggle={event => event.currentTarget.open && draft === undefined && setDraft(hosts.map(entry => entry.host).join('\n'))}>
        <summary>{t('hostsEdit')}</summary>
        <p className="pkc-note">{t('hostsEditHint')}</p>
        <textarea
          className="pkc-input pkc-mono"
          rows={Math.max(4, hosts.length + 1)}
          disabled={status?.writable !== true || busy}
          value={draft ?? ''}
          onChange={event => setDraft(event.target.value)}
        />
        <div className="pkc-split">
          <Button variant="primary" disabled={status?.writable !== true || busy} onClick={() => save((draft ?? '').split(/\s+/u).filter(Boolean))}>{t('hostsSave')}</Button>
          <Button variant="ghost" disabled={status?.writable !== true || busy} onClick={() => save([])}>{t('hostsReset')}</Button>
        </div>
      </details>
      {status !== undefined && status.writable !== true && <p className="pkc-note">{t('notWritable')}</p>}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('error')}: ${error}`}</p>}
    </Card>
  )
}

// ── model visibility ────────────────────────────────────────────────────────

function ModelsCard({ call, t }) {
  const [state, setState] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()

  react.useEffect(() => {
    let live = true
    call('models/status').then(value => {
      if (live) setState(value)
    }).catch(failure => {
      if (live) setError(clearMessage(failure))
    })
    return () => { live = false }
  }, [call])

  const models = state?.models ?? []
  const selectedIds = models.filter(model => model.selected).map(model => model.id)
  const disabled = busy || state?.writable !== true
  const update = ids => {
    if (disabled) return
    setBusy(true)
    setError(undefined)
    call('models/update', { selectedIds: ids })
      .then(setState)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <Card title={t('modelsTitle')} aside={state !== undefined && <span className="pkc-meta">{fill(t('modelsCount'), { count: selectedIds.length, total: models.length })}</span>}>
      <p className="pkc-note">{t('modelsIntro')}</p>
      {state === undefined && error === undefined && <p className="pkc-note" role="status">{t('modelsChecking')}</p>}
      {state !== undefined && (
        <>
          <div className="pkc-actions">
            <Button disabled={disabled || selectedIds.length === models.length} onClick={() => update(models.map(model => model.id))}>{t('modelsAll')}</Button>
            <Button disabled={disabled || selectedIds.length === 0} onClick={() => update([])}>{t('modelsNone')}</Button>
          </div>
          <fieldset className="pkc-models" aria-label={t('modelsTitle')} disabled={disabled}>
            {models.map(model => (
              <label key={model.id} className="pkc-model">
                <input
                  type="checkbox"
                  checked={model.selected}
                  onChange={event => update(event.target.checked ? [...selectedIds, model.id] : selectedIds.filter(id => id !== model.id))}
                />
                <span><b>{model.name}</b><span className="pkc-meta pkc-mono">{model.id}</span></span>
              </label>
            ))}
          </fieldset>
          {selectedIds.length === 0 && <p className="pkc-note">{t('modelsEmpty')}</p>}
          {state.writable !== true && <p className="pkc-note">{t('searchNotWritable')}</p>}
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('modelsFailed')}: ${error}`}</p>}
    </Card>
  )
}

// ── web search ──────────────────────────────────────────────────────────────

/** Web search routing and backend, written through the host. */
function SearchCard({ call, t }) {
  const [state, setState] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const generation = react.useRef(0)

  const read = react.useCallback(() => {
    const current = ++generation.current
    return call('search/status').then(value => {
      if (generation.current === current) setState(value)
    }).catch(failure => {
      if (generation.current === current) setError(clearMessage(failure))
    })
  }, [call])

  react.useEffect(() => {
    read()
    return () => {
      generation.current += 1
    }
  }, [read])

  const update = patch => {
    if (busy || state?.writable !== true) return
    setBusy(true)
    setError(undefined)
    call('search/update', patch)
      .then(value => {
        setState(value)
        // The patch hot-applies after the write; read what DSH settled on.
        window.setTimeout(() => {
          read()
        }, SEARCH_SETTLE_MS)
      })
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  const mode = state?.searchProvider
  const backend = state?.searchBackend
  const models = state?.models ?? {}
  const base = state?.effective?.base
  const runtime = state?.effective?.runtime
  const foreign = Object.entries(state?.foreign ?? {}).filter(([, present]) => present).map(([name]) => FOREIGN_NAMES[name] ?? name)
  const expected = OWN_SEARCH_IDS[mode]
  const overridden = expected !== undefined && state?.applied?.state === 'applied' && base !== undefined && base !== expected
  const disabled = busy || state?.writable !== true
  const modeHint = { default: 'searchModeDefaultHint', auto: 'searchModeAutoHint', geek2api: 'searchModeGeek2apiHint' }[mode]
  const backendHint = backend === 'gpt'
    ? fill(t('searchBackendGptHint'), { model: models.gpt ?? 'gpt-6.1-sol' })
    : fill(t('searchBackendClaudeHint'), { model: models.claude ?? 'claude-haiku-4-5-20251001' })

  return (
    <Card title={t('searchTitle')} aside={<span className="pkc-chip" data-tone="neutral">{t('searchScope')}</span>}>
      <p className="pkc-note">{t('searchIntro')}</p>
      <p className="pkc-note">{t('searchCliHint')}</p>
      {state === undefined && error === undefined && <p className="pkc-note" role="status">{t('searchChecking')}</p>}
      {state !== undefined && (
        <>
          <div className="pkc-setting">
            <span className="pkc-label">{t('searchModeTitle')}</span>
            <div>
              <Segmented
                label={t('searchModeTitle')}
                value={mode}
                disabled={disabled}
                onChange={value => update({ searchProvider: value })}
                options={[
                  { value: 'default', label: t('searchModeDefault') },
                  { value: 'auto', label: t('searchModeAuto') },
                  { value: 'geek2api', label: t('searchModeGeek2api') },
                ]}
              />
              {modeHint !== undefined && <p className="pkc-note">{t(modeHint)}</p>}
            </div>
          </div>
          <div className="pkc-setting">
            <span className="pkc-label">{t('searchBackendTitle')}</span>
            <div>
              <Segmented
                label={t('searchBackendTitle')}
                value={backend}
                disabled={disabled}
                onChange={value => update({ searchBackend: value })}
                options={[
                  { value: 'claude', label: t('searchBackendClaude') },
                  { value: 'gpt', label: t('searchBackendGpt') },
                ]}
              />
              <p className="pkc-note">{backendHint}</p>
            </div>
          </div>
          {state.available === true && (base !== undefined || runtime !== undefined) && (
            <div className="pkc-status">
              <span className="pkc-dot" data-tone={overridden ? 'warn' : expected !== undefined && base === expected ? 'success' : undefined} />
              <span className="pkc-meta">{fill(t('searchEffective'), { base: base ?? t('searchUnknown'), runtime: runtime ?? base ?? t('searchUnknown') })}</span>
            </div>
          )}
          {overridden && <p className="pkc-warn">{fill(t('searchOverridden'), { base })}</p>}
          {foreign.length > 0 && <p className="pkc-note">{fill(t('searchForeign'), { names: foreign.join(' / ') })}</p>}
          {state.applied?.state === 'failed' && <p className="pkc-error" role="alert">{fill(t('searchApplyFailed'), { error: state.applied.error ?? '' })}</p>}
          {state.available !== true && <p className="pkc-note">{t('searchUnavailable')}</p>}
          {state.writable !== true && <p className="pkc-note">{t('searchNotWritable')}</p>}
          <p className="pkc-note">{t('searchPatchNote')}</p>
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('searchLoadFailed')}: ${error}`}</p>}
    </Card>
  )
}

// ── Claude Code CLI ─────────────────────────────────────────────────────────

const INSTALL_FAILURES = {
  'npm-missing': () => 'cliNpmMissing',
  permission: cli => (cli.platform === 'win32' ? 'cliPermissionWindows' : 'cliPermission'),
  network: () => 'cliNetwork',
  timeout: () => 'cliTimeout',
  'not-found-after-install': () => 'cliNotFoundAfterInstall',
}

/** The sentence explaining a failed install, by the code the host classified. */
function installFailure(cli, t) {
  const key = INSTALL_FAILURES[cli.install?.code]?.(cli)
  return key === undefined ? undefined : fill(t(key), { command: cli.command ?? '' })
}

/**
 * Whether this device has the Claude Code CLI, which version, and — when it
 * has none — a button that installs it with npm.
 */
function ClaudeCliCard({ call, t }) {
  const [cli, setCli] = react.useState()
  const [checking, setChecking] = react.useState(false)
  const [error, setError] = react.useState()
  const [runtime, setRuntime] = react.useState()
  const [runtimeWritable, setRuntimeWritable] = react.useState(false)

  react.useEffect(() => {
    call('status').then(value => {
      setRuntime(value?.claudeRuntime ?? 'http')
      setRuntimeWritable(value?.writable === true)
    }).catch(() => undefined)
  }, [call])

  const changeRuntime = next => {
    setError(undefined)
    call('claude-runtime/update', { runtime: next })
      .then(value => setRuntime(value?.claudeRuntime ?? next))
      .catch(failure => setError(clearMessage(failure)))
  }

  const check = react.useCallback((force = false) => {
    setChecking(true)
    setError(undefined)
    return call('claude-cli/status', { force })
      .then(setCli)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setChecking(false))
  }, [call])

  react.useEffect(() => {
    check(false)
  }, [check])

  const running = cli?.install?.state === 'running'
  react.useEffect(() => {
    if (!running) return undefined
    let live = true
    const timer = window.setInterval(() => {
      call('claude-cli/status').then(value => {
        if (live) setCli(value)
      }).catch(() => undefined)
    }, INSTALL_POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [call, running])

  const install = () => {
    setError(undefined)
    call('claude-cli/install').then(setCli).catch(failure => setError(clearMessage(failure)))
  }

  const usable = cli?.installed === true && cli.version !== undefined
  const failed = cli?.install?.state === 'failed'
  const failure = cli === undefined ? undefined : installFailure(cli, t)
  return (
    <Card
      title={t('cliTitle')}
      aside={<Button disabled={checking || running} onClick={() => check(true)}>{checking ? t('refreshing') : t('cliRecheck')}</Button>}
    >
      <div className="pkc-field">
        <span className="pkc-label">{t('claudeRuntimeTitle')}</span>
        <Segmented
          label={t('claudeRuntimeTitle')}
          value={runtime}
          disabled={!runtimeWritable || runtime === undefined}
          options={[{ value: 'http', label: t('claudeRuntimeHttp') }, { value: 'cli', label: t('claudeRuntimeCli') }]}
          onChange={changeRuntime}
        />
        <span className="pkc-meta">{runtime === 'cli' ? t('claudeRuntimeCliHint') : t('claudeRuntimeHttpHint')}</span>
      </div>
      {cli === undefined && error === undefined && <p className="pkc-note">{t('cliChecking')}</p>}
      {usable && (
        <>
          <div className="pkc-status">
            <span className="pkc-dot" data-tone="success" />
            <span>{t('cliInstalled')}</span>
            <b>{`${t('cliVersion')} ${cli.version}`}</b>
          </div>
          <span className="pkc-meta">{t('cliPath')} <span className="pkc-mono">{cli.path}</span></span>
          {cli.install?.state === 'succeeded' && <p className="pkc-note">{t('cliInstallSucceeded')}</p>}
        </>
      )}
      {cli !== undefined && !usable && (
        <div className="pkc-callout">
          <div className="pkc-status">
            <span className="pkc-dot" data-tone={cli.installed ? 'danger' : 'warn'} />
            <b>{cli.installed ? t('cliBroken') : t('cliMissing')}</b>
          </div>
          {cli.installed && (
            <>
              <span className="pkc-meta">{t('cliPath')} <span className="pkc-mono">{cli.path}</span></span>
              {cli.error !== undefined && <pre className="pkc-detail">{cli.error}</pre>}
            </>
          )}
          {cli.configuredPath !== undefined && <p className="pkc-note">{fill(t('cliConfiguredMissing'), { path: cli.configuredPath })}</p>}
          <p className="pkc-note">{t('cliMissingHint')}</p>
          <div className="pkc-split">
            <Button variant="primary" size="md" disabled={running || checking} onClick={install}>
              {running ? t('cliInstalling') : cli.installed ? t('cliReinstall') : t('cliInstall')}
            </Button>
          </div>
          <p className="pkc-note">
            {fill(t('cliInstallCommand'), { command: cli.command ?? '' })}
            {cli.platform === 'win32' && ` ${t('cliWindowsNote')}`}
          </p>
        </div>
      )}
      {failed && !usable && (
        <>
          <p className="pkc-error">{failure === undefined ? t('cliInstallFailed') : `${t('cliInstallFailed')} · ${failure}`}</p>
          {cli.install.detail !== undefined && cli.install.detail !== '' && <pre className="pkc-detail">{cli.install.detail}</pre>}
        </>
      )}
      {error !== undefined && <p className="pkc-error">{`${t('error')}: ${error}`}</p>}
    </Card>
  )
}

// ── plugin version ──────────────────────────────────────────────────────────

function VersionCard({ call, t }) {
  const [info, setInfo] = react.useState()
  const [loading, setLoading] = react.useState(true)
  const [error, setError] = react.useState(false)
  const [updating, setUpdating] = react.useState(false)
  const [updateFailed, setUpdateFailed] = react.useState(false)
  const [updated, setUpdated] = react.useState()
  const [restartHint, setRestartHint] = react.useState(false)
  const generation = react.useRef(0)

  const load = force => {
    const current = ++generation.current
    setLoading(true)
    setError(false)
    call('plugin/version', { force }).then(value => {
      if (generation.current === current) setInfo(value)
    }).catch(() => {
      if (generation.current === current) setError(true)
    }).finally(() => {
      if (generation.current === current) setLoading(false)
    })
  }

  react.useEffect(() => {
    load(false)
    return () => { generation.current += 1 }
  }, [])

  const update = () => {
    setUpdating(true)
    setUpdateFailed(false)
    call('plugin/update').then(value => {
      setUpdated(value)
      setRestartHint(false)
    }).catch(() => setUpdateFailed(true)).finally(() => setUpdating(false))
  }

  const installKind = info?.install?.kind
  const showStatus = info !== undefined && updated === undefined
  const canUpdate = showStatus && info.updateAvailable && installKind === 'npm'
  return (
    <Card
      title={t('versionTitle')}
      aside={updated === undefined && (
        <span className="pkc-actions">
          {canUpdate && <Button variant="primary" disabled={updating} onClick={update}>{updating ? t('versionUpdating') : t('versionUpdate')}</Button>}
          <Button disabled={loading || updating} onClick={() => load(true)}>{loading ? t('versionChecking') : t('versionCheck')}</Button>
        </span>
      )}
    >
      {loading && info === undefined && <p className="pkc-note" role="status">{t('versionChecking')}</p>}
      {error && <p className="pkc-error" role="alert">{t('versionFailed')}</p>}
      {showStatus && (
        <div className="pkc-status" role="status">
          <span className="pkc-dot" data-tone={info.updateAvailable ? 'warn' : 'success'} />
          <b>{`v${info.current}`}</b>
          <span className="pkc-meta">
            {info.updateAvailable ? fill(t('versionAvailable'), { version: info.latest }) : t('versionUpToDate')}
            {info.updateAvailable && ` · ${t('versionLatest')} v${info.latest}`}
          </span>
        </div>
      )}
      {showStatus && installKind === 'link' && <p className="pkc-note">{t('versionLinked')}</p>}
      {showStatus && info.updateAvailable && installKind === 'unknown' && <p className="pkc-note">{t('versionManual')}</p>}
      {updateFailed && <p className="pkc-error" role="alert">{t('versionUpdateFailed')}</p>}
      {updated !== undefined && (
        <div className="pkc-callout" data-tone="info" role="status">
          <b className="pkc-title">{fill(t('versionUpdated'), { version: updated.version })}</b>
          <p className="pkc-note">{t('versionUpdatedHint')}</p>
          {restartHint && <p className="pkc-note">{t('versionRestartHint')}</p>}
          <div className="pkc-actions">
            <Button variant="primary" onClick={() => window.location.reload()}>{t('versionRefresh')}</Button>
            <Button onClick={() => setRestartHint(true)}>{t('versionRestart')}</Button>
            <Button variant="ghost" onClick={() => setUpdated(undefined)}>{t('versionLater')}</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── the page and the composer chip ──────────────────────────────────────────

function Geek2APISection({ rpc, t }) {
  const call = useCaller(rpc)
  return (
    <div className="pkc">
      <p className="pkc-intro">{t('intro')}</p>
      <AccountsCard call={call} t={t} />
      <HostsCard call={call} t={t} />
      <ModelsCard call={call} t={t} />
      <SearchCard call={call} t={t} />
      <ClaudeCliCard call={call} t={t} />
      <VersionCard call={call} t={t} />
    </div>
  )
}

function Geek2APIComposerQuota({ rpc, t, directory }) {
  const call = useCaller(rpc)
  const snapshot = react.useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const enabled = snapshot?.current?.provider === PROVIDER
  const [balance, setBalance] = react.useState()

  react.useEffect(() => {
    if (!enabled) {
      setBalance(undefined)
      return undefined
    }
    let live = true
    const tick = () => {
      call('balance').then(value => {
        if (live) setBalance(value)
      }).catch(() => {
        if (live) setBalance(undefined)
      })
    }
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [call, enabled])

  if (!enabled || balance === undefined) return null
  const row = activeUsage(balance)
  const usage = row?.usage
  // A key whose balance read failed is still usable; say the read failed
  // instead of claiming there is no key.
  const display = usage?.unlimitedQuota === true
    ? t('keyUnlimited')
    : formatUsd(usage?.availableUsd) ?? (row?.error === undefined ? t('composerNoKey') : t('composerUnread'))
  // A balance carried over from an earlier read is marked as approximate.
  const stale = row?.stale !== undefined && usage !== undefined
  const label = stale
    ? `${t('composerLabel')}: ${display}（${fill(t('composerStale'), { time: readTime(row.stale.fetchedAt) })}）`
    : `${t('composerLabel')}: ${display}`
  return (
    <span className="pkc-composer" role="status" aria-label={label} title={label}>
      {stale ? `≈${display}` : display}
    </span>
  )
}

export const inject = ['slots', 'locale', 'connection', 'modelDirectories']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'geek2api: copy')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-geek2api'
    tag.textContent = STYLE
    document.head.append(tag)
    return () => tag.remove()
  }, 'geek2api: style')
  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'geek2api',
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ rpc: connection.rpc, t }),
  }, Geek2APISection))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'geek2api-balance',
    order: 17,
    locale: NS,
    inject: sessionId => ({
      rpc: connection.rpc,
      t,
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
    }),
  }, Geek2APIComposerQuota))
}
