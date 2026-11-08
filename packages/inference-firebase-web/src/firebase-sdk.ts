/**
 * Production binding of the AssistantSdk boundary to Firebase AI Logic (firebase@13.1.0,
 * Gemini Developer API backend). This is the only file that imports the Firebase SDK.
 * Live behaviour is checked in T7.1; unit tests fake AssistantSdk instead.
 */
import type { FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode as FbMode, type GenerativeModel } from 'firebase/ai';
import { CLOUD_MODEL } from './models.ts';
import type { AssistantSdk, DeviceAvailability, ModelSpec, SdkModel } from './sdk.ts';

export interface FirebaseSdkConfig {
  readonly app: FirebaseApp;
  /** reCAPTCHA Enterprise (Fraud Defense) site key. Without it App Check is not initialized. */
  readonly recaptchaSiteKey?: string | undefined;
}

interface LanguageModelApi {
  availability(options?: unknown): Promise<string>;
}

export function initAppCheck(app: FirebaseApp, siteKey: string): void {
  if (import.meta.env.DEV) {
    // Local debug provider only. Statically dead in production builds; the token is registered
    // privately in the console and never committed.
    (globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
}

function toAvailability(raw: string | undefined): DeviceAvailability {
  return raw === 'available' || raw === 'downloadable' || raw === 'downloading' || raw === 'unavailable' ? raw : 'unknown';
}

export function createFirebaseSdk(cfg: FirebaseSdkConfig): AssistantSdk {
  if (cfg.recaptchaSiteKey) initAppCheck(cfg.app, cfg.recaptchaSiteKey);
  const ai = getAI(cfg.app, { backend: new GoogleAIBackend() });

  const build = (spec: ModelSpec): GenerativeModel =>
    getGenerativeModel(ai, {
      mode: FbMode[spec.mode],
      inCloudParams: {
        model: CLOUD_MODEL,
        systemInstruction: spec.systemInstruction,
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: spec.schema },
      },
      onDeviceParams: {
        // The SDK ignores the request-level system instruction on-device.
        createOptions: { initialPrompts: [{ role: 'system', content: [{ type: 'text', value: spec.systemInstruction }] }] },
        promptOptions: { responseConstraint: spec.schema },
      },
    });

  return {
    async availability() {
      const lm = (globalThis as unknown as { LanguageModel?: LanguageModelApi }).LanguageModel;
      if (!lm) return 'unavailable';
      try {
        return toAvailability(await lm.availability());
      } catch {
        return 'unknown';
      }
    },
    async initializeDeviceModel(onProgress) {
      const m = build({ mode: 'ONLY_ON_DEVICE', systemInstruction: '', schema: { type: 'object' } });
      await m.initializeDeviceModel(onProgress);
    },
    createModel(spec): SdkModel {
      const model = build(spec);
      return {
        async generate(prompt) {
          const res = await model.generateContent(prompt);
          const u = res.response.usageMetadata;
          return {
            text: res.response.text(),
            inferenceSource: res.response.inferenceSource,
            usage: u
              ? { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, totalTokens: u.totalTokenCount }
              : undefined,
          };
        },
      };
    },
  };
}
