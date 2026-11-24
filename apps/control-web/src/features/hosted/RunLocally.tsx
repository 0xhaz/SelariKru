import { useEffect, useRef, useState } from 'react';
import { buttonQuiet } from '@selarikru/ui';

const REPO = 'https://github.com/0xhaz/SelariKru';
/** The one command, as README.md and TESTING.md give it (infra/npx.mjs): clone, install, first-run setup, then `pnpm start`, which opens Chrome. */
export const RUN_LOCALLY_COMMAND = 'npx github:0xhaz/SelariKru';
/** The same by hand. */
export const RUN_LOCALLY_COMMANDS = ['git clone https://github.com/0xhaz/SelariKru.git', 'cd SelariKru', 'pnpm install', 'pnpm start'] as const;

/** Under the team header on wide screens: one line and the Run locally button. */
export function RunLocallyCard() {
  return (
    <div className="panel flex items-center justify-between gap-2 px-2.5 py-1.5" data-testid="run-locally-card">
      <p className="min-w-0 text-[13px] text-fg">Run it on your own computer</p>
      <RunLocallyButton />
    </div>
  );
}

/** The hosted demo's way to the full app: a top-bar button and a native modal dialog with the commands to run it on your own computer. */
export function RunLocallyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn text-[14px]" data-testid="run-locally" aria-haspopup="dialog" onClick={() => setOpen(true)}>Run locally</button>
      {open ? <RunLocallyDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RunLocallyDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      opener?.focus();
    };
  }, []);
  const copy = (): void => {
    // navigator.clipboard is absent outside a secure context; the commands stay selectable either way.
    if (!('clipboard' in navigator)) return setCopied('no');
    void navigator.clipboard.writeText(RUN_LOCALLY_COMMAND).then(() => setCopied('yes'), () => setCopied('no'));
  };
  return (
    <dialog ref={ref} aria-labelledby="run-locally-title" data-testid="run-locally-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }} className="motion-dialog m-auto w-[min(36rem,calc(100vw-2rem))] rounded-card border border-line-strong bg-panel p-5 text-fg backdrop:bg-backdrop">
      <h2 id="run-locally-title" className="text-lg font-semibold text-fg">Run SelariKru on your computer</h2>
      <p className="mt-2 text-fg">This demo runs on demo data. On your own machine, SelariKru works on your real projects. A local runner applies each change, builds it and tests it, and every verified change arrives as a draft pull request on GitHub.</p>
      <p className="mt-3 text-sm text-muted">You need Node 24, pnpm 9, Docker, the Firebase CLI and desktop Chrome.</p>
      <p className="mt-3 text-sm text-fg">In a terminal, run:</p>
      <pre className="mt-1 overflow-x-auto rounded-chip border border-line-strong bg-paper p-3 font-mono text-mono text-fg" data-testid="run-locally-command"><code>{RUN_LOCALLY_COMMAND}</code></pre>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" className={buttonQuiet} onClick={copy}>Copy command</button>
        <span role="status" className="text-sm text-muted">{copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Could not copy: select the command and copy it.' : ''}</span>
      </div>
      <p className="mt-3 text-sm text-fg">
        It clones SelariKru into a <code className="font-mono">SelariKru</code> folder and installs it. On the first run, it asks you to paste your Firebase web config and sets up a small Feedback Board project for the team to build. Then it starts everything and opens Chrome at 127.0.0.1:5173. Run it again to start SelariKru next time.
      </p>
      <p className="mt-3 text-sm text-muted">Prefer to do it by hand?</p>
      <pre className="mt-1 overflow-x-auto rounded-chip border border-line-strong bg-paper p-3 font-mono text-mono text-fg" data-testid="run-locally-commands"><code>{RUN_LOCALLY_COMMANDS.join('\n')}</code></pre>
      <p className="mt-2 text-sm"><a className="underline" href={`${REPO}/blob/main/TESTING.md`} target="_blank" rel="noreferrer">Full steps in TESTING.md</a></p>
      <div className="mt-5 flex justify-end">
        <button type="button" autoFocus className={buttonQuiet} onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
