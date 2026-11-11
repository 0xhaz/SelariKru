import { AGENT_CATALOG, type AssistantSdk, type ModelSpec } from '@selarikru/inference-firebase-web';

/**
 * The demo's stand-in for Firebase AI Logic: no model and no network. It answers each catalog agent with a fixed, schema-valid proposal built from what the prompt
 * names (criterion IDs, allowed paths, the diff's file), and reports the source the requested mode would use: a device-only model answers from this device, a
 * cloud-first or cloud-only one from the cloud. Everything it returns is demo data and never evidence; the real adapter still routes, checks and reports it.
 */

export interface DemoSdkOptions {
  /** Runs before each answer. Tests hold a call in flight with it. */
  readonly beforeGenerate?: () => Promise<void>;
}

const section = (prompt: string, heading: string): string[] => {
  const lines = prompt.split('\n');
  const start = lines.indexOf(`# ${heading}`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('# ') || l === '') break;
    out.push(l);
  }
  return out;
};

function criteriaOf(prompt: string): { id: string; text: string }[] {
  return section(prompt, 'Acceptance criteria').flatMap((l) => {
    const m = /^- ([^:]+): (.*)$/.exec(l);
    return m ? [{ id: m[1]!, text: m[2]! }] : [];
  });
}

const firstAllowedPath = (prompt: string): string => section(prompt, 'Allowed paths').map((l) => l.replace(/^- /, '')).find((p) => !p.startsWith('(')) ?? 'src';

function answer(kind: string, prompt: string): unknown {
  const criteria = criteriaOf(prompt);
  const ids = criteria.map((c) => c.id);
  const root = firstAllowedPath(prompt);
  switch (kind) {
    case 'criteria':
    case 'brief': {
      const acceptanceCriteria = criteria.map((c) => ({ requirementId: c.id, text: `${c.text.replace(/\.$/, '')}, checked by an automated test that a reviewer can run.`.slice(0, 400) }));
      return kind === 'brief' ? { summary: 'Demo brief: the task as written, with testable criteria.', acceptanceCriteria } : { acceptanceCriteria };
    }
    case 'breakdown':
      return { steps: [
        { title: 'Read the current code', detail: 'Find where this task\'s behaviour lives today and what calls it.', paths: [root], criteriaIds: ids.slice(0, 1) },
        { title: 'Make the change', detail: 'Change only what the criteria need, inside the allowed paths.', paths: [root], criteriaIds: ids },
        { title: 'Add the tests', detail: 'One test per criterion, so the verifier can judge each one.', paths: [root], criteriaIds: ids },
      ] };
    case 'patch': {
      const file = `${root}/demo-proposal.ts`;
      return { summary: 'Demo change: adds one constant the task needs.', diff: [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,2 @@', '+// Proposed by the demo agent.', '+export const DEMO_LIMIT = 50;', ''].join('\n') };
    }
    case 'review': {
      const file = /^diff --git a\/(\S+) b\//m.exec(prompt)?.[1] ?? `${root}/index.ts`;
      return { outcome: 'changes_suggested', summary: 'Demo review: the change is small and inside the allowed paths. One suggestion.', findings: [{ file, line: 1, severity: 'minor', ...(ids[0] ? { criterionId: ids[0] } : {}), message: 'Say in a comment why this value was chosen.' }] };
    }
    case 'triage':
      return { summary: 'Demo triage: a test expects the newest item first.', category: 'test_failure', likelyCause: 'The list is sorted oldest first, while the check expects newest first.', nextStep: 'Sort by the created time, newest first, and run the list tests again.' };
    case 'prDescription':
      return { title: 'Demo: the change for this task', body: 'Demo data. Summarises the change and the criteria it covers. Not evidence.', criteriaCovered: ids };
    // H11: the Project Manager. Built from what the prompt lists: the context keys it may cite, the accepted plan's tasks and the workers.
    case 'pmAnswer': {
      const keys = /Context keys you may cite: ([^.]+)\./.exec(prompt)?.[1]?.split(', ').filter(Boolean) ?? [];
      return { answer: 'Demo answer: the plan orders the API before the screens, so the list screen waits on it. Simulated, not evidence.', citations: keys.slice(0, 2).map((k) => ({ sourceId: k, note: 'From the project context.' })) };
    }
    case 'pmResearch':
      return { answer: 'Demo research: no web search ran in the demo. A real research call is cloud only and lists its web sources.', findings: [{ point: 'Simulated: shown so the panel can be seen. Not evidence.' }] };
    case 'pmPlan':
      return { tasks: [{ key: 'T1', title: 'Demo plan step', description: 'Demo data: the work as one task inside the allowed paths.', role: 'backend', requirementIds: ids.slice(0, 1), paths: [root], dependsOn: [] }] };
    case 'pmDelegate': {
      const tasks = section(prompt, `Accepted plan, revision ${/# Accepted plan, revision (\d+)/.exec(prompt)?.[1] ?? ''}`).flatMap((l) => { const m = /^- ([^\s:]+)(?::| ·) .* \(role ([a-z_]+), (\w+)\)$/.exec(l); return m ? [{ taskId: m[1]!, role: m[2]!, status: m[3]! }] : []; });
      const workers = section(prompt, 'Workers').flatMap((l) => { const m = /^- ([^:]+): .*, role (.+)$/.exec(l); return m ? [{ workerId: m[1]!, role: m[2]!.toLowerCase().replace(/ /g, '_') }] : []; });
      const open = tasks.filter((t) => ['planned', 'ready', 'blocked', 'failed'].includes(t.status));
      const assignments = open.flatMap((t) => { const w = workers.find((x) => x.role === t.role); return w ? [{ taskId: t.taskId, workerId: w.workerId, why: `Demo: ${t.role} work for a ${t.role} worker.` }] : []; });
      return { assignments: assignments.length > 0 ? assignments.slice(0, 12) : [{ taskId: tasks[0]?.taskId ?? 'none', workerId: workers[0]?.workerId ?? 'none', why: 'Demo: the only pairing listed.' }] };
    }
    default:
      return {};
  }
}

const KIND_BY_PROMPT = new Map(Object.values(AGENT_CATALOG).map((d) => [d.rolePrompt, d.kind]));

export function createDemoSdk(opts: DemoSdkOptions = {}): AssistantSdk {
  return {
    async availability() { return 'available'; },
    async initializeDeviceModel(onProgress) { onProgress(1); },
    createModel(spec: ModelSpec) {
      const kind = KIND_BY_PROMPT.get(spec.systemInstruction) ?? 'unknown';
      // A device-only model has no cloud params, so it can only answer here. Otherwise the mode's first choice answers.
      const source = !spec.allowCloud || spec.mode === 'ONLY_ON_DEVICE' || spec.mode === 'PREFER_ON_DEVICE' ? 'on_device' : 'in_cloud';
      return {
        async generate(prompt: string) {
          await opts.beforeGenerate?.();
          return { text: JSON.stringify(answer(kind, prompt)), inferenceSource: source };
        },
      };
    },
  };
}
