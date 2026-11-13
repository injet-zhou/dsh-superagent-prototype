/** Application configuration as chat entry points, and their cross-repository diagnosis requests. */
import { useState } from 'react'
import type { Application, ApplicationConfig, ApplicationTask } from '../app/applications/types.ts'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, Input, Modal, Switch, Tag, type DotState, type IconName } from './controls.tsx'
import { Field, Fields, ModelField, SourceField, SwitchRow } from './settings-kit.tsx'
import { useAction, usePanel } from './provider.tsx'
import { healthText, localized, readableMarkers, valueLabel, type T } from './text.ts'
import { ConfirmButton, Hint, LoadState, Section, SessionButton, StageMark, When } from './widgets.tsx'

const channels = ['feishu', 'discord', 'wecom'] as const
type Channel = typeof channels[number]

/** Applications require explicit chat lists, so an enabled Source with no listed chats cannot receive requests. */
const chatCount = (sources: ApplicationConfig['sources'], kind: Channel) => {
  const config = sources[kind]?.config as { chats?: unknown[]; channels?: unknown[] } | undefined
  return (kind === 'discord' ? config?.channels?.length : config?.chats?.length) ?? 0
}
const enabledChannels = (app: Application): Channel[] => channels.filter(kind => app.sources[kind]?.enabled && chatCount(app.sources, kind) > 0)
const failuresOf = (app: Application) => Object.entries(app.health ?? {}).filter(([, health]) => health.state === 'error')
const repositoryNames = (app: Application, repositories: ApiResponse<'GET repositories'>) => app.repositories.map(id =>
  repositories.find(repo => repo.id === id)?.name ?? id)

/** Summarize whether an application can receive requests: disabled, failing Source, no chat entry point, or running. */
function applicationMark(t: T, app: Application): { dot: DotState; label: string } {
  if (!app.enabled) return { dot: 'idle', label: t('applicationDisabled') }
  if (failuresOf(app).length) return { dot: 'error', label: t('sourceState.error') }
  const enabled = enabledChannels(app)
  if (!enabled.length) return { dot: 'warning', label: t('applicationNoChats') }
  if (!enabled.some(kind => (app.allowed[kind]?.length ?? 0) > 0)) return { dot: 'warning', label: t('applicationNoAllowed') }
  // Health entries appear once the application's chat adapters mount after a restart.
  if (enabled.every(kind => !app.health?.[kind])) return { dot: 'ongoing', label: t('sourceState.ongoing') }
  if (enabled.some(kind => app.health?.[kind]?.state === 'paused')) return { dot: 'warning', label: t('sourceState.warning') }
  return { dot: 'done', label: t('sourceState.done') }
}

function HealthFailures({ app }: { app: Application }) {
  const { t } = usePanel()
  return <>{failuresOf(app).map(([name, health]) => <p key={name} className="dt-error dt-detail dt-clamp">
    {valueLabel(t, 'health', name)}{t('labelSeparator')}{healthText(t, health)}
  </p>)}</>
}

function ApplicationRow({ app, repositories, open, edit }: {
  app: Application; repositories: ApiResponse<'GET repositories'>; open: () => void; edit: () => void
}) {
  const { t } = usePanel()
  const mark = applicationMark(t, app)
  const chats = enabledChannels(app)
  return <li className="dt-row dt-link dt-application">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <button type="button" className="dt-open" onClick={open}>{app.name}</button>
        <span className="dt-app-state" data-state={mark.dot}><Dot state={mark.dot} label={mark.label} />{mark.label}</span>
      </div>
      <div className="dt-row-meta">
        {chats.length > 0 && <span>{t('applicationChats')}{t('labelSeparator')}{chats.map(kind => valueLabel(t, 'source',
          kind)).join(t('listSeparator'))}</span>}
        <span>{t('applicationRepositories')}{t('labelSeparator')}{repositoryNames(app, repositories).join(t('listSeparator'))}</span>
      </div>
      <HealthFailures app={app} />
    </div>
    <div className="dt-row-actions">
      <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={edit}>{t('applicationEdit')}</Button>
    </div>
  </li>
}

export function ApplicationsPage({ repositories }: { repositories: ApiResponse<'GET repositories'> }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET applications'), [call])
  const [editing, setEditing] = useState<Application | 'new'>()
  const [selected, setSelected] = useState<string>()
  const app = selected ? data?.find(item => item.id === selected) : undefined
  const editor = editing && <ApplicationEditor key={editing === 'new' ? 'new' : editing.id}
    app={editing === 'new' ? undefined : editing} repositories={repositories}
    close={() => setEditing(undefined)} saved={reload} />
  if (app) return <>
    <ApplicationDetail app={app} repositories={repositories} close={() => setSelected(undefined)} edit={() => setEditing(app)} />
    {editor}
  </>
  return <>
    {data && data.length > 0 && <div className="dt-toolbar">
      <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing('new')}>{t('applicationAdd')}</Button>
    </div>}
    {error && <LoadState error={error} loading={false} />}
    {!data && !error && <LoadState loading />}
    {data?.length === 0 && <div className="dt-empty">
      <Hint>{t('applicationEmpty')}</Hint>
      <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing('new')}>{t('applicationAdd')}</Button>
    </div>}
    {data && data.length > 0 && <ul className="dt-list dt-applications">{data.map(entry => <ApplicationRow key={entry.id} app={entry}
      repositories={repositories} open={() => setSelected(entry.id)} edit={() => setEditing(entry)} />)}</ul>}
    {editor}
  </>
}

function ApplicationDetail({ app, repositories, close, edit }: {
  app: Application; repositories: ApiResponse<'GET repositories'>; close: () => void; edit: () => void
}) {
  const { t } = usePanel()
  const mark = applicationMark(t, app)
  const chats = enabledChannels(app)
  const allowed = chats.some(kind => (app.allowed[kind]?.length ?? 0) > 0)
  return <>
    <div className="dt-page-head">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={close}>{t('applications')}</Button>
      <div className="dt-page-title"><h2>{app.name}</h2><span className="dt-actions">
        <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={edit}>{t('applicationEdit')}</Button>
      </span></div>
    </div>
    <div className="dt-row-meta">
      <Dot state={mark.dot} label={mark.label} /><span className="dt-status-text" data-state={mark.dot}>{mark.label}</span>
      {chats.length > 0 && <span>{t('applicationChats')}{t('labelSeparator')}{chats.map(kind => valueLabel(t, 'source',
        kind)).join(t('listSeparator'))}</span>}
      <span>{t('applicationRepositories')}{t('labelSeparator')}{repositoryNames(app, repositories).join(t('listSeparator'))}</span>
    </div>
    {!app.enabled && <Hint>{t('applicationDisabledHint')}</Hint>}
    {app.enabled && chats.length === 0 && <Hint>{t('applicationNoChatsHint')}</Hint>}
    {app.enabled && chats.length > 0 && !allowed && <Hint>{t('applicationNoAllowedHint')}</Hint>}
    <HealthFailures app={app} />
    <ApplicationTasks key={app.id} id={app.id} repositories={repositories} />
  </>
}

const TASK_MARKS: Record<ApplicationTask['state'], { dot: DotState; icon: IconName }> = {
  queued: { dot: 'idle', icon: 'queue' }, investigating: { dot: 'ongoing', icon: 'running' },
  waiting: { dot: 'warning', icon: 'ask' }, working: { dot: 'ongoing', icon: 'running' },
  ready: { dot: 'done', icon: 'decision' }, blocked: { dot: 'error', icon: 'alert' }, stopped: { dot: 'idle', icon: 'stop' },
}
const ended = (task: ApplicationTask) => task.state === 'ready' || task.state === 'stopped'

function ApplicationTaskRow({ task, repositories }: { task: ApplicationTask; repositories: ApiResponse<'GET repositories'> }) {
  const { t, call } = usePanel()
  const retry = useAction(() => call('POST applications/:id/tasks/:taskId/retry', { id: task.applicationId, taskId: task.id }))
  const mark = TASK_MARKS[task.state]
  const state = valueLabel(t, 'applicationState', task.state)
  return <li className="dt-row dt-ticket" data-state={task.state === 'blocked' ? 'error' : undefined}>
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={state} /></div>
    <div className="dt-ticket-body">
      <div className="dt-ticket-head">
        <div className="dt-row-title">
          {task.trigger.url ? <a className="dt-inline-link dt-trigger-text" href={task.trigger.url} target="_blank"
            rel="noopener noreferrer" title={task.trigger.text}>{readableMarkers(t, task.trigger.text)}</a>
            : <span className="dt-trigger-text">{readableMarkers(t, task.trigger.text)}</span>}
        </div>
        <div className="dt-ticket-actions">
          <SessionButton sessionId={task.sessionId} label={t('applicationSession')} />
          {task.state === 'blocked' && <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
            disabled={retry.busy} onClick={() => { void retry.run() }}>{t('retry')}</Button>}
          {!ended(task) && <ConfirmButton variant="outline" icon="stop" label={t('applicationStop')} title={t('applicationStop')}
            message={t('applicationStopConfirm')} onConfirm={() => call('POST applications/:id/tasks/:taskId/stop',
              { id: task.applicationId, taskId: task.id })} />}
        </div>
      </div>
      <div className="dt-row-meta"><When at={task.updatedAt} />
        {task.children.length > 0 && <span>{t('applicationRepositories')}{t('labelSeparator')}{task.children.map(child =>
          repositories.find(repo => repo.id === child.repositoryId)?.name ?? child.repositoryId).join(t('listSeparator'))}</span>}
      </div>
      {task.summary && <p className="dt-event-text dt-clamp" title={task.summary}>{task.summary}</p>}
      {task.error && <p className="dt-error">{t('applicationTaskError', { error: task.error })}</p>}
      {task.deliveryError && <p className="dt-error">{t('applicationDeliveryError', { error: task.deliveryError })}</p>}
      {task.children.length > 0 && <ul className="dt-plain-list">{task.children.map(child => <li key={child.repositoryId}>
        <div className="dt-row-meta">
          <span>{repositories.find(repo => repo.id === child.repositoryId)?.name ?? child.repositoryId}</span>
          <Tag tone="neutral">{child.purpose === 'fix' ? t('applicationFix') : t('applicationInvestigate')}</Tag>
          {child.result?.pr && <a className="dt-inline-link" href={child.result.pr.url} target="_blank"
            rel="noopener noreferrer">PR #{child.result.pr.number}</a>}
        </div>
        {child.result?.summary && <p className="dt-hint dt-clamp">{child.result.summary}</p>}
      </li>)}</ul>}
    </div>
  </li>
}

function ApplicationTasks({ id, repositories }: { id: string; repositories: ApiResponse<'GET repositories'> }) {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET applications/:id/tasks', { id }), [call, id])
  const [history, setHistory] = useState(false)
  const active = data?.filter(task => !ended(task)) ?? []
  const past = data?.filter(ended) ?? []
  return <>
    <Section title={t('applicationTasks')} count={active.length || undefined}>
      {error && <LoadState error={error} loading={false} />}
      {!data && !error && <LoadState loading />}
      {data?.length === 0 && <div className="dt-empty">
        <Hint>{t('applicationNoTasks')}</Hint>
        <Hint>{t('applicationStartHint')}</Hint>
      </div>}
      {data && data.length > 0 && active.length === 0 && <p className="dt-hint">{t('applicationNoActiveTasks')}</p>}
      {active.length > 0 && <ul className="dt-list">{active.map(task => <ApplicationTaskRow key={task.id} task={task}
        repositories={repositories} />)}</ul>}
    </Section>
    {past.length > 0 && <DisclosureRow icon={<Icon name="history" />} open={history} onToggle={() => setHistory(!history)}
      title={<>{t('applicationHistory')} <span className="dt-count">{past.length}</span></>}>
      <div className="dt-disclosure-body"><ul className="dt-list">{past.map(task => <ApplicationTaskRow key={task.id}
        task={task} repositories={repositories} />)}</ul></div>
    </DisclosureRow>}
  </>
}

function ApplicationEditor({ app, repositories, close, saved }: {
  app?: Application; repositories: ApiResponse<'GET repositories'>; close: () => void; saved: () => Promise<void>
}) {
  const { t, call } = usePanel()
  const { data: settings, error } = usePoll(() => call('GET settings'), [call], 30000)
  const [value, setValue] = useState<ApplicationConfig>(() => app ? {
    id: app.id, name: app.name, enabled: app.enabled, repositories: app.repositories, sources: app.sources, allowed: app.allowed, model: app.model,
  } : { id: `app-${crypto.randomUUID().slice(0, 8)}`, name: '', enabled: true, repositories: [], sources: {}, allowed: {}, model: null })
  const [transfer, setTransfer] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const mutation = useAction(async () => {
    if (app) await call('PUT applications/:id', { id: app.id, body: { value, revision: app.revision, transfer } })
    else await call('POST applications', { body: { value, revision: 0, transfer } })
    await saved(); close()
  })
  const chats = channels.some(kind => value.sources[kind]?.enabled && chatCount(value.sources, kind) > 0)
  return <Modal open onClose={() => { if (!mutation.busy) close() }} title={app ? t('applicationEdit') : t('applicationAdd')}
    className="dt-application-modal" closeLabel={t('close')} description={t('applicationEditorHint')} footer={<>
      <Button disabled={mutation.busy} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form="dt-application" disabled={mutation.busy || !settings || !value.name.trim() || !value.repositories.length}>{t('save')}</Button>
    </>}>
    <form id="dt-application" className="dt-form" onSubmit={event => { event.preventDefault(); void mutation.run() }}>
      <Fields disabled={mutation.busy}>
        <Field label={t('applicationName')}><Input value={value.name} required onChange={event => setValue({ ...value, name: event.target.value })} /></Field>
        <SwitchRow label={t('applicationEnabled')} checked={value.enabled} onChange={enabled => setValue({ ...value, enabled })} />
        <fieldset className="dt-fieldset"><legend>{t('applicationRepositories')}<span className="dt-count">{value.repositories.length}</span></legend>
          {repositories.length > 0 ? <div className="dt-check-list">{repositories.map(repo => <label key={repo.id} className="dt-check">
            <input type="checkbox" checked={value.repositories.includes(repo.id)}
              onChange={event => setValue({ ...value, repositories: event.target.checked ? [...value.repositories, repo.id] : value.repositories.filter(id => id !== repo.id) })} />
            <span className="dt-row-label" title={repo.name}>{repo.name}</span>
          </label>)}</div> : <Hint>{t('applicationNoRepositories')}</Hint>}
          {repositories.length > 0 && !value.repositories.length && <Hint>{t('applicationPickRepository')}</Hint>}
        </fieldset>
        {error && <LoadState error={error} loading={false} />}
        {!settings && !error && <Hint>{t('loading')}</Hint>}
        {channels.map(kind => {
          const source = settings?.sources.find(source => source.id === kind)
          if (!source?.installed) return null
          const enabled = value.sources[kind]?.enabled ?? false
          const config = value.sources[kind]?.config ?? { ...source.value.config, directMessages: false, otherChats: 'none', chats: [], channels: [] }
          const edit = (key: string, next: unknown) => setValue({ ...value, sources: { ...value.sources, [kind]: { enabled, config: { ...config, [key]: next } } } })
          return <fieldset key={kind} className="dt-fieldset"><legend className="dt-sr-only">{localized(t, source.title)}</legend>
            <div className="dt-subhead">
              <span className="dt-field-head">{localized(t, source.title)}</span>
              <Switch label={localized(t, source.title)} checked={enabled} onChange={next => {
                const clean: Record<string, unknown> = { ...source.value.config, directMessages: false, otherChats: 'none' }
                if (kind === 'discord') { delete (clean as Record<string, unknown>).directMessages; delete (clean as Record<string, unknown>).otherChats; clean.channels = [] }
                else clean.chats = []
                setValue({ ...value, sources: { ...value.sources, [kind]: { enabled: next, config: value.sources[kind]?.config ?? clean } } })
              }} />
            </div>
            {enabled && <>
              {source.fields.filter(field => ['cli', 'tokenFile', 'secretFile', 'wsUrl', 'chats', 'channels'].includes(field.key)).map(field => <SourceField
                key={field.key} field={field} value={config[field.key]} saved={app?.sources[kind]?.config[field.key]} fact={undefined} labels={{}} onChange={next => edit(field.key, next)} />)}
              {source.policy?.fields.filter(field => field.key === 'allowed').map(field => <SourceField key={field.key} field={field}
                value={value.allowed[kind] ?? []} saved={app?.allowed[kind] ?? []} fact={undefined} labels={{}}
                onChange={next => setValue({ ...value, allowed: { ...value.allowed, [kind]: next as ApplicationConfig['allowed'][typeof kind] } })} />)}
            </>}
          </fieldset>
        })}
        <Section title={t('applicationModel')}>
          <ModelField id="application-model" value={value.model} onChange={model => setValue({ ...value, model })} />
        </Section>
        {app && chats && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advanced}
          onToggle={() => setAdvanced(!advanced)}>
          <div className="dt-disclosure-body"><label className="dt-check"><input type="checkbox" checked={transfer}
            onChange={event => setTransfer(event.target.checked)} /><span className="dt-row-label">{t('applicationTransfer')}</span></label></div>
        </DisclosureRow>}
      </Fields>
    </form>
  </Modal>
}
