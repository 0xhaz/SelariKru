import { z } from 'zod';
import { RoutePolicyModeSchema } from './route-policy.ts';

/**
 * Settings the owner can change while a run is live. Each one stores a desired revision; its effective revision advances only when the component that
 * enforces it says so: the server, in the same transaction as the save, for policy it enforces itself; the runner, on its next claim poll or heartbeat,
 * for what it holds in its own loop. A save is never the same thing as applied.
 */
export const RUN_SETTING_FIELDS = ['paused', 'budget_limit_usd', 'allowed_paths', 'cloud_eligible', 'route_policy', 'auto_delegate'] as const;
/** H11: a worker's owner-given name and its role (the role decides which tasks it may claim, from its next attempt). */
export const RUNNER_SETTING_FIELDS = ['enabled', 'slots', 'display_name', 'role'] as const;
/** A task's own settings. `route_override` replaces the run's `route_policy` for this task; null clears it. */
export const TASK_SETTING_FIELDS = ['route_override'] as const;
export type RunSettingField = (typeof RUN_SETTING_FIELDS)[number];
export type RunnerSettingField = (typeof RUNNER_SETTING_FIELDS)[number];
export type TaskSettingField = (typeof TASK_SETTING_FIELDS)[number];
export type SettingField = RunSettingField | RunnerSettingField | TaskSettingField;
export const SETTING_SCOPES = ['run', 'runner', 'task'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export type SettingEnforcer = 'server' | 'runner';
/** Who must acknowledge a change before it is shown as in force. A runner-acknowledged field is still gated on the server from the moment it is saved. */
export const SETTING_ENFORCER: Readonly<Record<SettingField, SettingEnforcer>> = {
  paused: 'runner', budget_limit_usd: 'server', allowed_paths: 'server', cloud_eligible: 'server', enabled: 'runner', slots: 'runner',
  // Route policy is metadata the server serves to the browser adapter: in force when the save commits.
  route_policy: 'server', route_override: 'server',
  // H11: names are labels the server serves; a role is enforced by the server at the next claim (a running attempt keeps the role it was claimed under);
  // auto-delegation is the server's own switch.
  display_name: 'server', role: 'server', auto_delegate: 'server',
};

/** Upper bound on a runner's slots. The server's total concurrency cap still applies on top. */
export const MAX_RUNNER_SLOTS = 64;

/** One path the run may still change. It must be one the accepted plan already lists: a setting can narrow the plan's scope, never widen it. */
const PlanPath = z.string().min(1).max(512);

export const SettingChangeSchema = z.discriminatedUnion('field', [
  z.object({ scope: z.literal('run'), field: z.literal('paused'), value: z.boolean() }).strict(),
  z.object({ scope: z.literal('run'), field: z.literal('budget_limit_usd'), value: z.number().finite().min(0).max(1_000_000) }).strict(),
  z.object({ scope: z.literal('run'), field: z.literal('allowed_paths'), value: z.array(PlanPath).max(200) }).strict(),
  z.object({ scope: z.literal('run'), field: z.literal('cloud_eligible'), value: z.boolean() }).strict(),
  z.object({ scope: z.literal('runner'), field: z.literal('enabled'), value: z.boolean() }).strict(),
  z.object({ scope: z.literal('runner'), field: z.literal('slots'), value: z.number().int().min(1).max(MAX_RUNNER_SLOTS) }).strict(),
  /** The run's default route policy for every task's AI steps. Seeded from the onboarding choice; a run default cannot be cleared, only changed. */
  z.object({ scope: z.literal('run'), field: z.literal('route_policy'), value: RoutePolicyModeSchema }).strict(),
  /** One task's route policy override; null clears it. A cloud-capable value on a task locked by restricted data is refused (`route_locked_restricted`). */
  z.object({ scope: z.literal('task'), field: z.literal('route_override'), value: RoutePolicyModeSchema.nullable() }).strict(),
  /** H11: the worker's name (1-24 characters, any script, unique per project: checked by `workerNameProblem`); null clears it and the role label shows. */
  z.object({ scope: z.literal('runner'), field: z.literal('display_name'), value: z.string().min(1).max(96).nullable() }).strict(),
  /** H11: the worker's role, one of the project's roles; it takes effect from the worker's next claim. */
  z.object({ scope: z.literal('runner'), field: z.literal('role'), value: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }).strict(),
  /** H11: whether the Project Manager's assignments inside the accepted plan apply on their own (on by default, per the owner). */
  z.object({ scope: z.literal('run'), field: z.literal('auto_delegate'), value: z.boolean() }).strict(),
]);
export type SettingChange = z.infer<typeof SettingChangeSchema>;
export type SettingValue = SettingChange['value'];

/**
 * True when `after` takes away something `before` allowed: a path removed, cloud or a worker switched off, fewer slots, a lower budget. A reduction blocks
 * new claims on the server at once, in the save's own transaction. Pausing is not a grant: it is judged by its own rule. A missing `before` reads as the
 * widest value, so the first narrowing of a field counts.
 */
export function isReduction(field: SettingField, before: SettingValue | null, after: SettingValue): boolean {
  switch (field) {
    case 'allowed_paths': return before === null || (before as string[]).some((p) => !(after as string[]).includes(p));
    case 'cloud_eligible':
    case 'enabled': return after === false && before !== false;
    case 'slots':
    case 'budget_limit_usd': return before === null || (after as number) < (before as number);
    case 'paused': return false;
    // Where a model runs is not a grant the scheduler holds: restricted data is kept on the device by the lock, whatever this says.
    case 'route_policy':
    case 'route_override': return false;
    // A name is a label; a role change is judged at the next claim; switching auto-delegation off takes nothing away from the owner.
    case 'display_name':
    case 'role':
    case 'auto_delegate': return false;
  }
}

/** A running attempt stopped because the owner narrowed what it was allowed. The task is blocked, not cancelled, so it can run again once the grant returns. */
export const POLICY_REVOKED_PREFIX = 'policy_revoked:';
export const policyRevokedReason = (field: 'allowed_paths' | 'cloud_eligible'): string => `${POLICY_REVOKED_PREFIX}${field}`;
export const isPolicyRevokedReason = (reason: string | null | undefined): boolean => typeof reason === 'string' && reason.startsWith(POLICY_REVOKED_PREFIX);

/** What a runner is sent on every claim poll and heartbeat: the tenant's current config revision and what it carries for this runner. */
export const RunnerConfigSchema = z
  .object({
    revision: z.number().int().min(0),
    /** False: the owner disabled this worker. The server refuses its claims whatever it does. */
    enabled: z.boolean(),
    /** Null: the owner has not limited it, so the runner keeps the slots it was started with. */
    slots: z.number().int().min(1).max(MAX_RUNNER_SLOTS).nullable(),
    /** Runs the owner paused. The server grants no claim for them; the runner records that it knows. */
    pausedRunIds: z.array(z.string().min(1).max(200)).max(500),
  })
  .strict();
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/** What a runner sends back: the config revision it has applied and the slots it actually runs. Numbers only, so no text can reach the server this way. */
export const RunnerConfigAckSchema = z.object({ revision: z.number().int().min(0), slots: z.number().int().min(0).max(MAX_RUNNER_SLOTS) }).strict();
export type RunnerConfigAck = z.infer<typeof RunnerConfigAckSchema>;
