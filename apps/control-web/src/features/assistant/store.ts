import { create } from 'zustand';
import type { AssistantProposal, DeviceReadiness, InferenceMode, ObservedSource, ProposalStatus } from '@selarikru/inference-firebase-web';
import type { ProposalOperation } from '@selarikru/domain';

/**
 * UI state for the assistant. Deliberately not persisted, and it never holds prompt text. For restricted work it holds
 * metadata only: the draft itself lives in RestrictedDraftHold.
 */
export interface ResultMeta {
  readonly requestId: string;
  readonly operation: ProposalOperation;
  readonly status: ProposalStatus;
  readonly demo: boolean;
  readonly restricted: boolean;
  readonly briefId: string;
  readonly selectedMode: InferenceMode;
  readonly requestedMode: InferenceMode | null;
  readonly observedSource: ObservedSource;
  readonly rawInferenceSource: string | null;
  readonly totalMs: number;
  readonly schemaStatus: AssistantProposal['validation']['status'];
  readonly schemaErrors: readonly string[];
  readonly blockedReason: string | null;
  readonly errorName: string | null;
  readonly cloudModel: string;
  readonly sdkVersion: string;
  /** Set only for a held restricted draft. */
  readonly draftId: string | null;
  /** Null for restricted work. Never holds restricted output. */
  readonly proposal: AssistantProposal | null;
}

export type DownloadState = { readonly phase: 'idle' } | { readonly phase: 'running'; readonly fraction: number | null } | { readonly phase: 'failed' };

interface AssistantState {
  mode: InferenceMode;
  operation: ProposalOperation;
  briefId: string;
  cloudPermitted: boolean;
  demo: boolean;
  device: DeviceReadiness | null;
  cloudModel: string | null;
  sdkVersion: string | null;
  download: DownloadState;
  generating: boolean;
  result: ResultMeta | null;
  set: (patch: Partial<Pick<AssistantState, 'mode' | 'operation' | 'briefId' | 'cloudPermitted' | 'demo'>>) => void;
  setReadiness: (r: { device: DeviceReadiness; cloudModel: string; sdkVersion: string }) => void;
  setDownload: (d: DownloadState) => void;
  setGenerating: (g: boolean) => void;
  setResult: (r: ResultMeta | null) => void;
}

export const useAssistantStore = create<AssistantState>()((set) => ({
  mode: 'ONLY_ON_DEVICE',
  operation: 'suggestCriteria',
  briefId: 'brief-01',
  cloudPermitted: true,
  demo: false,
  device: null,
  cloudModel: null,
  sdkVersion: null,
  download: { phase: 'idle' },
  generating: false,
  result: null,
  set: (patch) => set(patch),
  setReadiness: (r) => set({ device: r.device, cloudModel: r.cloudModel, sdkVersion: r.sdkVersion }),
  setDownload: (download) => set({ download }),
  setGenerating: (generating) => set({ generating }),
  setResult: (result) => set({ result }),
}));
