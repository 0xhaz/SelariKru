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
    case 'pmPlan': {
      // Fix round 2 (I4): revise the first task the prompt lists (by id, keeping its role), and add one that follows it.
      const listed = section(prompt, `Current plan, revision ${/# Current plan, revision (\d+)/.exec(prompt)?.[1] ?? ''}`).flatMap((l) => { const m = /^- ([^\s:]+): .* \(role ([a-z_]+), (\w+)\)$/.exec(l); return m ? [{ taskId: m[1]!, role: m[2]! }] : []; });
      const first = listed[0];
      const req = ids.slice(0, 1);
      // H13: made from an approved plan brief, the plan carries an architecture section naming the brief's item ids.
      const briefIds = /# Approved plan brief/.test(prompt) ? [...prompt.matchAll(/^- (P\d{1,2}) \(/gm)].map((m) => m[1]!) : [];
      const contradicted = [...prompt.matchAll(/^- (P\d{1,2}) .*\[CONTRADICTED/gm)].map((m) => m[1]!);
      const architecture = briefIds.length > 0 ? { architecture: `Demo architecture (demo data, not evidence): an API for posts and votes and a list screen, resting on ${briefIds.filter((x) => !contradicted.includes(x)).join(', ') || 'the brief'}.${contradicted.length > 0 ? ` Not built on ${contradicted.join(', ')}: the check contradicted ${contradicted.length === 1 ? 'it' : 'them'}.` : ''}` } : {};
      if (!first) return { tasks: [{ key: 'T1', title: 'Demo plan step', description: 'Demo data: the work as one task inside the allowed paths.', role: 'backend', requirementIds: req, paths: [root], dependsOn: [] }], ...architecture };
      return { ...architecture, tasks: [
        { key: 'T1', title: 'Demo plan step (revised)', description: 'Demo data: this task again, narrowed.', role: first.role, requirementIds: req, paths: [root], dependsOn: [], revises: first.taskId },
        { key: 'T2', title: 'Demo follow-up', description: 'Demo data: a new task after it.', role: first.role, requirementIds: req, paths: [root], dependsOn: ['T1'] },
      ] };
    }
    case 'pmDelegate': {
      const tasks = section(prompt, `Accepted plan, revision ${/# Accepted plan, revision (\d+)/.exec(prompt)?.[1] ?? ''}`).flatMap((l) => { const m = /^- ([^\s:]+): .* \(role ([a-z_]+), (\w+)\)$/.exec(l); return m ? [{ taskId: m[1]!, role: m[2]!, status: m[3]! }] : []; });
      const workers = section(prompt, 'Workers').flatMap((l) => { const m = /^- ([^:]+): .*, role (.+)$/.exec(l); return m ? [{ workerId: m[1]!, role: m[2]!.toLowerCase().replace(/ /g, '_') }] : []; });
      const open = tasks.filter((t) => ['planned', 'ready', 'blocked', 'failed'].includes(t.status));
      const assignments = open.flatMap((t) => { const w = workers.find((x) => x.role === t.role); return w ? [{ taskId: t.taskId, workerId: w.workerId, why: `Demo: ${t.role} work for a ${t.role} worker.` }] : []; });
      return { assignments: assignments.length > 0 ? assignments.slice(0, 12) : [{ taskId: tasks[0]?.taskId ?? 'none', workerId: workers[0]?.workerId ?? 'none', why: 'Demo: the only pairing listed.' }] };
    }
    // H13: the plan brief. Formatting keeps every point and question it is given, as the completeness rule says, built from the numbered lines of the prompt.
    case 'pmBrief': {
      // Fix round 1 (I1): each entry names the line it comes from.
      const numbered = (name: string) => fenced(prompt, name).flatMap((l) => { const m = /^(\d+)\. (.*)$/.exec(l); return m ? [{ n: Number(m[1]), text: m[2]! }] : []; });
      const pointLines = numbered('POINTS');
      const questionLines = numbered('QUESTIONS');
      const points = pointLines.map((x) => x.text);
      const questions = questionLines.map((x) => x.text);
      const items = points.slice(0, 20).map((raw, i) => {
        const conversation = raw.startsWith('(from the conversation) ');
        const text = raw.replace(/^\(from the conversation\) /, '').slice(0, 280);
        const kind = /\b(most|usually|typically|many|all)\b/i.test(text) ? 'fact' : /^we (store|use)\b/i.test(text) ? 'decision' : 'requirement';
        return { id: `P${i + 1}`, text, kind, checkable: kind === 'fact', source: conversation ? 'conversation' : 'points', from: [pointLines[i]!.n] };
      });
      return {
        goal: `Demo brief: ${(points[0] ?? questions[0] ?? 'the work').replace(/\.$/, '')}.`.slice(0, 280), items,
        uncertainties: questionLines.slice(0, 10).map((q, i) => ({ id: `U${i + 1}`, question: q.text.slice(0, 280), from: [q.n] })),
        omitted: [...pointLines.slice(20), ...questionLines.slice(10)].map((x) => ({ reason: 'duplicate', from: [x.n] })),
      };
    }
    case 'pmVerify':
    case 'pmVerifyNoWeb': {
      const lines = fenced(prompt, 'BRIEF');
      const items = lines.flatMap((l) => { const m = /^(P\d{1,2}) \((\w+)\): (.*)$/.exec(l); return m ? [{ id: m[1]!, kind: m[2]! }] : []; });
      const questions = lines.flatMap((l) => { const m = /^(U\d{1,2}): /.exec(l); return m ? [m[1]!] : []; });
      const web = kind === 'pmVerify';
      const sources = web ? { sources: [{ title: 'Demo source (no web search ran)', url: 'https://example.com/selarikru-demo-source' }] } : {};
      // Facts take turns: supported, contradicted, unclear (consistent, inconsistent, unclear without the web), so every verdict can be seen. A requirement or
      // decision is not a fact to check.
      let fact = 0;
      return {
        items: items.map((x) => {
          if (x.kind !== 'fact' && x.kind !== 'assumption') return { id: x.id, verdict: web ? 'not_checkable' : 'unclear', explanation: 'Demo: a requirement or decision, not a fact to check.', ...(web ? { sources: [] } : {}) };
          const v = (web ? ['supported', 'contradicted', 'unclear'] : ['consistent', 'inconsistent', 'unclear'])[fact++ % 3]!;
          return { id: x.id, verdict: v, explanation: `Demo: ${web ? 'no web search ran in the demo' : 'not checked against the web'}; the verdict is simulated.`, ...sources };
        }),
        uncertainties: questions.map((q) => ({ id: q, answer: `Demo answer: simulated, ${web ? 'no web search ran' : 'not checked against the web'}. A real check answers from ${web ? 'Google Search results' : 'what the model knows'}.`, confidence: 'low', ...sources })),
      };
    }
    default:
      return {};
  }
}

/** The lines inside a fenced block (`----- BEGIN <name> <nonce> -----`). */
function fenced(prompt: string, name: string): string[] {
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`----- BEGIN ${name} `));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith(`----- END ${name} `));
  return lines.slice(start + 1, end < 0 ? undefined : end);
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
          // H13 fix round 1 (I2): a demo brief check with Google Search returns the demo source as its search result too, labelled; nothing was searched.
          const grounding = kind === 'pmVerify' ? { grounding: { sources: [{ uri: 'https://example.com/selarikru-demo-source', title: 'example.com' }], entryPointHtml: null } } : {};
          return { text: JSON.stringify(answer(kind, prompt)), inferenceSource: source, ...grounding };
        },
      };
    },
  };
}
