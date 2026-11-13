/** Repository overview, host-backed repository management, and the independent configuration panel. */
import { useEffect, useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { Button, DisclosureRow, Dot, Icon, Input, Modal, SegmentedTabs, Tag } from './controls.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import type { Route } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { Field, Fields, numberOf, SettingsProvider, useSettings } from './settings-kit.tsx'
import { healthText, valueLabel } from './text.ts'
import { Hint, LoadState, SetupMessage } from './widgets.tsx'
import { ApplicationsPage } from './applications.tsx'

export type RepositoryCatalog = ApiResponse<'GET repositories'>
export type ManagementView = 'repositories' | 'applications' | 'configuration'
export function repositoryState(entry: RepositoryCatalog[number]) {
  const problems = entry.problems ?? []
  const missing = new Set(['repositoryUnset', 'agentCliUnset'])
  if (!entry.error && problems.length && problems.every(problem => missing.has(problem.code))
    && !Object.values(entry.health ?? {}).some(health => health.state === 'error')) return 'setup'
  return entry.error || problems.length || Object.values(entry.health ?? {}).some(health => health.state === 'error' || health.code === 'setupPending')
    ? 'error' : entry.state ?? 'starting'
}
interface RepositoryConfig { id: string; name: string }
export interface ManagementProps {
  view: ManagementView
  entries: RepositoryCatalog | undefined
  error: Error | undefined
  form: DeploymentForm
  scope: string
  configurationRoute: Extract<Route, { page: 'settings' }>
  onScope: (id: string) => void
  onView: (view: ManagementView) => void
  onOpen: (id: string, route?: Route) => void
  reload: () => Promise<void>
}

function GlobalWorkerLimit() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const block = settings.blocks.executor
  const draft = useDraft({ saved: { maxWorkers: String(block.value.maxWorkers) }, revision: block.revision, reload,
    save: async (value, revision) => {
      const result = await call('PUT settings/:block', { block: 'executor', body: { revision,
        value: { ...block.value, maxWorkers: numberOf(value.maxWorkers) } } })
      notify(t('saved'))
      return result
    } })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Field label={t('repositoryWorkerLimit')} hint={t('repositoryWorkerLimitHint')}>
        <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={draft.value.maxWorkers}
          onChange={event => draft.edit({ ...draft.value, maxWorkers: event.target.value })} />
      </Field>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

function Configuration({ form, global, route }: { form: DeploymentForm; global: boolean; route: Extract<Route, { page: 'settings' }> }) {
  const { state, error } = usePanelData()
  if (!state) return <LoadState error={error} loading />
  if (global) return <div className="dt-form">
    <SettingsProvider><GlobalWorkerLimit /></SettingsProvider>
    <DeploymentPage setup={state.setup} form={form} />
  </div>
  return <SettingsPage group={route.query.group} query={route.query} state={state} deploymentForm={form} repositoryOnly />
}

function RepositoryList({ entries, configure, open, remove, editable }: {
  entries: RepositoryCatalog; configure: (id: string) => void; open: ManagementProps['onOpen']
  remove: (entry: RepositoryCatalog[number]) => void; editable: boolean
}) {
  const { t } = usePanel()
  return <ul className="dt-list dt-repositories">{entries.map(entry => {
    const state = repositoryState(entry)
    const dot = state === 'error' ? 'error' : state === 'ready' ? 'done' : state === 'starting' ? 'ongoing' : 'warning'
    const failures = Object.entries(entry.health ?? {}).filter(([, health]) => health.state === 'error')
    return <li key={entry.id} className="dt-row dt-link dt-repository">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <button type="button" className="dt-open" onClick={() => open(entry.id)}>{entry.name === 'Default' && entry.id === 'default'
            ? entry.repository || t('repositoryDefault') : entry.name}</button>
          {entry.id === 'default' && (entry.repository || entry.name !== 'Default') && <Tag tone="quiet">{t('repositoryDefault')}</Tag>}
          <span className="dt-repository-state"><Dot state={dot} />{t(`repositoryState.${state}`)}</span>
        </div>
        {entry.repository && entry.repository !== entry.name && !(entry.id === 'default' && entry.name === 'Default')
          ? <span className="dt-row-meta">{entry.repository}</span> : null}
        <div className="dt-row-meta dt-row-buttons">
          <span>{t('repositoryWorkers', { count: entry.load?.running ?? '—' })}</span>
          <span>{t('repositoryQueued', { count: entry.load?.queued ?? '—' })}</span>
          <button type="button" className="dt-textlink" onClick={() => open(entry.id, { page: 'execution', query: { filter: 'person' } })}>
            {t('repositoryAttention', { count: entry.attention ?? '—' })}</button>
        </div>
        {entry.problems?.map((problem, index) => <p key={index} className="dt-error"><SetupMessage problem={problem} /></p>)}
        {entry.error ? <p className="dt-error dt-detail">{entry.error}</p>
          : failures.filter(([name, health]) => name !== 'runtime' || !entry.problems?.some(problem => problem.detail === health.detail)).map(([name, health]) =>
            <p key={name} className="dt-error dt-detail">{valueLabel(t, 'health', name)}: {healthText(t, health)}</p>)}
      </div>
      <div className="dt-row-actions">
        <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={() => configure(entry.id)}>{t('repositoryConfigure')}</Button>
        {entry.id !== 'default' && editable && <Button size="sm" icon={<Icon name="trash" size={14} />}
          aria-label={t('repositoryRemoveNamed', { name: entry.name })} onClick={() => remove(entry)} />}
      </div>
    </li>
  })}</ul>
}

export function ManagementPanel({ view, entries, error, form, scope, configurationRoute, onScope, onView, onOpen, reload }: ManagementProps) {
  const { t, notify, restart, call } = usePanel()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<RepositoryCatalog[number]>()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [pending, setPending] = useState<{ id: string; adding: boolean; timedOut?: boolean }>()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  const configured = (snapshot?.value?.repositories ?? []) as RepositoryConfig[]
  const configure = (id: string) => { onScope(id); onView('configuration') }
  useEffect(() => {
    if (!pending || !entries || entries.some(entry => entry.id === pending.id) !== pending.adding) return
    setPending(undefined)
    if (pending.adding) {
      try { sessionStorage.setItem(`dsh-superagent/onboarding/${pending.id}`, '0') } catch { /* Progress is optional. */ }
      configure(pending.id)
    }
  }, [pending, entries])
  useEffect(() => {
    if (!pending || pending.timedOut) return
    const timer = setTimeout(() => setPending(current => current ? { ...current, timedOut: true } : current), 30_000)
    return () => clearTimeout(timer)
  }, [pending])
  const mutation = useAction(async (next: RepositoryConfig[], target: { id: string; adding: boolean }) => {
    if (!target.adding) {
      const app = (await call('GET applications')).find(app => app.repositories.includes(target.id))
      if (app) throw new Error(t('applicationRepositoryUsed', { name: app.name }))
    }
    if (!editable || !form || !await form.mutate([{ op: 'set', path: ['repositories'], value: next }], snapshot.revision)) {
      throw new Error(t('repositorySaveRefused'))
    }
    setAdding(false); setRemoving(undefined); setPending(target)
    notify(t('savedRestarting')); restart()
    void reload()
  })
  const invalid = id === 'default' ? t('repositoryIdReserved') : id && !/^[a-z][a-z0-9-]{0,47}$/.test(id) ? t('repositoryIdInvalid')
    : configured.some(entry => entry.id === id) || entries?.some(entry => entry.id === id) ? t('repositoryIdTaken') : undefined
  const valid = !!id && !invalid
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    void mutation.run([...configured, { id, name: name.trim() || id }], { id, adding: true })
  }
  const readOnly = !form ? t('repositoryNoForms') : snapshot?.mode === 'memory' ? t('repositoryReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('repositoryUnavailable') : t('repositoryReadOnly')
  const load = entries?.find(entry => entry.globalLoad)?.globalLoad
  return <div className="dt-page"><div className="dt-column">
    <header className="dt-head">
      <h1 className="dt-title">{t('title')}</h1>
      <div className="dt-toolbar">
        {entries && entries.length > 1 && load && <span className="dt-hint">{t('repositoryGlobalLoad', load)}</span>}
        {view === 'repositories' && <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} disabled={!editable || mutation.busy || !!pending}
          onClick={() => {
            let next: string
            do { next = `repo-${crypto.randomUUID().slice(0, 8)}` } while (configured.some(entry => entry.id === next) || entries?.some(entry => entry.id === next))
            setId(next); setName(''); setAdvanced(false); setAdding(true)
          }}>{t('repositoryAdd')}</Button>}
      </div>
    </header>
    <SegmentedTabs value={view} onChange={onView} label={t('title')}
      items={(['repositories', 'applications', 'configuration'] as const).map(value => ({ value, label: t(value === 'repositories' ? 'repositoryOverview' : value === 'applications' ? 'applications' : 'repositorySettings'),
        id: `dt-management-${value}`, panelId: 'dt-management' }))} />
    <main id="dt-management" role="tabpanel" aria-labelledby={`dt-management-${view}`} className="dt-main">
      {error && <LoadState error={error} loading={false} />}
      {pending && <div className="dt-row-meta dt-row-buttons">
        <p role={pending.timedOut ? 'alert' : 'status'} className={pending.timedOut ? 'dt-error' : 'dt-hint'}>
          {t(pending.timedOut ? 'repositoryReloadTimeout' : 'repositoryReloading')}</p>
        {pending.timedOut && <Button size="sm" onClick={() => { setPending({ ...pending, timedOut: false }); void reload() }}>{t('repositoryCheckAgain')}</Button>}
        <Button size="sm" onClick={() => setPending(undefined)}>{t('repositoryStopWaiting')}</Button>
      </div>}
      {view === 'applications' ? <ApplicationsPage repositories={entries ?? []} /> : view === 'repositories' ? <>
        {!editable && <Hint>{readOnly}</Hint>}
        {entries ? <RepositoryList entries={entries} configure={configure} open={onOpen} editable={!!editable && !mutation.busy && !pending}
          remove={setRemoving} /> : !error && <LoadState loading />}
      </> : <>
        <Field label={t('repositorySettingsScope')}>
          <select className="dt-select" value={scope} onChange={event => onScope(event.target.value)}>
            <option value="">{t('repositoryGlobalSettings')}</option>
            {entries?.map(entry => <option key={entry.id} value={entry.id}>{entry.repository || entry.name}</option>)}
          </select>
        </Field>
        <Configuration key={scope} global={!scope} form={form} route={configurationRoute} />
      </>}
    </main>
    <Modal open={adding} onClose={() => { if (!mutation.busy) setAdding(false) }} title={t('repositoryAdd')} closeLabel={t('close')}
      description={t('repositoryAddRestart')} footer={<>
        <Button disabled={mutation.busy} onClick={() => setAdding(false)}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form="dt-repository-add" disabled={!editable || mutation.busy || !valid}>{t('repositoryAdd')}</Button>
      </>}>
      <form id="dt-repository-add" className="dt-form" onSubmit={add}>
        <Fields disabled={mutation.busy}>
          <Field label={t('repositoryName')}><Input value={name} onChange={event => setName(event.target.value)} /></Field>
          <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advanced} onToggle={() => setAdvanced(!advanced)}>
            <Field label={t('repositoryId')} note={invalid ? undefined : t('repositoryIdHint')}>
              <Input value={id} required pattern="[a-z][a-z0-9\-]{0,47}" maxLength={48} spellCheck={false}
                onChange={event => setId(event.target.value.trim())} />
            </Field>
          </DisclosureRow>
          {invalid && <p className="dt-error" role="alert">{invalid}</p>}
        </Fields>
      </form>
    </Modal>
    <Modal open={!!removing} onClose={() => { if (!mutation.busy) setRemoving(undefined) }} title={t('repositoryRemove')}
      closeLabel={t('close')} description={t('repositoryRemoveConfirm', { name: removing?.name || '' })}
      footer={<>
        <Button disabled={mutation.busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!editable || mutation.busy} onClick={() => {
          if (removing) void mutation.run(configured.filter(entry => entry.id !== removing.id), { id: removing.id, adding: false })
        }}>{t('repositoryRemove')}</Button>
      </>} />
  </div></div>
}
