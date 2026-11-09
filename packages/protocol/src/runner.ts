import { ApprovalDestinationSchema, RunnerHarnessReportSchema, WorkerApprovalOperationSchema } from '@selarikru/domain';
import { z } from 'zod';
import { redactSecrets } from './redact.ts';
import { TERMINAL_MAX_BATCH_LINES, TERMINAL_MAX_WIRE_LINE_CHARS } from './terminal.ts';

/** A git commit id. Anything else (and so any secret-shaped string) is rejected rather than stored in an event. */
export const CommitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a 40 or 64 digit hex commit id');
/** sha256 (lowercase hex) of the stored change manifest in the artifact store. */
const ManifestSha = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
const Cost = z.number().finite().min(0).nullable().optional();
const Tokens = z.number().int().min(0).max(1e12).nullable().optional();
const Seconds = z.number().finite().min(0).max(86_400).nullable().optional();
const CostBasis = z.literal('list').nullable().optional();
/** What the worker says it used. The API records it as an estimate at best; numbers only, so no text can enter the ledger this way. */
const ReportedUsage = z
  .object({ inputTokens: Tokens, outputTokens: Tokens, cacheReadTokens: Tokens, cacheCreationTokens: Tokens, setupSeconds: Seconds, idleSeconds: Seconds, costBasis: CostBasis })
  .strict()
  .optional();

/** A destination is stored and shown, so one shaped like a credential is refused here as well as in the harness parser. */
const WireDestination = ApprovalDestinationSchema.refine((d) => redactSecrets(d.host) === d.host, 'the destination looks like a secret');

/** The runner presents only what it was given at claim. The API rebuilds the rest from the database. */
export const LeaseRefSchema = z
  .object({ attemptId: z.string().min(1), fence: z.number().int().min(0), leaseToken: z.string().min(1) })
  .strict();
export type LeaseRef = z.infer<typeof LeaseRefSchema>;

/** `harnesses`: what this runner can launch now, probed on its own machine. Absent: the last report stands. */
export const ClaimRequestSchema = z.object({
  harnesses: z.array(RunnerHarnessReportSchema).max(20).optional(),
  /** Project ids this runner has a source checkout for. Ids only: a path is refused by the pattern. Absent: the last report stands. */
  projects: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'expected a project id')).max(500).optional(),
}).strict();

/** The name of the tool a worker last started. A name and nothing else: no arguments, paths or output can fit, and a credential-shaped one is refused. */
export const ToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/, 'expected a tool name').refine((n) => redactSecrets(n) === n, 'the tool name looks like a secret');

/** One line of a worker's output, already redacted by the runner. Bounded here so a buggy or hostile runner cannot use this route to fill memory. */
export const TerminalLineSchema = z.object({ at: z.string().datetime(), text: z.string().max(TERMINAL_MAX_WIRE_LINE_CHARS) }).strict();
export type TerminalLine = z.infer<typeof TerminalLineSchema>;

/** One upload from the runner's output feed. `seq` lets a retried upload be recognised and not applied twice. `dropped` counts lines the runner lost to its own bound since the last acknowledged batch. */
export const TerminalUploadRequestSchema = z.object({ lease: LeaseRefSchema, seq: z.number().int().min(0), lines: z.array(TerminalLineSchema).max(TERMINAL_MAX_BATCH_LINES), dropped: z.number().int().min(0), ended: z.boolean() }).strict();
export type TerminalUploadRequest = z.infer<typeof TerminalUploadRequestSchema>;

export const HeartbeatRequestSchema = z.object({ lease: LeaseRefSchema, activity: ToolNameSchema.optional() }).strict();

export const ResultRequestSchema = z
  .object({
    lease: LeaseRefSchema,
    result: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('completed'), headSha: CommitSha.optional(), changeManifestSha256: ManifestSha.optional(), reportedCostUsd: Cost, reportedUsage: ReportedUsage }).strict(),
      z.object({ outcome: z.literal('failed'), reason: z.string().min(1).max(500), reportedCostUsd: Cost, reportedUsage: ReportedUsage }).strict(),
      z.object({ outcome: z.literal('blocked'), reason: z.string().min(1).max(500), reportedCostUsd: Cost, reportedUsage: ReportedUsage }).strict(),
      // `operation` is one of the closed worker list; anything else is refused here. Absent is denied by policy.
      z.object({ outcome: z.literal('approval_requested'), reason: z.string().min(1).max(500), operation: WorkerApprovalOperationSchema.optional(), destination: WireDestination.optional(), reportedCostUsd: Cost, reportedUsage: ReportedUsage }).strict(),
    ]),
  })
  .strict();
export type ResultRequest = z.infer<typeof ResultRequestSchema>;
