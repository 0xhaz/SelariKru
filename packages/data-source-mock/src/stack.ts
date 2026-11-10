import { applyStackAction, detectStack, emptyStack, NO_NATIVE, STACK_CATALOG_VERSION, withholdRestrictedDetection, type StackDocument } from '@selarikru/domain';
import { DataSourceException, type StackActionRequestView, type StackView } from '@selarikru/view-protocol';
import { FIXTURE_T0_MS } from './builder.ts';

/**
 * Stack settings on demo data. The detection is the domain detector run over a copy of the Feedback Board starter's manifest and the names of its config files, so the
 * screen shows what the runner would propose; actions go through the same `applyStackAction` the server runs. Nothing here touches a network or a repository.
 */
const STARTER_PACKAGE = JSON.stringify({
  name: 'feedback-board-starter', packageManager: 'pnpm@9.12.2', engines: { node: '>=24 <25', pnpm: '>=9.12.2 <10' },
  scripts: { 'dev:api': 'tsx server/index.ts', 'dev:web': 'vite', build: 'tsc --noEmit && vite build', typecheck: 'tsc --noEmit', start: 'tsx server/index.ts', test: 'vitest run --passWithNoTests' },
  dependencies: { 'better-sqlite3': '13.0.3', express: '5.3.0', react: '19.3.1', 'react-dom': '19.3.1' },
  devDependencies: { '@vitejs/plugin-react': '6.2.1', tsx: '4.23.15', typescript: '5.9.3', vite: '8.3.6', vitest: '5.1.0' },
});
const DEMO_COMMIT = 'c'.repeat(40);

function demoStack(): StackDocument {
  const detected = detectStack([
    { path: 'package.json', content: STARTER_PACKAGE }, { path: 'pnpm-lock.yaml' }, { path: 'vite.config.ts' }, { path: 'tsconfig.json' }, { path: '.nvmrc' },
  ]);
  const base = applyStackAction(emptyStack(), { kind: 'component.upsert', path: '.', name: 'Feedback Board', targets: ['web', 'server'] });
  if (!base.ok) throw new Error(base.code);
  return {
    components: base.doc.components,
    detection: {
      commit: DEMO_COMMIT, detectedAt: new Date(FIXTURE_T0_MS - 600_000).toISOString(), runnerId: 'runner_local_1 (simulated)',
      items: detected.items.map((i) => ({ ...i, state: 'proposed' as const })), commands: detected.commands, skipped: detected.skipped,
    },
  };
}

const refuse = (message: string): DataSourceException => new DataSourceException({ code: 'unavailable', message, retryable: false });

export interface DemoStack {
  get(projectId: string): Promise<StackView>;
  act(projectId: string, request: StackActionRequestView): Promise<StackView>;
}

export function createDemoStack(nowIso: (projectId: string) => string): DemoStack {
  const states = new Map<string, { revision: number; document: StackDocument; updatedAt: string | null }>();
  const stateOf = (projectId: string) => {
    let s = states.get(projectId);
    if (!s) { s = { revision: 0, document: demoStack(), updatedAt: null }; states.set(projectId, s); }
    return s;
  };
  const view = (projectId: string): StackView => {
    const s = stateOf(projectId);
    return { projectId, revision: s.revision, detectionRevision: 1, unreadable: false, catalogVersion: STACK_CATALOG_VERSION, document: structuredClone(s.document), updatedBy: s.updatedAt ? 'demo owner' : null, updatedAt: s.updatedAt, native: NO_NATIVE };
  };
  return {
    async get(projectId) { return view(projectId); },
    async act(projectId, request) {
      const s = stateOf(projectId);
      if (request.expectedRevision !== s.revision) throw refuse('The stack changed since it was read. Reload and try again.');
      const r = applyStackAction(s.document, request.action);
      if (!r.ok) throw refuse(r.message);
      s.document = withholdRestrictedDetection(r.doc); // the same filter the server applies when it stores the stack
      s.revision += 1;
      s.updatedAt = nowIso(projectId);
      return view(projectId);
    },
  };
}
