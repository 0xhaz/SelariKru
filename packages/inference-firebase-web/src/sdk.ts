import type { InferenceMode } from '@selarikru/policy';

/**
 * The only surface the adapter uses from the Firebase SDK. Tests fake it; the production
 * binding lives in firebase-sdk.ts. Nothing here carries conversation history: every
 * generate call is single-turn.
 */
export type DeviceAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown';

export interface ModelSpec {
  readonly mode: InferenceMode;
  readonly systemInstruction: string;
  /** Request JSON Schema, already narrowed to this request's allowed requirement IDs. */
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface SdkUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
}

export interface SdkGenerateResult {
  readonly text: string;
  /** Raw `response.inferenceSource` as the SDK returned it (lowercase `on_device` / `in_cloud`). */
  readonly inferenceSource?: string | undefined;
  /** Provider token metadata, only where the SDK supplied it. */
  readonly usage?: SdkUsage | undefined;
}

export interface SdkModel {
  generate(prompt: string): Promise<SdkGenerateResult>;
}

export interface AssistantSdk {
  availability(): Promise<DeviceAvailability>;
  /** Must be called from a user gesture; a first download can take several minutes. */
  initializeDeviceModel(onProgress: (fraction: number) => void): Promise<void>;
  createModel(spec: ModelSpec): SdkModel;
}
