import {
  canonicalJson, PLAN_BRIEF_KIND, PLAN_BRIEF_LIMITS, RESEARCH_NOTES_KIND, redactSecrets, sha256Hex, strongerLabel,
  type AiCheckpoint, type AiCheckpointText, type PLAN_BRIEF_CONFIDENCE, type PLAN_BRIEF_ITEM_KINDS, type PLAN_BRIEF_NO_WEB_VERDICTS, type PLAN_BRIEF_OMIT_REASONS, type PLAN_BRIEF_VERDICTS,
} from '@selarikru/domain';
import { CONVERSATION_MARKER, planBriefLines, type PlanBriefForPlan, type PlanBriefPayload, type SdkGrounding } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import { questionLabelFor } from './runner.ts';

/**
 * H13: the plan brief. The owner gives their points and what they are unsure about; Gemini Nano formats them on this device into a brief that keeps every point
 * (`pmBrief`); the owner checks and corrects it, ticks what may leave the device, and approves it, which freezes it by hash; the cloud checks each approved point
 * and answers each question (`pmVerify`, or `pmVerifyNoWeb` without web search); the PM then makes the plan from it. Pure functions: the panel and the engine
 * call them, so the same rules hold for the button, a resume and a test.
 */
export type BriefLabel = 'internal' | 'restricted';
export type ItemKind = (typeof PLAN_BRIEF_ITEM_KINDS)[number];
export interface BriefItem {
  readonly id: string;
  readonly text: string;
  readonly kind: ItemKind;
  readonly checkable: boolean;
  readonly source: 'points' | 'conversation' | 'manual';
  /** Fix round 1 (I1): the input lines (points first, then questions, from 1) it covers. Empty from the model: invented. */
  readonly from: readonly number[];
  readonly ticked: boolean;
  /** From restricted input: it can never be ticked, so it never leaves this device. */
  readonly restricted: boolean;
}
export interface BriefQuestion { readonly id: string; readonly question: string; readonly source: 'unsure' | 'manual'; readonly from: readonly number[]; readonly ticked: boolean; readonly restricted: boolean }
/** One line the owner gave, numbered as the prompt numbers it. */
export interface BriefLine { readonly n: number; readonly text: string; readonly list: 'points' | 'questions' }
export interface BriefDraft {
  readonly goal: string;
  /** Whether the goal is sent with the check. Never for restricted notes. */
  readonly goalTicked: boolean;
  readonly items: readonly BriefItem[];
  readonly uncertainties: readonly BriefQuestion[];
  readonly omitted: readonly { readonly reason: (typeof PLAN_BRIEF_OMIT_REASONS)[number]; readonly from: readonly number[] }[];
  /** The notes' label when the brief was made. Restricted: nothing in it may be ticked, and the cloud check is unavailable. */
  readonly label: BriefLabel;
  /** The lines the owner gave, for the completeness check (fix round 1, I1). */
  readonly inLines: readonly BriefLine[];
  /** sha256 of the payload the owner approved. Null: not approved (or edited since). */
  readonly approvedSha256: string | null;
}

const L = PLAN_BRIEF_LIMITS;
const one = (t: string): string => t.replace(/\s+/g, ' ').trim();
const secret = (t: string): boolean => redactSecrets(t) !== t;

export const briefInCount = (points: string, unsure: string): { readonly points: number; readonly unsure: number } => { const l = planBriefLines(points, unsure); return { points: l.points.length, unsure: l.unsure.length }; };
/** The owner's lines as the prompt numbers them: points from 1, then the questions after them. */
export function briefInLines(points: string, unsure: string): BriefLine[] {
  const l = planBriefLines(points, unsure);
  return [...l.points.map((p, i): BriefLine => ({ n: i + 1, text: p.text, list: 'points' })), ...l.unsure.map((q, i): BriefLine => ({ n: l.points.length + i + 1, text: q, list: 'questions' }))];
}

export function emptyBrief(label: BriefLabel, inLines: readonly BriefLine[]): BriefDraft {
  return { goal: '', goalTicked: label !== 'restricted', items: [], uncertainties: [], omitted: [], label, inLines, approvedSha256: null };
}

/**
 * The brief from a schema-valid pmBrief output. Every item and question goes through the secret detector: one with a secret-shaped string is dropped and counted
 * as omitted (private), so the count still adds up and the string never reaches the screen or storage. A secret-shaped goal is cleared.
 */
export function briefFromOutput(data: unknown, label: BriefLabel, inLines: readonly BriefLine[]): BriefDraft {
  const d = data as { goal: string; items: { id: string; text: string; kind: ItemKind; checkable: boolean; source: 'points' | 'conversation'; from: number[] }[]; uncertainties: { id: string; question: string; from: number[] }[]; omitted: { reason: BriefDraft['omitted'][number]['reason']; from: number[] }[] };
  const omitted = d.omitted.map((o) => ({ reason: o.reason, from: [...o.from] }));
  const restricted = label === 'restricted';
  const items = d.items.flatMap((x): BriefItem[] => { if (secret(x.text)) { omitted.push({ reason: 'private', from: [...x.from] }); return []; } return [{ id: x.id, text: one(x.text), kind: x.kind, checkable: x.checkable, source: x.source, from: [...x.from], ticked: !restricted, restricted }]; });
  const uncertainties = d.uncertainties.flatMap((x): BriefQuestion[] => { if (secret(x.question)) { omitted.push({ reason: 'private', from: [...x.from] }); return []; } return [{ id: x.id, question: one(x.question), source: 'unsure', from: [...x.from], ticked: !restricted, restricted }]; });
  return { goal: secret(d.goal) ? '' : one(d.goal), goalTicked: !restricted, items, uncertainties, omitted, label, inLines, approvedSha256: null };
}

/**
 * "N points in, N items + N omitted out", checked per line (fix round 1, I1): every line the owner gave must be covered by some item, question or omitted entry
 * (grouping is allowed); an item or question from the model that names no line it came from is invented. The missing lines are offered for adding by hand.
 */
export function completeness(d: BriefDraft): { readonly ok: boolean; readonly missing: number; readonly missingLines: readonly BriefLine[]; readonly invented: readonly string[]; readonly line: string; readonly warning: string | null } {
  const known = new Set(d.inLines.map((l) => l.n));
  const covered = new Set([...d.items, ...d.uncertainties, ...d.omitted].flatMap((x) => x.from));
  const missingLines = d.inLines.filter((l) => !covered.has(l.n));
  const invented = [...d.items, ...d.uncertainties].filter((x) => x.source !== 'manual' && !x.from.some((n) => known.has(n))).map((x) => x.id);
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const points = d.inLines.filter((l) => l.list === 'points').length;
  const line = `${n(points, 'point')} and ${n(d.inLines.length - points, 'question')} in, ${n(d.items.length, 'item')} + ${n(d.uncertainties.length, 'question')} + ${d.omitted.length} omitted out`;
  const parts = [
    ...missingLines.map((l) => `Line ${l.n} is not in this brief: "${l.text}".`),
    ...(invented.length > 0 ? [`${invented.join(', ')} ${invented.length === 1 ? 'does' : 'do'} not come from anything you gave: check ${invented.length === 1 ? 'it was' : 'they were'} not invented, and delete what you did not say.`] : []),
  ];
  return { ok: missingLines.length === 0 && invented.length === 0, missing: missingLines.length, missingLines, invented, line, warning: parts.length > 0 ? parts.join(' ') : null };
}

type Edit = { readonly draft: BriefDraft } | { readonly error: 'too_long' | 'secret' | 'empty' | 'full' };
const unapproved = (d: BriefDraft): BriefDraft => ({ ...d, approvedSha256: null });
const checkText = (t: string, max: number): 'too_long' | 'secret' | 'empty' | null => { const v = one(t); return !v ? 'empty' : v.length > max ? 'too_long' : secret(v) ? 'secret' : null; };

export function setGoal(d: BriefDraft, goal: string): Edit {
  const v = one(goal);
  if (v.length > L.goalChars) return { error: 'too_long' };
  if (secret(v)) return { error: 'secret' };
  return { draft: unapproved({ ...d, goal: v }) };
}
export function editItem(d: BriefDraft, id: string, text: string): Edit {
  const bad = checkText(text, L.itemChars);
  return bad ? { error: bad } : { draft: unapproved({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, text: one(text) } : x)) }) };
}
export const setItemKind = (d: BriefDraft, id: string, kind: ItemKind): BriefDraft => unapproved({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, kind } : x)) });
export function editQuestion(d: BriefDraft, id: string, question: string): Edit {
  const bad = checkText(question, L.itemChars);
  return bad ? { error: bad } : { draft: unapproved({ ...d, uncertainties: d.uncertainties.map((x) => (x.id === id ? { ...x, question: one(question) } : x)) }) };
}
/** A restricted entry stays unticked whatever is asked. */
export const toggleGoal = (d: BriefDraft): BriefDraft => unapproved({ ...d, goalTicked: d.label !== 'restricted' && !d.goalTicked });
export const toggleItem = (d: BriefDraft, id: string): BriefDraft => unapproved({ ...d, items: d.items.map((x) => (x.id === id && !x.restricted ? { ...x, ticked: !x.ticked } : x)) });
export const toggleQuestion = (d: BriefDraft, id: string): BriefDraft => unapproved({ ...d, uncertainties: d.uncertainties.map((x) => (x.id === id && !x.restricted ? { ...x, ticked: !x.ticked } : x)) });
export const removeItem = (d: BriefDraft, id: string): BriefDraft => unapproved({ ...d, items: d.items.filter((x) => x.id !== id) });
export const removeQuestion = (d: BriefDraft, id: string): BriefDraft => unapproved({ ...d, uncertainties: d.uncertainties.filter((x) => x.id !== id) });

const nextId = (prefix: 'P' | 'U', ids: readonly string[], max: number): string | null => {
  for (let i = 1; i <= max; i++) if (!ids.includes(`${prefix}${i}`)) return `${prefix}${i}`;
  return null;
};
export function addItem(d: BriefDraft, text: string, kind: ItemKind, from: readonly number[] = []): Edit {
  const bad = checkText(text, L.itemChars);
  if (bad) return { error: bad };
  const id = nextId('P', d.items.map((x) => x.id), L.items);
  if (!id) return { error: 'full' };
  const restricted = d.label === 'restricted';
  return { draft: unapproved({ ...d, items: [...d.items, { id, text: one(text), kind, checkable: kind === 'fact' || kind === 'assumption', source: 'manual', from: [...from], ticked: !restricted, restricted }] }) };
}
export function addQuestion(d: BriefDraft, question: string, from: readonly number[] = []): Edit {
  const bad = checkText(question, L.itemChars);
  if (bad) return { error: bad };
  const id = nextId('U', d.uncertainties.map((x) => x.id), L.uncertainties);
  if (!id) return { error: 'full' };
  const restricted = d.label === 'restricted';
  return { draft: unapproved({ ...d, uncertainties: [...d.uncertainties, { id, question: one(question), source: 'manual', from: [...from], ticked: !restricted, restricted }] }) };
}

/** A draft whose notes became restricted (fix round 1): restricted throughout, nothing ticked, not approved. */
export function restrictBrief(d: BriefDraft): BriefDraft {
  return { ...d, label: 'restricted', goalTicked: false, approvedSha256: null, items: d.items.map((x) => ({ ...x, ticked: false, restricted: true })), uncertainties: d.uncertainties.map((x) => ({ ...x, ticked: false, restricted: true })) };
}

/** What the cloud check sends: the ticked goal, items (with kind) and questions. Nothing else. A restricted brief has no payload at all. */
export function briefPayload(d: BriefDraft): PlanBriefPayload {
  if (d.label === 'restricted') return { goal: '', items: [], uncertainties: [] };
  return {
    goal: d.goalTicked ? d.goal : '',
    items: d.items.filter((x) => x.ticked && !x.restricted).map((x) => ({ id: x.id, kind: x.kind, text: x.text })),
    uncertainties: d.uncertainties.filter((x) => x.ticked && !x.restricted).map((x) => ({ id: x.id, question: x.question })),
  };
}
export const briefSha256 = (p: PlanBriefPayload): string => sha256Hex(canonicalJson(p));
export const approveBrief = (d: BriefDraft): BriefDraft => ({ ...d, approvedSha256: briefSha256(briefPayload(d)) });

/** Why the cloud check cannot run on this brief now, or null. The panel and the runner use the same rule. */
export function cloudRefusal(d: BriefDraft | null): 'brief_restricted' | 'brief_not_approved' | 'brief_empty' | null {
  if (!d) return 'brief_not_approved';
  if (d.label === 'restricted') return 'brief_restricted';
  const p = briefPayload(d);
  if (d.approvedSha256 === null || d.approvedSha256 !== briefSha256(p)) return 'brief_not_approved';
  if (p.items.length === 0 && p.uncertainties.length === 0) return 'brief_empty';
  return null;
}

// ---- the cloud check's results ------------------------------------------------------------------------------------------------

type Verdict = (typeof PLAN_BRIEF_VERDICTS)[number] | (typeof PLAN_BRIEF_NO_WEB_VERDICTS)[number];
export interface BriefCheck {
  readonly checked: 'web' | 'no_web';
  readonly items: readonly { readonly id: string; readonly verdict: Verdict; readonly explanation: string; readonly sources: readonly CitedSource[] }[];
  readonly uncertainties: readonly { readonly id: string; readonly answer: string; readonly confidence: (typeof PLAN_BRIEF_CONFIDENCE)[number]; readonly sources: readonly CitedSource[] }[];
}
/** A source the model cited. `matched`: its host is one of the search's own results (fix round 1, I2); otherwise it is shown as text, never as a live link. */
export interface CitedSource { readonly title: string; readonly url: string; readonly matched: boolean }
/** A link the screen may show: https only. Anything else (http, javascript:, data:) is dropped. */
export function httpsOnly(url: string): boolean {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}
const hostOf = (s: string): string | null => {
  const bare = s.trim().toLowerCase();
  try { return new URL(bare.includes('://') ? bare : `https://${bare}`).hostname.replace(/^www\./, ''); } catch { return null; }
};
/**
 * The hosts the search itself returned: each grounding chunk's title (the search gives the site's domain there; its URI is a redirect) and its URI's host.
 * Only these back a model-cited source.
 */
function searchHosts(grounding: SdkGrounding | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of grounding?.sources ?? []) for (const h of [s.title ? hostOf(s.title) : null, hostOf(s.uri)]) if (h) out.add(h);
  return out;
}

export function screenCheck(kind: 'pmVerify' | 'pmVerifyNoWeb', data: unknown, grounding?: SdkGrounding | null): BriefCheck {
  const hosts = searchHosts(grounding);
  const d = data as { items: { id: string; verdict: Verdict; explanation: string; sources?: { title: string; url: string }[] }[]; uncertainties: { id: string; answer: string; confidence: BriefCheck['uncertainties'][number]['confidence']; sources?: { title: string; url: string }[] }[] };
  const src = (s: { title: string; url: string }[] | undefined): CitedSource[] => (s ?? []).filter((x) => httpsOnly(x.url)).map((x) => { const h = hostOf(x.url); return { title: x.title, url: x.url, matched: h !== null && hosts.has(h) }; });
  return {
    checked: kind === 'pmVerify' ? 'web' : 'no_web',
    items: d.items.map((x) => ({ id: x.id, verdict: x.verdict, explanation: x.explanation, sources: src(x.sources) })),
    uncertainties: d.uncertainties.map((x) => ({ id: x.id, answer: x.answer, confidence: x.confidence, sources: src(x.sources) })),
  };
}

/** The approved brief as the plan reads it: the ticked items with their verdicts, the ticked questions with their answers. */
export function planBriefFor(d: BriefDraft, check: BriefCheck): PlanBriefForPlan {
  const p = briefPayload(d);
  return {
    goal: p.goal, checked: check.checked,
    items: p.items.map((x) => { const v = check.items.find((r) => r.id === x.id); return { ...x, ...(v ? { verdict: v.verdict, explanation: v.explanation } : {}) }; }),
    uncertainties: p.uncertainties.map((x) => { const v = check.uncertainties.find((r) => r.id === x.id); return { ...x, ...(v ? { answer: v.answer, confidence: v.confidence } : {}) }; }),
  };
}

// ---- checkpoint texts ---------------------------------------------------------------------------------------------------------

/** Lines packed into labelled texts of at most 2,000 characters each, so the H12 storage split, its server refusal and its table checks apply unchanged. */
function pack(lines: readonly string[], label: BriefLabel): AiCheckpointText[] {
  const out: AiCheckpointText[] = [];
  let cur = '';
  for (const l of lines) {
    const add = cur === '' ? l : `${cur}\n${l}`;
    if (add.length > 2000 && cur !== '') { out.push({ who: 'owner', text: cur, classification: label }); cur = l; } else cur = add;
  }
  if (cur !== '') out.push({ who: 'owner', text: cur, classification: label });
  return out;
}
const unpack = (texts: readonly AiCheckpointText[]): string[] => texts.filter((t) => t.who === 'owner').flatMap((t) => t.text.split('\n'));

/** A paused check's brief: `G<TAB>goal`, `P1<TAB>kind<TAB>text`, `U1<TAB>question`. Whitespace in the text is already one space, so a line never breaks. */
export function encodeBriefTexts(p: PlanBriefPayload, label: BriefLabel): AiCheckpointText[] {
  return pack([`G\t${one(p.goal)}`, ...p.items.map((x) => `${x.id}\t${x.kind}\t${one(x.text)}`), ...p.uncertainties.map((x) => `${x.id}\t${one(x.question)}`)], label);
}
export function decodeBriefTexts(texts: readonly AiCheckpointText[]): PlanBriefPayload | null {
  let goal: string | null = null;
  const items: { id: string; kind: ItemKind; text: string }[] = [];
  const uncertainties: { id: string; question: string }[] = [];
  for (const l of unpack(texts)) {
    const [head, a, b] = l.split('\t');
    if (head === 'G') goal = a ?? '';
    else if (/^P\d{1,2}$/.test(head ?? '') && a && b !== undefined) items.push({ id: head!, kind: a as ItemKind, text: b });
    else if (/^U\d{1,2}$/.test(head ?? '') && a !== undefined) uncertainties.push({ id: head!, question: a });
    else return null;
  }
  return goal === null ? null : { goal, items, uncertainties };
}

// ---- the notes ----------------------------------------------------------------------------------------------------------------

/** The most each box holds. Nano's input is small: the formatted prompt stays inside its budget. */
export const NOTES_LIMITS = { pointsChars: 4000, unsureChars: 1500 } as const;

/** The notes' label, computed like the PM question's: the subject's lock, the owner's mark, and any restricted turn they carry. The strongest wins. */
export function notesLabel(task: Pick<TaskView, 'route'> | undefined, marked: boolean, restrictedTurns: boolean): BriefLabel {
  return questionLabelFor(task, marked || restrictedTurns);
}

/** "Add this conversation": the owner's and PM's turns in this tab, as text after the marker line. Restricted when any turn is. */
export function conversationNotes(turns: readonly { readonly who: 'owner' | 'pm'; readonly text: string; readonly restricted: boolean }[]): { readonly text: string; readonly restricted: boolean } {
  const lines = turns.filter((t) => t.text.trim()).map((t) => `${t.who === 'owner' ? 'Owner' : 'Project Manager'}: ${one(t.text)}`);
  return { text: [CONVERSATION_MARKER, ...lines].join('\n'), restricted: turns.some((t) => t.restricted) };
}

/** Notes as labelled texts: `P|` starts each piece of the points, `U|` each piece of the questions. */
export function encodeNotes(points: string, unsure: string, label: BriefLabel): AiCheckpointText[] {
  const chunks = (tag: string, s: string): AiCheckpointText[] => {
    const out: AiCheckpointText[] = [];
    for (let i = 0; i < s.length; i += 1998) out.push({ who: 'owner', text: `${tag}${s.slice(i, i + 1998)}`, classification: label });
    return out;
  };
  return [...chunks('P|', points.slice(0, NOTES_LIMITS.pointsChars)), ...chunks('U|', unsure.slice(0, NOTES_LIMITS.unsureChars))];
}
export function decodeNotes(texts: readonly AiCheckpointText[]): { readonly points: string; readonly unsure: string } {
  return { points: texts.filter((t) => t.text.startsWith('P|')).map((t) => t.text.slice(2)).join(''), unsure: texts.filter((t) => t.text.startsWith('U|')).map((t) => t.text.slice(2)).join('') };
}

/**
 * One notes checkpoint per run and subject task (a checkpoint keeps its task). H13 fix round 2 (N5, noted): the id is derived from the run and task only, not the
 * owner. The server keys checkpoints by tenant, project and id and refuses another owner's id (404), so two owners of one project writing notes for the same
 * task would collide there: the second owner's notes would stay on their device. Projects have one owner today.
 */
export const notesCheckpointId = (runId: string, taskId: string): string => `ckp_notes_${sha256Hex(`${runId}\u0000${taskId}`).slice(0, 32)}`;

export function notesCheckpoint(n: { projectId: string; runId: string; taskId: string; taskRevision: number; planRevision: number | null; points: string; unsure: string; label: BriefLabel; at: string; createdAt?: string }): AiCheckpoint {
  return {
    checkpointId: notesCheckpointId(n.runId, n.taskId), projectId: n.projectId, taskId: n.taskId, taskRevision: Math.max(1, n.taskRevision), runId: n.runId, planRevision: n.planRevision,
    stepKind: RESEARCH_NOTES_KIND, stage: 'research_notes', callOverride: null, routeMode: null, continuation: 'device_only', labels: [n.label], locked: n.label === 'restricted',
    inputs: { contextId: null, bundleSha256: null, files: [], inputChars: n.points.length + n.unsure.length },
    partial: { issues: [], texts: encodeNotes(n.points, n.unsure, n.label).slice(0, 8) }, stopReason: null, status: 'done', routeRecordId: null, escalatedAt: null, resumedAs: null,
    createdAt: n.createdAt ?? n.at, updatedAt: n.at,
  };
}

/** The run's latest notes, re-judged by the subject's lock now (I4): a task locked since makes them restricted; an unknown route counts as locked. */
export function latestNotes(checkpoints: Readonly<Record<string, AiCheckpoint>>, snap: ProjectViewSnapshot | null, runId: string, taskId?: string): { readonly points: string; readonly unsure: string; readonly label: BriefLabel; readonly taskId: string } | null {
  const cp = Object.values(checkpoints).filter((c) => c.stepKind === RESEARCH_NOTES_KIND && c.runId === runId && (taskId === undefined || c.taskId === taskId) && c.status === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!cp) return null;
  const route = snap?.tasks[cp.taskId]?.route;
  const now = !route || route.lock !== null ? 'restricted' : 'internal';
  const stored = [...cp.labels, ...(cp.partial?.texts ?? []).map((t) => t.classification), ...(cp.locked ? ['restricted'] : [])].reduce<string>((a, l) => strongerLabel(a, l), 'public');
  const label: BriefLabel = strongerLabel(stored, now) === 'internal' || strongerLabel(stored, now) === 'public' ? 'internal' : 'restricted';
  return { ...decodeNotes(cp.partial?.texts ?? []), label, taskId: cp.taskId };
}

// ---- the reviewed brief, kept (fix round 1, I3) --------------------------------------------------------------------------------

/** One reviewed brief per run and subject task, as the notes. */
export const briefCheckpointId = (runId: string, taskId: string): string => `ckp_brief_${sha256Hex(`${runId}\u0000${taskId}`).slice(0, 32)}`;

/** What is kept of a draft: everything but the owner's line texts, which come back from the notes. Its approval hash is `inputs.briefSha256`. */
type KeptDraft = Omit<BriefDraft, 'inLines' | 'approvedSha256'> & { readonly inLines: readonly { readonly n: number; readonly list: BriefLine['list'] }[] };

/**
 * The reviewed brief as a checkpoint under the H12 split: its JSON in labelled texts (restricted ones stay on this device, and a server copy is deleted), its
 * approval hash in `inputs.briefSha256`.
 */
export function briefCheckpoint(n: { projectId: string; runId: string; taskId: string; taskRevision: number; planRevision: number | null; draft: BriefDraft; at: string }): AiCheckpoint {
  const { inLines, approvedSha256, ...rest } = n.draft;
  const kept: KeptDraft = { ...rest, inLines: inLines.map((l) => ({ n: l.n, list: l.list })) };
  const json = JSON.stringify(kept);
  const texts: AiCheckpointText[] = [];
  for (let i = 0; i < json.length && texts.length < 8; i += 2000) texts.push({ who: 'owner', text: json.slice(i, i + 2000), classification: n.draft.label });
  return {
    checkpointId: briefCheckpointId(n.runId, n.taskId), projectId: n.projectId, taskId: n.taskId, taskRevision: Math.max(1, n.taskRevision), runId: n.runId, planRevision: n.planRevision,
    stepKind: PLAN_BRIEF_KIND, stage: 'research_notes', callOverride: null, routeMode: null, continuation: 'device_only', labels: [n.draft.label], locked: n.draft.label === 'restricted',
    inputs: { contextId: null, bundleSha256: null, files: [], inputChars: json.length, briefSha256: json.length <= 16000 ? approvedSha256 : null },
    partial: { issues: [], texts }, stopReason: null, status: 'done', routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: n.at, updatedAt: n.at,
  };
}

/**
 * The kept reviewed brief for a run and subject task, or null. Re-judged by the subject's lock now: a task locked since makes it restricted, with nothing ticked
 * and no approval. A text that does not read back is null (nothing is guessed). Line texts come from `notes` when given.
 */
export function latestBrief(checkpoints: Readonly<Record<string, AiCheckpoint>>, snap: ProjectViewSnapshot | null, runId: string, taskId: string, notes?: { readonly points: string; readonly unsure: string } | null): BriefDraft | null {
  const cp = checkpoints[briefCheckpointId(runId, taskId)];
  if (!cp || cp.stepKind !== PLAN_BRIEF_KIND || cp.status !== 'done') return null;
  let kept: KeptDraft;
  try { kept = JSON.parse((cp.partial?.texts ?? []).map((t) => t.text).join('')) as KeptDraft; } catch { return null; }
  if (!kept || !Array.isArray(kept.items) || !Array.isArray(kept.uncertainties) || !Array.isArray(kept.inLines)) return null;
  const route = snap?.tasks[taskId]?.route;
  const stored = [...cp.labels, ...(cp.partial?.texts ?? []).map((t) => t.classification), ...(cp.locked ? ['restricted'] : [])].reduce<string>((a, l) => strongerLabel(a, l), 'public');
  const restricted = strongerLabel(stored, !route || route.lock !== null ? 'restricted' : 'internal') !== 'internal' && strongerLabel(stored, !route || route.lock !== null ? 'restricted' : 'internal') !== 'public';
  const lines = notes ? briefInLines(notes.points, notes.unsure) : [];
  const inLines = kept.inLines.map((l) => ({ n: l.n, list: l.list, text: lines.find((x) => x.n === l.n)?.text ?? `(line ${l.n})` }));
  const draft: BriefDraft = { ...kept, inLines, approvedSha256: cp.inputs.briefSha256 ?? null };
  return restricted ? restrictBrief(draft) : draft;
}
