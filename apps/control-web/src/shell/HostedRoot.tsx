import { lazy, useMemo } from 'react';
import { FirebaseHybridAssistantAdapter, RestrictedDraftHold, createFirebaseSdk } from '@selarikru/inference-firebase-web';
import { app } from '../firebase-app.ts';
import { AppShell } from './AppShell.tsx';
import { OnboardingView } from '../features/onboarding/OnboardingView.tsx';
import { createDemoOnboardingApi } from '../features/onboarding/demo-api.ts';
import { fetchRouteFrom } from '../features/hybrid/agents.ts';
import { connectivity, isOnline } from '../features/checkpoints/connectivity.ts';
import { createCloudQuota } from '../features/hosted/cloud-quota.ts';
import { useDemoSession } from './demo-session.ts';

const AssistantPanel = lazy(() => import('../features/assistant/AssistantPanel.tsx').then((m) => ({ default: m.AssistantPanel })));

/**
 * H9: the hosted demo (pnpm build:hosted). Demo data (the mock data source, labelled Demo data everywhere, with no control API and no Auth Emulator), and every AI
 * call (the Assistant, the Project Manager, the catalog agents, the onboarding guide) through the real Firebase AI Logic SDK: Gemini Nano in Chrome on this device,
 * Gemini through Firebase in the cloud. Routes, locks, fallback and the record of where each call ran work as they do live. App Check (reCAPTCHA Enterprise) guards
 * the project; the build fails without its site key, and no debug token is ever in it. A per-tab cap on cloud calls protects the free-tier quota.
 */
export default function HostedRoot() {
  const fixtureId = new URLSearchParams(window.location.search).get('fixture') ?? 'feature-delivery';
  // The hosted demo opens on the project that uses every route (Local only, Local first, Cloud first, Cloud only, a restricted lock), as the tour does.
  const { session, project, store, playback } = useDemoSession(fixtureId);
  const quota = useMemo(() => createCloudQuota(), []);
  const sdk = useMemo(() => createFirebaseSdk({ app, recaptchaSiteKey: (import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined) || undefined }), []);
  const source = session?.source ?? null;
  // One adapter for every call in this tab, so the cap counts them all. Each call that names a task reads its route fresh from the demo source first.
  const adapter = useMemo(() => (source ? new FirebaseHybridAssistantAdapter({
    sdk, fetchRoute: fetchRouteFrom(source), isOnline, cloudCalls: quota,
    onNetworkFailure: () => connectivity.getState().reportNetworkFailure(), onNetworkSuccess: () => connectivity.getState().reportNetworkSuccess(),
  }) : null), [sdk, source, quota]);
  // Demo data: results are labelled so and never evidence, though a real model wrote them.
  const agentRuntime = useMemo(() => (adapter ? { adapter, simulated: true, liveModel: true } : null), [adapter]);
  const hold = useMemo(() => new RestrictedDraftHold(), []);
  const onboardingApi = useMemo(() => createDemoOnboardingApi({ reviewLocally: true }), []);
  if (!session || !store || !project || !adapter) return <p role="status" className="p-6 text-muted">Loading demo data</p>;
  return (
    <AppShell
      store={store} mode="mock" agentRuntime={agentRuntime} projectLabel={project.name} playback={playback}
      hosted={{ quota }} deviceAvailability={() => sdk.availability()}
      assistant={<AssistantPanel adapter={adapter} api={null} hold={hold} defaults={{ projectId: project.projectId, runId: '' }} />}
      onboarding={<OnboardingView api={onboardingApi} adapter={adapter} hold={hold} mode="mock" />}
    />
  );
}
