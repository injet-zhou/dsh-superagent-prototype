/** Repository onboarding uses the same versioned settings and drafts as the full settings pages. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { worktreeCommand, type WorkspaceCheck } from '../workspace.ts'
import { usePoll, type SourceView, type Settings } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, Input } from './controls.tsx'
import { saveBarText, type DraftState } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Field, Fields, SourceField, SwitchRow, useBlockDraft, useSettings } from './settings-kit.tsx'
import { healthText, localized } from './text.ts'
import { Hint, LoadState, SetupMessage, When } from './widgets.tsx'

const STEPS = ['repository', 'chat', 'workspace', 'check'] as const
function DraftError({ state }: { state: DraftState<unknown, unknown> }) {
  const { t } = usePanel()
  const { error } = saveBarText(t, state)
  return error ? <p className="dt-error" role="alert">{error}</p> : null
}
function Next({ disabled }: { disabled: boolean }) {
  const { t } = usePanel()
  return <div className="dt-actions"><Button type="submit" variant="primary" disabled={disabled}>{t('onboardingNext')}</Button></div>
}
function ConfigFields({ source, value, onChange, keys }: {
  source: SourceView; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; keys: string[]
}) {
  return <>{source.fields.filter(field => keys.includes(field.key)).map(field => <SourceField key={field.key} field={field}
    value={value[field.key]} saved={source.value.config[field.key]} labels={source.labels} fact={undefined}
    onChange={next => onChange({ ...value, [field.key]: next })} />)}</>
}
function RepositoryStep({ next }: { next: () => void }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  const source = settings.sources.find(source => source.id === 'github')!
  const draft = useBlockDraft('source:github', source.value, source.revision)
  const policy = useBlockDraft('policy', settings.blocks.policy.value, settings.blocks.policy.revision)
  const part: Settings['policy']['sources'][string] = policy.value.sources.github ?? { allowed: [], admission: {} }
  const config = draft.value.config
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await policy.submit() && await draft.submit()) next()
  }
  return <form className="dt-form" onSubmit={event => { void submit(event) }}>
    <Fields disabled={draft.busy || policy.busy}>
      {source.problem && <p className="dt-error"><SetupMessage problem={source.problem} /></p>}
      <ConfigFields source={source} value={config} onChange={config => draft.edit({ ...draft.value, enabled: true, config })}
        keys={['provider', ...config.provider === 'github' ? [] : ['baseUrl'], 'repository', 'cli']} />
      {source.policy?.fields.filter(field => field.key === 'allowed').map(field => <SourceField key={field.key} field={field}
        value={part.allowed} saved={settings.blocks.policy.value.sources.github?.allowed} labels={source.labels} fact={undefined}
        onChange={allowed => policy.edit({ ...policy.value, sources: { ...policy.value.sources, github: { ...part, allowed: allowed as typeof part.allowed } } })} />)}
    </Fields>
    <DraftError state={draft.state} /><DraftError state={policy.state} />
    {(draft.dirty || policy.dirty) && <Button disabled={draft.busy || policy.busy} onClick={() => { draft.discard(); policy.discard() }}>{t('discard')}</Button>}
    <Next disabled={draft.busy || policy.busy || !String(config.repository ?? '').trim() || !String(config.cli ?? '').trim() || !part.allowed.length} />
  </form>
}

export function WecomMessages({ config, allowed, onBind, onAllow }: {
  config: Record<string, unknown>; allowed: { id: string }[]; onBind: (chatId: string) => void; onAllow: (userId: string) => void
}) {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET sources/:id/discovery', { id: 'wecom' }), [call])
  const refresh = useAction(reload)
  const copy = useAction(async (id: string) => { await navigator.clipboard.writeText(id); notify(t('copied')) })
  const chats = (config.chats ?? []) as { chatId: string }[]
  return <section className="dt-form" aria-label={t('onboardingRecent')}>
    <div className="dt-row-title"><h3 className="dt-section-title">{t('onboardingRecent')}</h3>
      <Button size="sm" disabled={refresh.busy} onClick={() => { void refresh.run() }}>{t('onboardingRefresh')}</Button></div>
    <Hint>{t('onboardingMessageHint')}</Hint>
    <LoadState error={error} loading={!data} />
    {data?.length === 0 && <Hint>{t('onboardingNoMessages')}</Hint>}
    <ul className="dt-list">{data?.map(message => {
      const bound = chats.some(chat => chat.chatId === message.chatId)
      const listed = allowed.some(person => person.id === message.userId)
      return <li key={message.id} className="dt-row dt-discovery-row"><div className="dt-row-main">
        <div className="dt-row-title dt-detail">{message.preview}</div>
        <div className="dt-row-meta"><When at={message.at} />{message.filtered && <span>{t('onboardingFiltered')}</span>}</div>
        {[...message.chatId ? [[t('onboardingChatId'), message.chatId]] : [], [t('onboardingUserId'), message.userId]].map(([label, id]) =>
          <div key={label} className="dt-row-meta"><span className="dt-detail">{label}: {id}</span>
            <Button size="sm" aria-label={`${t('onboardingCopy')} ${id}`} disabled={copy.busy} onClick={() => { void copy.run(id!) }}>{t('onboardingCopy')}</Button></div>)}
        <div className="dt-actions">
          {message.chatId && <Button size="sm" disabled={bound} onClick={() => onBind(message.chatId)}>{t(bound ? 'onboardingBound' : 'onboardingBind')}</Button>}
          <Button size="sm" disabled={listed} onClick={() => onAllow(message.userId)}>{t(listed ? 'onboardingAllowed' : 'onboardingAllow')}</Button>
        </div>
      </div></li>
    })}</ul>
  </section>
}
function ChatStep({ source, next }: { source: SourceView; next: () => void }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  const draft = useBlockDraft('source:wecom', source.value, source.revision)
  const policy = useBlockDraft('policy', settings.blocks.policy.value, settings.blocks.policy.revision)
  const [manual, setManual] = useState(false)
  const config = draft.value.config
  const part: Settings['policy']['sources'][string] = policy.value.sources.wecom ?? { allowed: [], admission: {} }
  const edit = (config: Record<string, unknown>) => draft.edit({ ...draft.value, config })
  const allow = (id: string) => policy.edit({ ...policy.value, sources: { ...policy.value.sources,
    wecom: { ...part, allowed: [...part.allowed, { id }] } } })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await policy.submit() && await draft.submit()) next()
  }
  return <form className="dt-form" onSubmit={event => { void submit(event) }}>
    <Hint>{t('onboardingChatOptional')}</Hint>
    <Fields disabled={draft.busy || policy.busy}>
      {source.problem && <p className="dt-error"><SetupMessage problem={source.problem} /></p>}
      <SwitchRow label={t('sourceEnable', { name: localized(t, source.title) })} checked={draft.value.enabled}
        onChange={enabled => draft.edit({ ...draft.value, enabled })} />
      <ConfigFields source={source} value={config} onChange={edit} keys={['secretFile']} />
      <div className="dt-actions"><Button disabled={draft.busy || !draft.dirty || !draft.value.enabled || !config.secretFile} onClick={() => { void draft.submit() }}>{t('onboardingConnect')}</Button></div>
      <WecomMessages config={config} allowed={part.allowed} onAllow={allow}
        onBind={chatId => edit({ ...config, chats: [...(config.chats ?? []) as object[], { chatId }] })} />
      <DisclosureRow icon={<Icon name="settings" />} title={t('onboardingManual')} open={manual} onToggle={() => setManual(!manual)}>
        <div className="dt-disclosure-body dt-form">
          <ConfigFields source={source} value={config} onChange={edit} keys={['chats', 'otherChats', 'directMessages', 'wsUrl']} />
          {source.policy?.fields.map(field => <SourceField key={field.key} field={field} value={part[field.key]}
            saved={settings.blocks.policy.value.sources.wecom?.[field.key]} labels={source.labels} fact={undefined}
            onChange={value => policy.edit({ ...policy.value, sources: { ...policy.value.sources, wecom: { ...part, [field.key]: value } } })} />)}
        </div>
      </DisclosureRow>
    </Fields>
    <DraftError state={draft.state} /><DraftError state={policy.state} />
    {(draft.dirty || policy.dirty) && <Button disabled={draft.busy || policy.busy} onClick={() => { draft.discard(); policy.discard() }}>{t('discard')}</Button>}
    <div className="dt-actions"><Button disabled={draft.busy || policy.busy || draft.dirty || policy.dirty} onClick={next}>{t('onboardingSkip')}</Button>
      <Button type="submit" variant="primary" disabled={draft.busy || policy.busy || !draft.value.enabled || !config.secretFile}>{t('onboardingNext')}</Button></div>
  </form>
}

/** Parse only our own generated recipe, leaving custom shell commands untouched. */
export function recipePath(command: string): string {
  const match = /^git -C '((?:[^']|'\\'')*)' fetch --no-tags '((?:[^']|'\\'')*)' /.exec(command)
  if (!match) return ''
  const path = match[1]!.replaceAll("'\\''", "'")
  const remote = match[2]!.replaceAll("'\\''", "'")
  return worktreeCommand(path, remote) === command ? path : ''
}
export function WorkspaceBuilder({ command, onChange }: { command: string; onChange: (command: string) => void }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const config = settings.sources.find(source => source.id === 'github')?.value.config
  const [path, setPath] = useState(() => recipePath(command))
  const [checked, setChecked] = useState<{ path: string; value: WorkspaceCheck }>()
  const check = useAction(async () => { const value = await call('POST setup/workspace/check', { body: { path } }); setChecked({ path, value }) })
  const [advanced, setAdvanced] = useState(!!command && !recipePath(command))
  const remote = `${config?.provider === 'github' || !config?.provider ? 'https://github.com' : String(config.baseUrl ?? '').replace(/\/$/, '')}/${config?.repository ?? ''}.git`
  return <div className="dt-form">
    <Field label={t('onboardingLocalPath')} note={t('onboardingWorkspaceHint')}><Input value={path} placeholder="/home/agent/projects/repository"
      onChange={event => setPath(event.target.value)} /></Field>
    {command && !recipePath(command) && <Hint>{t('onboardingCustom')}</Hint>}
    <div className="dt-actions">
      <Button disabled={!path.startsWith('/') || !config?.repository} onClick={() => onChange(worktreeCommand(path.trim(), remote))}>{t('onboardingGenerate')}</Button>
      <Button disabled={!path.startsWith('/') || check.busy} onClick={() => { void check.run() }}>{t('onboardingCheckWorkspace')}</Button>
    </div>
    {checked?.path === path && <p role="status" className={checked.value.ok ? 'dt-hint' : 'dt-error'}>{t(`workspaceCheck.${checked.value.code}`)}</p>}
    <DisclosureRow icon={<Icon name="settings" />} title={t('prepareCommand')} open={advanced} onToggle={() => setAdvanced(!advanced)}>
      <div className="dt-disclosure-body"><textarea className="dt-textarea dt-mono" aria-label={t('prepareCommand')} rows={5}
        value={command} onChange={event => onChange(event.target.value)} /></div>
    </DisclosureRow>
  </div>
}
function WorkspaceStep({ next }: { next: () => void }) {
  const { settings } = useSettings()
  const block = settings.blocks.executor
  const draft = useBlockDraft('executor', block.value, block.revision)
  return <form className="dt-form" onSubmit={event => { event.preventDefault(); void draft.submit().then(saved => { if (saved) next() }) }}>
    <Fields disabled={draft.busy}><WorkspaceBuilder command={draft.value.prepare} onChange={prepare => draft.edit({ ...draft.value, prepare })} /></Fields>
    <DraftError state={draft.state} /><Next disabled={draft.busy || !draft.value.prepare.trim()} />
  </form>
}
function CheckRow({ label, passed, detail, fix }: { label: string; passed: boolean; detail?: ReactNode; fix: () => void }) {
  const { t } = usePanel()
  return <li className="dt-row"><Dot state={passed ? 'done' : 'warning'} /><div className="dt-row-main">
    <span className="dt-row-title">{label}</span><span className="dt-row-meta">{detail ?? t(passed ? 'onboardingPassed' : 'onboardingPending')}</span>
  </div><Button size="sm" onClick={fix}>{t('repositoryConfigure')}</Button></li>
}
function Checks({ go }: { go: (step: number) => void }) {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const { settings } = useSettings()
  const wecom = settings.sources.find(source => source.id === 'wecom')
  const chat = !!wecom?.value.enabled && !!wecom.value.config.secretFile
  const { data: statuses } = usePoll(() => call('GET sources'), [call])
  const { data: messages } = usePoll(() => chat ? call('GET sources/:id/discovery', { id: 'wecom' }) : Promise.resolve([]), [call, chat])
  const path = recipePath(settings.blocks.executor.value.prepare)
  const signature = JSON.stringify([settings.blocks.executor, settings.sources.find(source => source.id === 'github')?.value])
  const [checked, setChecked] = useState<{ signature: string; result: WorkspaceCheck }>()
  const workspace = checked?.signature === signature ? checked.result : undefined
  const check = useAction(async () => setChecked({ signature, result: await call('POST setup/workspace/check', { body: { path } }) }))
  const health = statuses?.find(source => source.id === 'wecom')
  const allowed = settings.blocks.policy.value.sources.wecom?.allowed ?? []
  const chats = (wecom?.value.config.chats ?? []) as { chatId: string }[]
  const received = messages?.some(message => allowed.some(person => person.id === message.userId) && (message.chatId
    ? chats.some(chat => chat.chatId === message.chatId) || wecom?.value.config.otherChats === 'mentions'
    : wecom?.value.config.directMessages === true))
  return <div className="dt-form"><Hint>{t('onboardingCheckHint')}</Hint><ul className="dt-list">
    <CheckRow label={t('onboardingAccountCheck')} passed={!!state?.setup.accounts && !state.setup.problem} fix={() => go(0)}
      detail={state?.setup.problem ? <SetupMessage problem={state.setup.problem} /> : undefined} />
    {chat ? <>
      <CheckRow label={t('onboardingBotCheck')} passed={health?.state === 'ready'} fix={() => go(1)}
        detail={health?.health.find(part => part.state === 'error') ? healthText(t, health.health.find(part => part.state === 'error')!) : undefined} />
      <CheckRow label={t('onboardingMessageCheck')} passed={!!received} fix={() => go(1)} />
    </> : <CheckRow label={t('onboardingBotCheck')} passed={false} detail={t('onboardingNoChat')} fix={() => go(1)} />}
    <CheckRow label={t('onboardingWorkspaceCheck')} passed={!!workspace?.ok} fix={() => go(2)}
      detail={workspace ? t(`workspaceCheck.${workspace.code}`) : path ? undefined : t('onboardingCustomCheck')} />
  </ul>{path && <Button disabled={check.busy} onClick={() => { void check.run() }}>{t('onboardingCheckWorkspace')}</Button>}
    <div className="dt-actions"><Button variant="primary" onClick={() => navigate({ page: 'overview' })}>{t('onboardingDone')}</Button></div>
  </div>
}
export function Onboarding() {
  const { t, repositoryId, navigate } = usePanel()
  const { settings } = useSettings()
  const key = `dsh-superagent/onboarding/${repositoryId}`
  const [step, setStep] = useState(() => {
    try { const stored = sessionStorage.getItem(key); if (stored !== null && /^[0-3]$/.test(stored)) return Number(stored) } catch { /* Optional progress. */ }
    const config = settings.sources.find(source => source.id === 'github')?.value.config
    return !config?.repository || !config.cli ? 0 : !settings.sources.find(source => source.id === 'wecom')?.value.config.secretFile ? 1 : !settings.blocks.executor.value.prepare ? 2 : 3
  })
  const content = useRef<HTMLElement>(null)
  useEffect(() => { content.current?.focus({ preventScroll: true }) }, [step])
  const go = (next: number) => { setStep(next); try { sessionStorage.setItem(key, String(next)) } catch { /* Optional progress. */ } }
  const wecom = settings.sources.find(source => source.id === 'wecom' && source.installed)
  return <div className="dt-form dt-onboarding">
    <header><p className="dt-hint">{t('onboardingStep', { step: step + 1 })}</p><h2 className="dt-block-title">{t('onboardingTitle')}</h2></header>
    <ol className="dt-onboarding-steps" aria-label={t('settingsGroup.onboarding')}>{STEPS.map((name, index) => <li key={name}>
      <button type="button" aria-current={index === step ? 'step' : undefined} onClick={() => go(index)}>{t(`onboarding.${name}`)}</button>
    </li>)}</ol>
    <section ref={content} tabIndex={-1} key={step} aria-label={t(`onboarding.${STEPS[step]!}`)} className="dt-form">
      {step === 0 ? <RepositoryStep next={() => go(1)} /> : step === 1 ? wecom ? <ChatStep source={wecom} next={() => go(2)} />
        : <><Hint>{t('onboardingNoWecom')}</Hint><Button onClick={() => go(2)}>{t('onboardingSkip')}</Button></>
        : step === 2 ? <WorkspaceStep next={() => go(3)} /> : <Checks go={go} />}
    </section>
    <div className="dt-actions">{step > 0 && <Button onClick={() => go(step - 1)}>{t('onboardingBack')}</Button>}
      <Button onClick={() => navigate(settingsRoute('source'))}>{t('advanced')}</Button></div>
  </div>
}
