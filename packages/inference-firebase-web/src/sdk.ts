import type { InferenceMode } from '@selarikru/policy';

/**
 * The only surface the adapter uses from the Firebase SDK. Tests fake it; the production
 * binding lives in firebase-sdk.ts. Nothing here carries conversation history: every
 * generate call is single-turn.
 */
export type DeviceAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown';

export interface ModelSpec {
  /** Effective SDK mode. Device-only requests are always built as ONLY_ON_DEVICE. */
  readonly mode: InferenceMode;
  /** False means the model must not be given any cloud params: the SDK cannot fall back to the cloud. */
  readonly allowCloud: boolean;
  readonly systemInstruction: string;
  /** Request JSON Schema, already narrowed to this request's allowed requirement IDs. */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * H11: Grounding with Google Search, through Firebase AI Logic's `tools: [{ googleSearch: {} }]`. Only ever set on a cloud-only model (the adapter refuses it
   * anywhere else). A grounded model is not given the response schema; the adapter still validates the answer against it.
   */
  readonly grounding?: 'googleSearch';
}

/** What Grounding with Google Search returned: the web sources and the Search Suggestions snippet, which the terms require to be shown as given. */
export interface SdkGrounding {
  readonly sources: readonly { readonly uri: string; readonly title: string | null }[];
  /** `searchEntryPoint.renderedContent`: HTML/CSS to render as is, in a shadow root. Null when the response carried none. */
  readonly entryPointHtml: string | null;
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
  /** A grounded call's sources and search suggestions (H11). */
  readonly grounding?: SdkGrounding | undefined;
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
