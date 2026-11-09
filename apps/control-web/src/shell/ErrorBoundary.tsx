import { Component, type ReactNode } from 'react';
import { buttonQuiet } from '@selarikru/ui';

/** Contains a render failure or a failed lazy chunk to one route, so the frame around it and the Demo data badge survive. */
export class RouteBoundary extends Component<{ resetKey: string; root?: boolean; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidUpdate(previous: { resetKey: string }, previousState: { failed: boolean }): void {
    // Only a boundary that had already failed resets: the update that first catches an error must not retry it.
    if (previous.resetKey !== this.props.resetKey && previousState.failed && this.state.failed) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="mx-auto mt-10 max-w-xl rounded-card border border-danger bg-danger-tint p-6">
        <h1 className="text-xl font-semibold text-fg">{this.props.root ? 'SelariKru could not load' : 'This view could not load'}</h1>
        <p className="mt-2 text-muted">{this.props.root ? 'Part of the app did not arrive. Reloading the page fetches it again.' : 'Other views still work. Reloading the page fetches this one again.'}</p>
        <button type="button" className={`${buttonQuiet} mt-4`} onClick={() => window.location.reload()}>Reload the page</button>
      </section>
    );
  }
}
