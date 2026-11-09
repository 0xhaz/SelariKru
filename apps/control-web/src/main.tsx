import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteBoundary } from './shell/ErrorBoundary.tsx';
import './index.css';

// Demo data is opt-in (`?demo`) and exists only in dev builds: in a production build the flag is false and this import is never emitted.
const DemoRoot = import.meta.env.DEV ? lazy(() => import('./shell/DemoRoot.tsx')) : null;
// Loaded separately so the demo path never initializes Firebase.
const LiveRoot = lazy(() => import('./shell/LiveRoot.tsx'));

const wantsDemo = new URLSearchParams(window.location.search).has('demo');
const Root = DemoRoot && wantsDemo ? DemoRoot : LiveRoot;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouteBoundary resetKey="root">
      <Suspense fallback={<p role="status" className="p-6 text-muted">Loading</p>}>
        <Root />
      </Suspense>
    </RouteBoundary>
  </StrictMode>,
);
