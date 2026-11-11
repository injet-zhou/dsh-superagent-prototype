/** Repository memory settings and evidence review, scoped by the panel's existing API client. */
import { useState } from 'react'
import { ApiError, usePoll } from './api.ts'
import type { MemoryNote, MemoryReview } from '../app/memory/types.ts'
import { Button, Input, Pill, Tag, type TagTone } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, ModelField, SwitchRow, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint, LabelValue, LoadMore, LoadState, PageHead, Section, StatusHead } from './widgets.tsx'
import { valueLabel, when } from './text.ts'

const FILTERS = ['all', 'candidate', 'verified', 'stale', 'retracted'] as const
const TONES: Record<MemoryNote['status'], TagTone> = { candidate: 'warning', verified: 'success', stale: 'quiet', retracted: 'danger' }

export function MemoryStatusPage({ status, query }: { status: typeof FILTERS[number]; query: string }) {
  const { t, call, navigate, notify } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload } = usePoll(() => call('GET memory', { query: { status, query, limit } }), [status, query, limit])
  const consolidate = useAction(async () => {
    const result = await call('POST memory/consolidate')
    notify(t(result.queued ? 'memoryQueued' : !data?.health.enabled ? 'memoryDisabled'
      : !data.health.dreaming ? 'memoryConsolidationOff' : 'memoryNothingQueued'))
  }, { reload })
  const rebuild = useAction(async () => { const result = await call('POST memory/rebuild'); notify(t(result.rebuilt ? 'memoryRebuilt' : 'memoryDisabled')) }, { reload })
  const filter = (next: typeof status, q = query) => { setLimit(20); navigate({ page: 'memory', query: { status: next, q } }, true) }
  return <>
    <StatusHead hint={t('memoryBoundary')} settings="memory" />
    {data && <>
      <div className="dt-row-meta dt-status-line">
        <span className="dt-status-text">{t(data.health.enabled ? 'memoryOn' : 'memoryDisabled')}</span>
        <LabelValue label={t('memoryCallsToday')} value={`${data.health.usedCalls} / ${data.health.dailyCallBudget}`} />
        <LabelValue label={t('memoryPendingCapture')} value={data.health.capturePending} />
        <LabelValue label={t('memoryPendingConsolidation')} value={data.health.consolidationPending} />
      </div>
      {data.health.problem && <p className="dt-error" role="status">{valueLabel(t, 'memoryError', data.health.problem)}</p>}
      {(data.health.lastCaptureAt || data.health.lastConsolidationAt) && <div className="dt-row-meta">
        {data.health.lastCaptureAt && <LabelValue label={t('memoryLastCapture')} value={when(data.health.lastCaptureAt, t('lang'))} />}
        {data.health.lastConsolidationAt && <LabelValue label={t('memoryLastConsolidation')} value={when(data.health.lastConsolidationAt, t('lang'))} />}
      </div>}
    </>}
    <div className="dt-row-buttons">
      <Input aria-label={t('memorySearch')} placeholder={t('memorySearch')} maxLength={200} value={query}
        onChange={event => filter(status, event.target.value)} />
      <Button variant="outline" disabled={consolidate.busy} onClick={() => { void consolidate.run() }}>{t('memoryConsolidate')}</Button>
      <Button variant="ghost" disabled={rebuild.busy} onClick={() => { void rebuild.run() }}>{t('memoryRebuild')}</Button>
    </div>
    <div className="dt-filters">{FILTERS.map(value => <Pill key={value} active={status === value} onClick={() => filter(value)}>
      {t(`memoryStatus.${value}`)}{data && ` ${value === 'all' ? Object.values(data.counts).reduce((sum, count) => sum + count, 0) : data.counts[value]}`}
    </Pill>)}</div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(note => <li key={note.id} className="dt-row">
      <div className="dt-row-main">
        <div className="dt-row-title"><button className="dt-textlink" type="button" onClick={() => navigate({ page: 'memory', id: note.id })}>
          {note.title}</button><Tag tone={TONES[note.status]}>{t(`memoryStatus.${note.status}`)}</Tag>
          {note.reviewRequired && <Tag tone="warning">{t('memoryPendingReview')}</Tag>}</div>
        <p className="dt-hint dt-clamp">{note.snippet}</p>
        <div className="dt-row-meta"><span>{note.scope.paths.join(', ') || t('memoryWholeRepository')}</span>
          <LabelValue label={t('memoryEvidenceCount')} value={note.evidenceCount} /><span>{when(note.updatedAt, t('lang'))}</span></div>
      </div>
    </li>)}</ul> : <Hint>{t(Object.values(data.counts).some(Boolean) || query ? 'memorySearchEmpty'
      : data.health.enabled ? 'memoryEmpty' : 'memoryEnableToCapture')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

export function MemoryNotePage({ id }: { id: string }) {
  const { t, call, openSession, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET memory/:id', { id }), [id])
  const [action, setAction] = useState<MemoryReview['action']>()
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [reviewed, setReviewed] = useState<{ id: string; revision: number; reviewRevision?: number }>()
  const review = useAction(async () => {
    if (!action || !data || !reviewed || reviewed.id !== id || !reason.trim() || action === 'confirm' && !confirmed) return
    try {
      await call('POST memory/:id/review', { id, body: action === 'confirm'
        ? { action, revision: reviewed.revision, reviewRevision: reviewed.reviewRevision, reason, confirmed: true }
        : { action, revision: reviewed.revision, reviewRevision: reviewed.reviewRevision, reason } })
      setAction(undefined); setReason(''); setConfirmed(false)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setConfirmed(false); setReviewed(undefined); if (action !== 'confirm') setAction(undefined)
        await reload(); throw new Error(t('memoryConflict'))
      }
      throw failure
    }
  }, { reload })
  const relatedNoteId = data?.pendingReview?.relatedNoteId
  const snapshot = () => data ? { id, revision: data.note.revision, reviewRevision: data.pendingReview?.revision } : undefined
  const start = (next: MemoryReview['action']) => { setAction(next); setReviewed(snapshot()); setReason(''); setConfirmed(false) }
  return <>
    <PageHead title={data?.note.title ?? t('memoryNote')} />
    <LoadState error={error} loading={!data} />
    {data && <>
      <div className="dt-row-meta"><Tag tone={TONES[data.note.status]}>{t(`memoryStatus.${data.note.status}`)}</Tag>
        <LabelValue label={t('memoryRevision')} value={data.note.revision} />
        <span>{data.note.scope.paths.join(', ') || t('memoryWholeRepository')}{data.note.scope.version && ` · ${data.note.scope.version}`}</span>
      </div>
      <pre className="dt-memory-body">{data.note.body}</pre>
      <Hint>{t('memoryBoundary')}</Hint>
      {data.note.status !== 'retracted' && <div className="dt-row-buttons">
        {(['candidate', 'stale'].includes(data.note.status) || data.pendingReview) && <Button variant="outline" disabled={review.busy} onClick={() => start('confirm')}>{t('memoryConfirm')}</Button>}
        {data.note.status === 'verified' && <Button variant="outline" disabled={review.busy} onClick={() => start('stale')}>{t('memoryStale')}</Button>}
        <Button variant="ghost" disabled={review.busy} onClick={() => start('retract')}>{t('memoryRetract')}</Button>
      </div>}
      {action && <form className="dt-form dt-block" onSubmit={event => { event.preventDefault(); void review.run() }}>
        <Fields disabled={review.busy}>
        <Field label={t('memoryReviewReason')}><textarea className="dt-textarea" rows={3} required maxLength={500} value={reason}
          onChange={event => setReason(event.target.value)} /></Field>
        {action === 'confirm' && <label className="dt-memory-confirm"><input type="checkbox" checked={confirmed}
          onChange={event => { setConfirmed(event.target.checked); setReviewed(event.target.checked ? snapshot() : undefined) }} />{t('memoryReviewDeclaration')}</label>}
        <div className="dt-row-buttons"><Button type="submit" variant="primary" disabled={review.busy || !reason.trim() || reviewed?.id !== id || action === 'confirm' && !confirmed}>
          {t(action === 'confirm' ? 'memorySubmitConfirmation' : 'memorySaveReview')}</Button>
          <Button disabled={review.busy} onClick={() => setAction(undefined)}>{t('cancel')}</Button></div>
        </Fields>
      </form>}
      {data.pendingReview && <Section title={t('memoryPendingReview')}>
        <div className="dt-row-meta"><LabelValue label={t('memoryProposedAction')} value={valueLabel(t, 'memoryProposed', data.pendingReview.action)} />
          <span>{when(data.pendingReview.at, t('lang'))}</span></div>
        <p>{data.pendingReview.reason}</p>
        {relatedNoteId && <Button variant="ghost" onClick={() => navigate({ page: 'memory', id: relatedNoteId })}>{t('memoryCompareNote')}</Button>}
        <ul className="dt-list">{data.pendingReview.sources.map(source => <li key={source.id} className="dt-row"><div className="dt-row-main">
          <span>{valueLabel(t, 'memorySourceState', source.status)}</span><code className="dt-memory-ref">{source.eventRef}</code>
          <Button variant="ghost" size="sm" onClick={() => { void openSession(source.sessionId) }}>{t('memoryOpenSession')}</Button>
        </div></li>)}</ul>
      </Section>}
      <Section title={t('memorySources')}>
        <ul className="dt-list">{data.evidence.map(item => <li key={item.id} className="dt-row"><div className="dt-row-main">
          <div className="dt-row-title"><span>{valueLabel(t, 'memoryEvidence', item.kind)}</span>
            <span className="dt-hint">{when(item.capturedAt, t('lang'))}</span></div>
          <pre className="dt-memory-body">{item.excerpt}</pre>
          <div className="dt-row-buttons"><Button variant="ghost" size="sm" onClick={() => { void openSession(item.sessionId) }}>{t('memoryOpenSession')}</Button></div>
          <code className="dt-memory-ref">{item.eventRef}</code>
        </div></li>)}</ul>
      </Section>
      <Section title={t('memoryHistory')}><ul className="dt-timeline">{data.revisions.map(item => <li key={item.revision} className="dt-event">
        <div className="dt-row-meta"><span>{t('memoryRevision')} {item.revision}</span><span>{valueLabel(t, 'memoryAction', item.action)}</span>
          <span>{when(item.at, t('lang'))}</span></div><p>{item.reason}</p>
      </li>)}</ul></Section>
    </>}
  </>
}

export function MemorySettings() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.memory
  const draft = useBlockDraft('memory', { ...block.value, dailyCallBudget: String(block.value.dailyCallBudget) }, block.revision,
    value => ({ ...value, dailyCallBudget: numberOf(value.dailyCallBudget) }))
  const value = draft.value
  const edit = (patch: Partial<typeof value>) => draft.edit({ ...value, ...patch })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <SwitchRow label={t('memoryEnabled')} checked={value.enabled} onChange={enabled => edit({ enabled })} />
        <SwitchRow label={t('memoryRetrieval')} checked={value.retrieval} onChange={retrieval => edit({ retrieval })} />
        <SwitchRow label={t('memoryCapture')} checked={value.autoCapture} onChange={autoCapture => edit({ autoCapture })} />
        <SwitchRow label={t('memoryDreaming')} checked={value.dreaming} onChange={dreaming => edit({ dreaming })} />
        <Field label={t('memoryBudget')} hint={t('memoryBudgetHint')}>
          <Input type="number" min={0} max={100} required value={value.dailyCallBudget}
            onChange={event => edit({ dailyCallBudget: event.target.value })} />
        </Field>
        <Section title={t('memoryModel')} hint={t('memoryModelHint')}>
          <ModelField id="dt-memory-model" explicit value={value.analyzerModel} onChange={analyzerModel => edit({ analyzerModel })} />
        </Section>
        {(value.autoCapture || value.dreaming) && (!value.analyzerModel || Number(value.dailyCallBudget) === 0) &&
          <Hint>{t(!value.analyzerModel ? 'memoryNeedsModel' : 'memoryZeroBudget')}</Hint>}
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['memory']} />
  </div>
}
