import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteBoundary } from './shell/ErrorBoundary.tsx';
import './index.css';

// H9: the hosted demo (pnpm build:hosted) is its own root: demo data, with every AI call through the real Firebase AI Logic SDK. A build-time constant, so the real
// build has no hosted root and the hosted build has no live root.
const HostedRoot = import.meta.env.VITE_HOSTED_DEMO === '1' ? lazy(() => import('./shell/HostedRoot.tsx')) : null;
// Demo data is opt-in (`?demo`) and exists only in dev builds: in a production build the flag is false and this import is never emitted.
const DemoRoot = import.meta.env.DEV && import.meta.env.VITE_HOSTED_DEMO !== '1' ? lazy(() => import('./shell/DemoRoot.tsx')) : null;
// Loaded separately so the demo path never initializes Firebase.
const LiveRoot = import.meta.env.VITE_HOSTED_DEMO === '1' ? null : lazy(() => import('./shell/LiveRoot.tsx'));

const wantsDemo = new URLSearchParams(window.location.search).has('demo');
const Root = HostedRoot ?? (DemoRoot && wantsDemo ? DemoRoot : LiveRoot!);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouteBoundary resetKey="root" root>
      <Suspense fallback={<p role="status" className="p-6 text-muted">Loading</p>}>
        <Root />
      </Suspense>
    </RouteBoundary>
  </StrictMode>,
);
