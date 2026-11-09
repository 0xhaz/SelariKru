import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Chip, buttonDangerSolid, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { AuthorizedTerminalRequest, TerminalControlChannel, TerminalControlInputOutcome, TerminalControlReason, TerminalControlState } from '@selarikru/view-protocol';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';

const REASON: Readonly<Record<TerminalControlReason, string>> = {
  demo: 'Demo data has no shell to type into.',
  ticket_invalid: 'The connection could not be set up. Try again.',
  policy_denied: 'This project’s policy does not allow control mode.',
  trial: 'A benchmark trial never takes human input, so its results stay comparable.',
  restricted: 'Control mode is not offered for restricted or secret work.',
  attempt_not_running: 'This attempt is not running.',
  session_active: 'Someone is already in control of this attempt.',
  unavailable: 'This worker cannot take a control session right now.',
  unauthorized: 'You are not allowed to do that. Sign in again if that is unexpected.',
  connection_failed: 'The connection could not be made.',
  left: 'You left control mode.',
  connection_lost: 'The connection to the shell dropped.',
  idle_timeout: 'Nothing was typed for 5 minutes, so the shell was closed.',
  session_limit: 'The session reached its time limit.',
  attempt_finished: 'The attempt finished, so the shell was closed.',
  attempt_fenced: 'The attempt was fenced or cancelled, so the shell was closed.',
  shell_exited: 'The shell exited.',
  shell_unavailable: 'The shell could not be started in this sandbox.',
  runner_link_lost: 'The connection to the worker’s machine dropped.',
  audit_failed: 'A line could not be recorded, so the session was stopped. Nothing unrecorded was sent.',
  input_limit: 'Too much input was refused, so the session was stopped.',
  server_shutdown: 'The server is shutting down.',
  server_restarted: 'The server restarted, so the session was closed.',
};

const OUTCOME: Readonly<Record<TerminalControlInputOutcome, string>> = {
  recorded: '',
  interrupt: '',
  withheld_echo_off: 'Sent. Its text was not recorded, because the shell was not echoing.',
  withheld_unconfirmed: 'Sent. Its text was not recorded, because the shell did not confirm what it did with it.',
  rate_limited: 'Too fast: that line was not sent.',
  too_long: 'That line was too long and was not sent.',
};

type Mode =
  | { readonly at: 'idle' }
  | { readonly at: 'confirm' }
  | { readonly at: 'open'; readonly state: TerminalControlState };

/** Entered only through a dialog that says what it costs. While on, a banner says so the whole time. Leaving it, closing the drawer or a dropped connection ends it, and the read-only output above is unchanged. */
export function ControlBar({ target, onOpen, canOpen, humanIntervenedAt }: { target: AuthorizedTerminalRequest; onOpen: (request: AuthorizedTerminalRequest) => TerminalControlChannel; canOpen: boolean; humanIntervenedAt: string | null }) {
  const [mode, setMode] = useState<Mode>({ at: 'idle' });
  const channel = useRef<TerminalControlChannel | null>(null);
  const [line, setLine] = useState('');
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);

  // The drawer closing, the tab changing or the attempt changing all end the session: nothing stays connected behind the screen.
  useEffect(() => () => { channel.current?.close(); channel.current = null; }, [target.attemptId]);

  const state = mode.at === 'open' ? mode.state : null;
  const on = state?.phase === 'on';
  const hidden = on && state.echo === false;

  useEffect(() => { if (on) input.current?.focus(); }, [on]);

  const enter = (): void => {
    const opened = onOpen(target);
    channel.current = opened;
    opened.onState((s) => {
      setMode({ at: 'open', state: s });
      if (s.phase === 'on') setNotice('');
      if (s.phase === 'refused' || s.phase === 'ended') channel.current = null;
    });
    opened.onInput((o) => { const copy = OUTCOME[o]; if (copy !== '') setNotice(copy); });
  };

  const send = (e: FormEvent): void => {
    e.preventDefault();
    if (!on) return;
    channel.current?.send(line);
    setLine('');
  };

  const closedReason = state && state.reason !== null ? REASON[state.reason] : null;
  return (
    <div data-testid="control-bar" data-phase={state?.phase ?? 'off'} className="space-y-2 rounded-chip border border-line bg-panel p-3">
      {humanIntervenedAt !== null && !on ? <p className="text-sm text-fg" data-testid="control-marked"><Chip tone="warning">Human-intervened</Chip> <span className="ml-1 text-muted">A person has typed into this attempt’s sandbox.</span></p> : null}

      {mode.at === 'idle' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className={buttonQuiet} disabled={!canOpen} onClick={() => setMode({ at: 'confirm' })}>Take control of the shell</button>
          {!canOpen ? <span className="text-sm text-muted">Only while this attempt’s output is live.</span> : null}
        </div>
      ) : null}

      {mode.at === 'confirm' ? (
        <ConfirmDialog
          copy={{
            title: 'Type into this worker’s sandbox?',
            consequence: 'You will control a real shell inside this attempt’s own sandbox. Doing so marks the attempt as human-intervened, for good, on the attempt, in Evidence and on the pull request. The recorded model cannot vouch for anything you run, and every line is audited. Pressing Enter sends a line to the shell only: it cannot answer a decision, grant access or pass a check, and any change you make still goes through the diff gate and the verifier.',
            keepLabel: 'Stay read-only',
          }}
          confirmLabel="Take control"
          onKeep={() => setMode({ at: 'idle' })}
          onConfirm={() => { setMode({ at: 'open', state: { phase: 'connecting', reason: null, echo: null } }); enter(); }}
        />
      ) : null}

      {state?.phase === 'connecting' ? <p className="text-sm text-muted" role="status" data-testid="control-connecting">Connecting to the shell in this sandbox.</p> : null}

      {on ? (
        <div className="space-y-2" data-testid="control-on">
          <p role="status" data-testid="control-banner" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg">
            <Chip tone="warning">Control mode on</Chip>
            <span>You are typing into {target.attemptId}’s sandbox. Every line is audited.</span>
          </p>
          <p className="text-sm text-muted" data-testid="control-honest">Any shell use marks this attempt as human-intervened, and the recorded model cannot vouch for what a person ran here.</p>
          <form onSubmit={send} className="flex flex-wrap items-end gap-2" autoComplete="off">
            <div className="min-w-0 flex-1 basis-56">
              <label htmlFor="control-input" className="block text-sm font-medium text-fg">{hidden ? 'Hidden input: the shell is not echoing' : 'Line to send'}</label>
              <input id="control-input" ref={input} data-testid="control-input" type={hidden ? 'password' : 'text'} value={line} onChange={(e) => setLine(e.target.value)} maxLength={4096} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="mt-1 w-full rounded-chip border border-line-strong bg-bg px-2 py-1.5 font-mono text-mono text-fg" />
            </div>
            <button type="submit" className={buttonPrimary}>Send</button>
            <button type="button" className={buttonQuiet} onClick={() => channel.current?.interrupt()}>Interrupt (Ctrl-C)</button>
            <button type="button" className={buttonDangerSolid} onClick={() => { channel.current?.close(); channel.current = null; setMode({ at: 'open', state: { phase: 'ended', reason: 'left', echo: null } }); }}>Leave control mode</button>
          </form>
          {hidden ? <p className="text-sm text-muted" data-testid="control-hidden-note">This line is not shown and its text is not recorded.</p> : null}
          {notice !== '' ? <p className="text-sm text-warning" role="status" data-testid="control-notice">{notice}</p> : null}
        </div>
      ) : null}

      {state?.phase === 'refused' ? (
        <div className="space-y-2" data-testid="control-refused">
          <p className="text-sm text-fg" role="status"><Chip tone="neutral">Refused</Chip> <span className="ml-1">{closedReason}</span></p>
          <button type="button" className={buttonQuiet} onClick={() => setMode({ at: 'idle' })}>Dismiss</button>
        </div>
      ) : null}

      {state?.phase === 'ended' ? (
        <div className="space-y-2" data-testid="control-ended">
          <p className="text-sm text-fg" role="status"><Chip tone="neutral">Control mode ended</Chip> <span className="ml-1">{closedReason}</span></p>
          <button type="button" className={buttonQuiet} onClick={() => setMode({ at: 'idle' })}>Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}
