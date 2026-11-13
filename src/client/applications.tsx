/** Application configuration and the original request's cross-repository progress. */
import { useState } from 'react'
import type { Application, ApplicationConfig, ApplicationTask } from '../app/applications/types.ts'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Input, Modal, Switch } from './controls.tsx'
import { Field, Fields, ModelField, SourceField } from './settings-kit.tsx'
import { useAction, usePanel } from './provider.tsx'
import { localized, valueLabel } from './text.ts'
import { LoadState } from './widgets.tsx'

const channels = ['feishu', 'discord', 'wecom'] as const
export function ApplicationsPage({ repositories }: { repositories: ApiResponse<'GET repositories'> }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET applications'), [call])
  const [editing, setEditing] = useState<Application | 'new'>()
  const [selected, setSelected] = useState<string>()
  return <>
    <div className="dt-toolbar"><Button onClick={() => setEditing('new')}>{t('applicationAdd')}</Button></div>
    {error && <LoadState error={error} loading={false} />}
    {!data && !error && <LoadState loading />}
    {data?.length === 0 && <p>{t('applicationEmpty')}</p>}
    <ul className="dt-list">{data?.map(app => <li key={app.id} className="dt-row">
      <div className="dt-row-main"><div className="dt-row-title">
        <button className="dt-textlink" onClick={() => setSelected(app.id)}>{app.name}</button>
        {!app.enabled && <span>{t('applicationDisabled')}</span>}
      </div><span>{app.repositories.map(id => repositories.find(repo => repo.id === id)?.name ?? id).join(' · ')}</span>
      {Object.values(app.health ?? {}).filter(h => h.state === 'error').map((health, i) => <p key={i} className="dt-error">{health.detail}</p>)}</div>
      <Button onClick={() => setEditing(app)}>{t('applicationEdit')}</Button>
    </li>)}</ul>
    {selected && <ApplicationTasks key={selected} id={selected} close={() => setSelected(undefined)} />}
    {editing && <ApplicationEditor key={editing === 'new' ? 'new' : editing.id} app={editing === 'new' ? undefined : editing}
      repositories={repositories} close={() => setEditing(undefined)} saved={reload} />}
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
  const mutation = useAction(async () => {
    if (app) await call('PUT applications/:id', { id: app.id, body: { value, revision: app.revision, transfer } })
    else await call('POST applications', { body: { value, revision: 0, transfer } })
    await saved(); close()
  })
  return <Modal open onClose={() => { if (!mutation.busy) close() }} title={app ? t('applicationEdit') : t('applicationAdd')}
    closeLabel={t('close')} footer={<>
      <Button disabled={mutation.busy} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form="dt-application" disabled={mutation.busy || !settings || !value.name.trim() || !value.repositories.length}>{t('save')}</Button>
    </>}>
    <form id="dt-application" className="dt-form" onSubmit={event => { event.preventDefault(); void mutation.run() }}>
      <Fields disabled={mutation.busy}>
        <Field label={t('applicationName')}><Input value={value.name} required onChange={event => setValue({ ...value, name: event.target.value })} /></Field>
        <Field label={t('applicationEnabled')}><Switch label={t('applicationEnabled')} checked={value.enabled} onChange={enabled => setValue({ ...value, enabled })} /></Field>
        <fieldset className="dt-fieldset"><legend>{t('applicationRepositories')}</legend>
          {repositories.map(repo => <label key={repo.id} className="dt-row-buttons"><input type="checkbox" checked={value.repositories.includes(repo.id)}
            onChange={event => setValue({ ...value, repositories: event.target.checked ? [...value.repositories, repo.id] : value.repositories.filter(id => id !== repo.id) })} />{repo.name}</label>)}
        </fieldset>
        {error && <LoadState error={error} loading={false} />}
        {channels.map(kind => {
          const source = settings?.sources.find(source => source.id === kind)
          if (!source?.installed) return null
          const enabled = value.sources[kind]?.enabled ?? false
          const config = value.sources[kind]?.config ?? { ...source.value.config, directMessages: false, otherChats: 'none', chats: [], channels: [] }
          const edit = (key: string, next: unknown) => setValue({ ...value, sources: { ...value.sources, [kind]: { enabled, config: { ...config, [key]: next } } } })
          return <fieldset key={kind} className="dt-fieldset"><legend>{localized(t, source.title)}</legend>
            <Switch label={localized(t, source.title)} checked={enabled} onChange={next => {
              const clean: Record<string, unknown> = { ...source.value.config, directMessages: false, otherChats: 'none' }
              if (kind === 'discord') { delete (clean as Record<string, unknown>).directMessages; delete (clean as Record<string, unknown>).otherChats; clean.channels = [] }
              else clean.chats = []
              setValue({ ...value, sources: { ...value.sources, [kind]: { enabled: next, config: value.sources[kind]?.config ?? clean } } })
            }} />
            {enabled && <>
              {source.fields.filter(field => ['cli', 'tokenFile', 'secretFile', 'wsUrl', 'chats', 'channels'].includes(field.key)).map(field => <SourceField
                key={field.key} field={field} value={config[field.key]} saved={app?.sources[kind]?.config[field.key]} fact={undefined} labels={{}} onChange={next => edit(field.key, next)} />)}
              {source.policy?.fields.filter(field => field.key === 'allowed').map(field => <SourceField key={field.key} field={field}
                value={value.allowed[kind] ?? []} saved={app?.allowed[kind] ?? []} fact={undefined} labels={{}}
                onChange={next => setValue({ ...value, allowed: { ...value.allowed, [kind]: next as ApplicationConfig['allowed'][typeof kind] } })} />)}
            </>}
          </fieldset>
        })}
        <ModelField id="application-model" value={value.model} onChange={model => setValue({ ...value, model })} />
        <label><input type="checkbox" checked={transfer} onChange={event => setTransfer(event.target.checked)} /> {t('applicationTransfer')}</label>
      </Fields>
    </form>
  </Modal>
}

function ApplicationTasks({ id, close }: { id: string; close: () => void }) {
  const { t, call, openSession } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET applications/:id/tasks', { id }), [call, id])
  const mutation = useAction(async (task: ApplicationTask, operation: 'stop' | 'retry') => {
    if (operation === 'stop') await call('POST applications/:id/tasks/:taskId/stop', { id, taskId: task.id })
    else await call('POST applications/:id/tasks/:taskId/retry', { id, taskId: task.id })
  }, { reload })
  return <section className="dt-form">
    <div className="dt-row-buttons"><h2>{t('applicationTasks')}</h2><Button onClick={close}>{t('close')}</Button></div>
    {error && <LoadState error={error} loading={false} />}
    {!data && !error && <LoadState loading />}
    {data?.length === 0 && <p>{t('applicationNoTasks')}</p>}
    <ul className="dt-list">{data?.map(task => <li key={task.id} className="dt-row"><div className="dt-row-main">
      <div className="dt-row-title">{task.trigger.url ? <a href={task.trigger.url} target="_blank" rel="noreferrer">{task.trigger.text}</a> : task.trigger.text}
        <span>{valueLabel(t, 'applicationState', task.state)}</span></div>
      {task.summary && <p className="dt-prewrap">{task.summary}</p>}
      {task.error && <p className="dt-error">{task.error}</p>}
      {task.deliveryError && <p className="dt-error">{task.deliveryError}</p>}
      <ul>{task.children.map(child => <li key={child.repositoryId}>{child.repositoryId} · {child.purpose === 'fix' ? t('applicationFix') : t('applicationInvestigate')}
        {child.result?.pr && <> · <a href={child.result.pr.url} target="_blank" rel="noreferrer">PR #{child.result.pr.number}</a></>}
        {child.result?.summary && <p>{child.result.summary}</p>}
      </li>)}</ul>
      <div className="dt-row-buttons"><Button onClick={() => openSession(task.sessionId)}>{t('applicationSession')}</Button>
        {task.state !== 'stopped' && <Button disabled={mutation.busy} onClick={() => void mutation.run(task, 'stop')}>{t('applicationStop')}</Button>}
        {task.state === 'blocked' && <Button disabled={mutation.busy} onClick={() => void mutation.run(task, 'retry')}>{t('retry')}</Button>}
      </div>
    </div></li>)}</ul>
  </section>
}
