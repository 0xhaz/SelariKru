import { initializeApp, SDK_VERSION } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type GenerativeModel,
} from "firebase/ai";
import Ajv from "ajv";
import fixtures from "../fixtures/brief-fixtures.json";

// Pinned cloud model (GA per https://firebase.google.com/docs/ai-logic/models).
const CLOUD_MODEL = "gemini-3.5-flash-lite";

// Public web client config (not a secret).
const firebaseConfig = {
  projectId: "selarikru",
  appId: "1:808736999784:web:991baa74a0aa41bae6eedd",
  storageBucket: "selarikru.firebasestorage.app",
  apiKey: "AIzaSyBEMbdymrhgD-OT2TBYlw8huB5D-BLTSyQ",
  authDomain: "selarikru.firebaseapp.com",
  messagingSenderId: "808736999784",
};

const app = initializeApp(firebaseConfig);

// ---- App Check ----
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
let appCheckState: string;
if (siteKey) {
  if (import.meta.env.DEV) {
    // Dev server only; this branch is removed from production builds.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckState = import.meta.env.DEV
      ? "configured (dev: debug provider; register the console debug token)"
      : "configured (Fraud Defense production attestation)";
  } catch (e) {
    appCheckState = `initialization FAILED: ${String(e)}`;
  }
} else {
  appCheckState = "App Check not configured (VITE_RECAPTCHA_SITE_KEY unset)";
}

// ---- Fixture ----
const fixture = fixtures.fixtures.find((f) => f.id === "brief-01")!;
const systemInstruction = fixtures.systemInstruction;
const outputSchema = fixtures.outputSchema as Record<string, unknown>;
const validate = new Ajv({ strict: false }).compile(outputSchema);

// Request schema: the fixture schema with requirementId narrowed to this fixture's allowed IDs.
// Validation above still uses the unmodified fixture schema plus the allowed-ID check.
const requestSchema = JSON.parse(JSON.stringify(outputSchema));
requestSchema.properties.acceptanceCriteria.items.properties.requirementId.enum = fixture.allowedRequirementIds;
const promptText = `${fixture.prompt}\n\nAllowed requirement IDs: ${fixture.allowedRequirementIds.join(", ")}. Use only these IDs. Several criteria may share one ID.`;

// ---- Models: one distinct instance per mode ----
// Structured output per route (see report):
//  - cloud: inCloudParams.generationConfig { responseMimeType, responseJsonSchema } + systemInstruction
//  - device: onDeviceParams.promptOptions.responseConstraint (JSON Schema); the SDK ignores
//    request-level systemInstruction on-device, so it goes in createOptions.initialPrompts.
const ai = getAI(app, { backend: new GoogleAIBackend() });

type ModeName = "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE" | "ONLY_IN_CLOUD" | "PREFER_IN_CLOUD";
const MODES: ModeName[] = ["ONLY_ON_DEVICE", "PREFER_ON_DEVICE", "ONLY_IN_CLOUD", "PREFER_IN_CLOUD"];

function makeModel(mode: ModeName): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: InferenceMode[mode],
    inCloudParams: {
      model: CLOUD_MODEL,
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: requestSchema,
      },
    },
    onDeviceParams: {
      createOptions: {
        initialPrompts: [{ role: "system", content: [{ type: "text", value: systemInstruction }] }],
      },
      promptOptions: { responseConstraint: requestSchema },
    },
  });
}
const models = Object.fromEntries(MODES.map((m) => [m, makeModel(m)])) as Record<ModeName, GenerativeModel>;

// ---- State ----
interface ResultRow {
  requestedMode: ModeName;
  observedInferenceSource: string; // raw from response.inferenceSource, "UNKNOWN" if absent
  elapsedMs: number; // performance.now() delta
  startedAt: string;
  rawOutput: string | null;
  error: string | null;
  validation: { pass: boolean; details: string[] } | null;
}
const results: ResultRow[] = [];
let deviceInit: Record<string, unknown> = { run: false };

const chromeVersion = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "unknown";
const env = {
  chromeVersion,
  userAgent: navigator.userAgent,
  origin: location.origin,
  sdkVersion: SDK_VERSION,
  cloudModel: CLOUD_MODEL,
  appCheck: appCheckState,
  buildMode: import.meta.env.DEV ? "dev" : "production",
  buildId: "narrowed-ids-3",
  fixtureId: fixture.id,
};

const $ = (id: string) => document.getElementById(id)!;
for (const [k, v] of Object.entries(env)) {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.align = "left";
  th.textContent = k;
  const td = document.createElement("td");
  td.textContent = String(v);
  tr.append(th, td);
  $("env").appendChild(tr);
}

// ---- Device model ----
interface LM {
  availability(o?: unknown): Promise<string>;
}
$("init-device").addEventListener("click", async () => {
  const status = $("device-status");
  const info: Record<string, unknown> = { run: true };
  deviceInit = info;
  const lm = (globalThis as unknown as { LanguageModel?: LM }).LanguageModel;
  const t0 = performance.now();
  try {
    info.availabilityBefore = lm ? await lm.availability() : "LanguageModel API absent";
    info.availabilityCheckMs = Math.round(performance.now() - t0);
    status.textContent = JSON.stringify(info, null, 2);
    let lastProgress: number | null = null;
    const progress: { atMs: number; value: number }[] = [];
    const t1 = performance.now();
    await models.ONLY_ON_DEVICE.initializeDeviceModel((p) => {
      lastProgress = p;
      progress.push({ atMs: Math.round(performance.now() - t1), value: p });
      status.textContent = `${JSON.stringify(info, null, 2)}\ndownloading: ${(p * 100).toFixed(2)}%`;
    });
    info.initializeDeviceModelMs = Math.round(performance.now() - t1);
    info.lastProgress = lastProgress;
    info.progressEventCount = progress.length;
    info.progressSamples = progress.length > 20 ? progress.filter((_, i) => i % Math.ceil(progress.length / 20) === 0) : progress;
    info.availabilityAfter = lm ? await lm.availability() : "LanguageModel API absent";
  } catch (e) {
    info.error = describeError(e);
    info.elapsedBeforeErrorMs = Math.round(performance.now() - t0);
  }
  status.textContent = JSON.stringify(info, null, 2);
});

// ---- Generation ----
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return `${e.name}${code ? ` [${code}]` : ""}: ${e.message}`;
  }
  return String(e);
}

function check(text: string): { pass: boolean; details: string[] } {
  const details: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { pass: false, details: [`JSON.parse failed: ${String(e)}`] };
  }
  let pass = true;
  if (!validate(parsed)) {
    pass = false;
    details.push(...(validate.errors ?? []).map((er) => `schema: ${er.instancePath} ${er.message}`));
  }
  const allowed = new Set(fixture.allowedRequirementIds);
  const crit = (parsed as { acceptanceCriteria?: { requirementId?: string }[] })?.acceptanceCriteria;
  if (Array.isArray(crit)) {
    for (const c of crit) {
      if (!allowed.has(c?.requirementId as string)) {
        pass = false;
        details.push(`requirementId not allowed for ${fixture.id}: ${String(c?.requirementId)}`);
      }
    }
  } else {
    pass = false;
    details.push("acceptanceCriteria missing, cannot check allowedRequirementIds");
  }
  return { pass, details };
}

async function run(mode: ModeName) {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const row: ResultRow = {
    requestedMode: mode,
    observedInferenceSource: "UNKNOWN",
    elapsedMs: 0,
    startedAt,
    rawOutput: null,
    error: null,
    validation: null,
  };
  try {
    const res = await models[mode].generateContent(promptText);
    row.elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
    row.observedInferenceSource = res.response.inferenceSource ?? "UNKNOWN";
    row.rawOutput = res.response.text();
    row.validation = check(row.rawOutput);
  } catch (e) {
    row.elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
    row.error = describeError(e);
  }
  results.push(row);
  render();
}

$("modes").innerHTML = "";
for (const m of MODES) {
  const b = document.createElement("button");
  b.textContent = `Run ${m}`;
  b.addEventListener("click", () => {
    b.disabled = true;
    void run(m).finally(() => (b.disabled = false));
  });
  $("modes").appendChild(b);
}

function render() {
  const box = $("results");
  box.innerHTML = "";
  results.forEach((r, i) => {
    const d = document.createElement("div");
    d.style.cssText = "border:1px solid #888;margin:8px 0;padding:6px";
    const head = document.createElement("div");
    const verdict = r.error ? "ERROR" : r.validation?.pass ? "PASS" : "FAIL";
    head.textContent = `#${i + 1} requested=${r.requestedMode} observed inferenceSource=${r.observedInferenceSource} elapsed=${r.elapsedMs}ms validation=${verdict}`;
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent =
      (r.error ? `error: ${r.error}\n` : "") +
      (r.validation?.details.length ? `validation details:\n${r.validation.details.join("\n")}\n` : "") +
      (r.rawOutput !== null ? `raw output:\n${r.rawOutput}` : "");
    d.append(head, pre);
    box.appendChild(d);
  });
}

$("copy").addEventListener("click", async () => {
  const evidence = { capturedAt: new Date().toISOString(), environment: env, request: { promptText, requestRequirementIdEnum: fixture.allowedRequirementIds }, deviceModel: deviceInit, results };
  const text = JSON.stringify(evidence, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $("copy-status").textContent = " copied";
  } catch (e) {
    $("copy-status").textContent = ` clipboard failed (${String(e)}); JSON below`;
    const pre = document.createElement("pre");
    pre.textContent = text;
    $("results").prepend(pre);
  }
});
