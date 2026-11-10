import { useEffect, useMemo, useRef, useState } from 'react';
import { Chip, EmptyState, Panel, buttonDanger, buttonQuiet, formatExact } from '@selarikru/ui';
import type { BrainSourceRevisionView } from '@selarikru/view-protocol';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';
import type { BrainPort, ConnectionState } from '../../shell/projection-store.ts';
import { hashWith, useHashQuery } from '../../shell/route.ts';
import { brainModel, conflictCards, parseCitationTarget, type ClaimRow, type ConflictCard, type SourceRow } from './model.ts';
import { useBrain } from './useBrain.ts';

const Exact = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;
const LINK = 'break-all font-mono text-mono text-active underline underline-offset-2';

function Claim({ claim }: { claim: ClaimRow }) {
  return (
    <li data-testid="brain-claim" data-key={claim.key} data-status={claim.status.label} className="rounded-chip border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 font-medium wrap-anywhere text-fg">{claim.heading}</h3>
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip tone={claim.status.tone}>{claim.status.label}</Chip>
          {claim.restricted ? <Chip tone="neutral">{claim.classification}: local workers only</Chip> : null}
        </span>
      </div>
      {/* Source text, rendered as text. It is data, not an instruction. */}
      <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-fg">{claim.text}</p>
      {claim.status.label !== 'Current' ? <p className="mt-1 text-sm text-muted">{claim.status.detail}</p> : null}
      <p className="mt-2 text-sm text-muted">
        <span className="font-mono text-mono">{claim.key}</span>
        <span> · cited from </span>
        {claim.citations.map((c, i) => <span key={c.href}>{i > 0 ? ', ' : ''}<a data-testid="brain-citation" className={LINK} href={c.href}>{c.label}</a></span>)}
      </p>
      {claim.disputedBy.length > 0 ? (
        <p className="mt-1 text-sm text-muted">Disputed by {claim.disputedBy.map((c, i) => <span key={c.href}>{i > 0 ? ', ' : ''}<a className={LINK} href={c.href}>{c.label}</a></span>)}</p>
      ) : null}
    </li>
  );
}

function SourceRevision({ port, target }: { port: BrainPort; target: { sourceId: string; revision: number; anchor: string } }) {
  const [rev, setRev] = useState<BrainSourceRevisionView | null>(null);
  const [failed, setFailed] = useState(false);
  const cited = useRef<HTMLLIElement>(null);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    setRev(null);
    setFailed(false);
    port.source(target.sourceId, target.revision).then((r) => { if (live) setRev(r); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [port, target.sourceId, target.revision]);
  useEffect(() => {
    if (!rev) return;
    const el = cited.current ?? region.current;
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, [rev, target.anchor]);
  const close = hashWith('anchor', null, hashWith('rev', null, hashWith('source', null)));
  return (
    <section ref={region} tabIndex={-1} aria-labelledby="brain-source-title" data-testid="brain-source-view" className="rounded-card border border-active bg-panel p-4 outline-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="brain-source-title" className="text-base font-semibold text-fg wrap-anywhere">{rev ? rev.title : 'Source revision'} <span className="font-mono text-mono text-muted">{target.sourceId} · revision {target.revision}</span></h2>
        <a className={buttonQuiet} href={close}>Close source</a>
      </div>
      {failed ? <p role="alert" className="mt-2 text-danger">This source revision could not be read.</p> : null}
      {!rev && !failed ? <p role="status" className="mt-2 text-muted">Loading the source revision</p> : null}
      {rev ? (
        <>
          <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">Recorded</dt><dd className="m-0"><Exact iso={rev.recordedAt} /></dd>
            <dt className="text-muted">Provenance</dt><dd className="m-0 break-all font-mono text-mono">{rev.provenance.origin}: {rev.provenance.ref}, by {rev.provenance.recordedBy}</dd>
            <dt className="text-muted">Label and use</dt><dd className="m-0">{rev.classification}, {rev.allowedUse.includes('cloud') ? 'local and cloud workers' : 'local workers only'}</dd>
            <dt className="text-muted">Standing</dt><dd className="m-0">{rev.standing === 'accepted' ? 'Accepted' : 'Proposed, never accepted scope'}</dd>
            {rev.revocation ? <><dt className="text-muted">Revoked</dt><dd className="m-0 text-danger"><Exact iso={rev.revocation.revokedAt} />: {rev.revocation.reason}</dd></> : null}
          </dl>
          {rev.sections.length === 0 ? <p className="mt-3 text-muted">This revision states nothing: its record is gone.</p> : (
            <ol className="mt-3 space-y-2">
              {rev.sections.map((s) => {
                const isCited = s.anchor === target.anchor;
                return (
                  <li key={s.anchor} id={`anchor-${s.anchor}`} ref={isCited ? cited : undefined} tabIndex={isCited ? -1 : undefined} data-cited={isCited ? 'true' : undefined} data-testid="brain-source-section"
                    className={`rounded-chip border p-2 outline-none ${isCited ? 'border-active bg-panel-2' : 'border-line'}`}>
                    <p className="text-sm text-muted"><span className="font-mono text-mono">{s.anchor}</span>{isCited ? <span className="ml-2 font-medium text-fg">Cited anchor</span> : null}</p>
                    <p className="font-medium wrap-anywhere text-fg">{s.heading}</p>
                    <p className="whitespace-pre-wrap wrap-anywhere text-fg">{s.text}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}

type Pending = { kind: 'revoke'; source: SourceRow } | { kind: 'keep'; card: ConflictCard };

/** A conflict as a decision proposal. Settling it keeps the accepted value; it never changes accepted scope. */
export function ConflictCardView({ card, live, onKeep }: { card: ConflictCard; live: boolean; onKeep: ((card: ConflictCard) => void) | null }) {
  return (
    <li data-testid="brain-conflict" className="rounded-card border border-warning bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2"><Chip tone="warning">Decision proposed</Chip><h3 className="font-medium wrap-anywhere text-fg">{card.title}</h3></div>
      <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-sm text-muted">Accepted</dt><dd className="m-0 wrap-anywhere text-fg">{card.accepted} <a className={`${LINK} text-sm`} href={card.acceptedCitation.href}>{card.acceptedCitation.label}</a></dd>
        <dt className="text-sm text-muted">Proposed</dt><dd className="m-0 wrap-anywhere text-fg">{card.proposed} <a className={`${LINK} text-sm`} href={card.proposedCitation.href}>{card.proposedCitation.label}</a></dd>
      </dl>
      <p className="mt-2 text-sm text-muted">{card.consequence}</p>
      {onKeep ? (
        <div className="mt-3"><button type="button" className={buttonQuiet} disabled={!live} onClick={() => onKeep(card)}>Keep the accepted value</button>{live ? null : <span className="ml-2 text-sm text-muted">Waiting for a live connection.</span>}</div>
      ) : <p className="mt-3"><a className="font-medium text-active underline underline-offset-2" href={card.href}>Decide in the Project Brain</a></p>}
    </li>
  );
}

/** The Brain's open conflicts on the Decisions screen: each is a decision proposal, decided in the Brain view. */
export function BrainConflicts({ port }: { port: BrainPort | null }) {
  const brain = useBrain(port);
  const cards = useMemo(() => conflictCards(brain.view), [brain.view]);
  if (cards.length === 0) return null;
  return (
    <div className="mt-6" data-testid="decisions-brain">
      <Panel title="Project Brain: decisions proposed" labelId="decisions-brain" aside="A source disagrees with something accepted. Nothing changes until a person decides.">
        <ul className="space-y-3 p-4">{cards.map((c) => <ConflictCardView key={c.conflictId} card={c} live={false} onKeep={null} />)}</ul>
      </Panel>
    </div>
  );
}

export interface BrainViewProps {
  readonly port: BrainPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
  readonly nowMs: number;
}

export function BrainView({ port, connection, mode, nowMs }: BrainViewProps) {
  const brain = useBrain(port);
  const query = useHashQuery();
  const target = parseCitationTarget(query);
  const model = useMemo(() => (brain.view ? brainModel(brain.view, nowMs) : null), [brain.view, nowMs]);
  const cards = useMemo(() => conflictCards(brain.view), [brain.view]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = connection === 'live';

  const confirm = async (): Promise<void> => {
    const p = pending;
    setPending(null);
    if (!p) return;
    const ok = await brain.act(p.kind === 'revoke' ? { kind: 'revoke', sourceId: p.source.sourceId, reason: 'Revoked from the Brain view' } : { kind: 'keep', conflictId: p.card.conflictId });
    if (ok) setNotice(p.kind === 'revoke' ? `Revoked ${p.source.sourceId}. Claims resting only on it are no longer served.` : 'Kept the accepted value. The note no longer disputes it.');
  };

  if (!port) {
    return <EmptyState title="The Project Brain is not available">This connection does not serve the Project Brain.</EmptyState>;
  }
  return (
    <div data-testid="brain-view" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-fg">Project Brain</h1>
          <p className="mt-1 max-w-prose text-muted">Pages derived from the project's source revisions, every claim cited. It is synthesis, not authority: it grants no permission, and restricted claims never go to a cloud worker.</p>
        </div>
        <DemoBadge mode={mode} testId="brain-demo-badge" />
      </header>
      {mode === 'mock' ? <p className="text-sm text-warning">Simulated sources. Nothing here is evidence.</p> : null}
      <p role="status" aria-live="polite" className="text-sm text-fg">{notice ?? ''}</p>
      {brain.error ? <p role="alert" className="text-danger">{brain.error} <button type="button" className={buttonQuiet} onClick={brain.reload}>Try again</button></p> : null}
      {brain.loading && !model ? <p role="status" className="text-muted">Loading the Project Brain</p> : null}
      {model ? (
        <>
          <dl data-testid="brain-freshness" className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-card border border-line bg-panel p-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">Compiled</dt><dd className="m-0 text-fg">{model.freshness.version}{model.freshness.compiledAt ? <>, {model.freshness.compiled} ago (<Exact iso={model.freshness.compiledAt} />)</> : null}</dd>
            <dt className="text-muted">Index lag</dt><dd className="m-0 text-fg">{model.freshness.lag}</dd>
            <dt className="text-muted">Generator</dt><dd className="m-0 break-all font-mono text-mono text-fg">{model.freshness.generator ?? 'None'} (deterministic extraction, no model)</dd>
            <dt className="text-muted">Claims</dt><dd className="m-0 text-fg">{model.counts.current} current, {model.counts.disputed} disputed, {model.counts.stale} stale, {model.counts.unsupported} unsupported</dd>
          </dl>
          {target ? <SourceRevision port={port} target={target} /> : null}
          {cards.length > 0 ? (
            <Panel title="Decisions proposed" labelId="brain-conflicts" aside={`${cards.length} waiting`}>
              <ul className="space-y-3 p-4">{cards.map((c) => <ConflictCardView key={c.conflictId} card={c} live={live} onKeep={(card) => setPending({ kind: 'keep', card })} />)}</ul>
            </Panel>
          ) : null}
          {model.empty ? <EmptyState title="Nothing compiled yet">No source has been recorded for this project.</EmptyState> : null}
          {model.pages.map((p) => (
            <Panel key={p.id} title={p.title} labelId={`brain-page-${p.id}`} aside={`${p.claims.length} claims · ${p.classification}`}>
              {p.claims.length === 0 ? <p className="p-4 text-muted">No claims on this page.</p> : <ul className="space-y-2 p-4">{p.claims.map((c) => <Claim key={c.claimId} claim={c} />)}</ul>}
            </Panel>
          ))}
          <Panel title="Sources" labelId="brain-sources" aside={`${model.sources.length} sources`}>
            <ul className="divide-y divide-line">
              {model.sources.map((s) => (
                <li key={s.sourceId} data-testid="brain-source" data-source={s.sourceId} className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium wrap-anywhere text-fg"><a className="underline underline-offset-2" href={s.href}>{s.title}</a></p>
                    <p className="break-all font-mono text-mono text-muted">{s.sourceId} · revision {s.revision}</p>
                    <p className="text-sm text-muted">{s.kind} · {s.standing} · {s.classification} · {s.use} · {s.provenance} · recorded <Exact iso={s.recordedAt} /></p>
                  </div>
                  <span className="flex items-center gap-2">
                    <Chip tone={s.state === 'Revoked' ? 'danger' : 'neutral'}>{s.state}</Chip>
                    {s.canRevoke ? <button type="button" className={buttonDanger} disabled={!live} onClick={() => setPending({ kind: 'revoke', source: s })}>Revoke<span className="sr-only"> {s.sourceId}</span></button> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}
      {pending ? (
        <ConfirmDialog
          copy={pending.kind === 'revoke'
            ? { title: `Revoke ${pending.source.sourceId}?`, consequence: 'Its revisions stay in the history, but every claim resting only on it stops being served to workers, and the next context bundles list it as revoked. This cannot be undone here.', keepLabel: 'Keep the source' }
            : { title: 'Keep the accepted value?', consequence: 'The note stops disputing this criterion. Accepted scope is unchanged; to change the criterion, use a new blueprint version or a replan.', keepLabel: 'Leave it open' }}
          confirmLabel={pending.kind === 'revoke' ? 'Revoke the source' : 'Keep the accepted value'}
          onConfirm={() => { void confirm(); }}
          onKeep={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
