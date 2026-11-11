import { strongerLabel, type AiCheckpoint } from '@selarikru/domain';
import type { PmTurn } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';

/**
 * H12: the Project Manager's memory, its earlier turns kept as checkpoints. Fix round 1 (I4): each turn is labelled by its task's lock now, not only by the label
 * it was stored with: a task that became locked (or whose route is not known) makes its remembered turns restricted, so they never reach a cloud-capable prompt.
 * Only turns from before this tab are remembered; later ones are already in this tab's conversation.
 */
export function rememberedTurns(checkpoints: Readonly<Record<string, AiCheckpoint>>, snap: ProjectViewSnapshot | null, before: string): PmTurn[] {
  return Object.values(checkpoints)
    .filter((cp) => cp.stepKind.startsWith('pm') && (cp.status === 'done' || cp.status === 'sent') && cp.createdAt < before && (cp.partial?.texts.length ?? 0) > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((cp) => {
      const route = snap?.tasks[cp.taskId]?.route;
      const now = !route || route.lock !== null ? 'restricted' : 'internal';
      return cp.partial!.texts.map((t): PmTurn => ({ who: t.who, text: t.text, classification: strongerLabel(t.classification, now) }));
    });
}
