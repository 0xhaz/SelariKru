import { z } from 'zod';
import type { BrainSection } from './brain.ts';

/**
 * The stack catalog (docs/framework-tool-catalog.md). Static, versioned data: what a target application may be built with, so an owner can record it per component and
 * a worker can be told it. Selecting an entry is metadata only. It authenticates nothing, installs nothing, spends nothing, grants nothing and changes no repository.
 *
 * - Each entry has one canonical id. Labels and aliases are spellings of it, never identities of their own: a label listed in two tables is one entry in both categories.
 * - Readiness is several separate axes (§6). Nothing is tested unless something in this workspace has run it, and then only for the platform, action and version that ran.
 * - Detection reads manifests, lockfiles and config files as data. It never runs a script, a package manager or anything in the repository.
 */
export const STACK_CATALOG_VERSION = '2026-11-10.1';

export const STACK_FILTERS = ['web', 'backend', 'mobile', 'desktop', 'ai_data', 'tools'] as const;
export type StackFilter = (typeof STACK_FILTERS)[number];
export const STACK_FILTER_LABELS: Readonly<Record<StackFilter, string>> = { web: 'Web', backend: 'Backend/API', mobile: 'Mobile', desktop: 'Desktop', ai_data: 'AI/Data', tools: 'Tools' };

export const STACK_TARGETS = ['web', 'server', 'ios', 'android', 'desktop'] as const;
export type StackTarget = (typeof STACK_TARGETS)[number];
export const STACK_TARGET_LABELS: Readonly<Record<StackTarget, string>> = { web: 'Web', server: 'Server', ios: 'iOS', android: 'Android', desktop: 'Desktop' };

export const STACK_SECTIONS = ['frameworks', 'services'] as const;
export type StackSection = (typeof STACK_SECTIONS)[number];
export const STACK_SECTION_LABELS: Readonly<Record<StackSection, string>> = { frameworks: 'Frameworks & runtimes', services: 'Tools & services' };

export const STACK_CATEGORY_IDS = [
  'frameworks', 'languages', 'runtimes',
  'auth', 'payments', 'database_engines', 'database_platforms', 'orm', 'analytics', 'security', 'ui', 'state', 'api_protocols', 'testing', 'observability', 'hosting',
  'ci_review', 'mobile_build', 'messaging', 'storage', 'search', 'jobs', 'cache_realtime', 'cms', 'flags', 'product_work', 'package_build', 'environment', 'model_access',
] as const;
export type StackCategoryId = (typeof STACK_CATEGORY_IDS)[number];
export const StackCategoryIdSchema = z.enum(STACK_CATEGORY_IDS);

export interface StackCategory {
  readonly id: StackCategoryId;
  readonly label: string;
  readonly section: StackSection;
}

export const STACK_CATEGORIES: readonly StackCategory[] = ([
  ['frameworks', 'Frameworks & libraries', 'frameworks'], ['languages', 'Languages', 'frameworks'], ['runtimes', 'Execution runtimes', 'frameworks'],
  ['auth', 'Auth/identity', 'services'], ['payments', 'Payments/subscriptions', 'services'], ['database_engines', 'Database engines', 'services'],
  ['database_platforms', 'Database/backend platforms', 'services'], ['orm', 'ORM/query/migrations', 'services'], ['analytics', 'Product/web analytics', 'services'],
  ['security', 'Security/rate limits', 'services'], ['ui', 'UI/design/styling', 'services'], ['state', 'App state/data access', 'services'],
  ['api_protocols', 'API protocols/specifications', 'services'], ['testing', 'Testing/evaluation', 'services'], ['observability', 'Error monitoring/observability', 'services'],
  ['hosting', 'Hosting/cloud', 'services'], ['ci_review', 'CI/review', 'services'], ['mobile_build', 'Mobile build/distribution', 'services'],
  ['messaging', 'Email/messaging/push', 'services'], ['storage', 'Storage/media', 'services'], ['search', 'Search/vector retrieval', 'services'],
  ['jobs', 'Background jobs/queues', 'services'], ['cache_realtime', 'Cache/realtime', 'services'], ['cms', 'Content/CMS', 'services'],
  ['flags', 'Feature flags/experiments', 'services'], ['product_work', 'Product work/feedback', 'services'], ['package_build', 'Package/build/monorepo tools', 'services'],
  ['environment', 'Runtime/environment tools', 'services'], ['model_access', 'Model access', 'services'],
] as const).map(([id, label, section]) => ({ id, label, section }));
const CATEGORY = new Map(STACK_CATEGORIES.map((c) => [c.id, c]));
export const stackCategory = (id: StackCategoryId): StackCategory => CATEGORY.get(id)!;

export const STACK_ENTRY_KINDS = [
  'ui_library', 'framework', 'static_site', 'engine', 'library', 'language', 'runtime', 'service', 'tool', 'build_tool', 'package_manager', 'protocol', 'preset', 'generic',
] as const;
export type StackEntryKind = (typeof STACK_ENTRY_KINDS)[number];

/** Static signatures: names in a manifest, or the presence of a named file. Reviewed by hand; nothing here runs. */
export interface StackDetect {
  /** package.json dependency names; `@scope/*` matches the whole scope. */
  readonly npm?: readonly string[];
  readonly pypi?: readonly string[];
  /** go.mod module paths, matched as prefixes. */
  readonly go?: readonly string[];
  readonly cargo?: readonly string[];
  readonly gem?: readonly string[];
  readonly composer?: readonly string[];
  readonly pub?: readonly string[];
  /** File names (any depth), or `dir/name` tails; `*` is any run of characters other than `/`. Presence only. */
  readonly files?: readonly string[];
}

export interface StackEntry {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly kind: StackEntryKind;
  readonly categories: readonly StackCategoryId[];
  /** The discovery group it was listed under first. A group organises search; it does not say two entries are the same kind of software. */
  readonly group: string;
  readonly filter: StackFilter;
  readonly targets: readonly StackTarget[];
  /** The organisation behind a product, when several products share one. Each product keeps its own identity, categories and readiness. */
  readonly provider: string | null;
  readonly related: readonly string[];
  /** A preset is a convenience that stands for these entries together. */
  readonly presetOf: readonly string[] | null;
  readonly detect: StackDetect | null;
  /** A label seen in a reference screenshot whose canonical source is not established. No connector or credential destination is guessed for it. */
  readonly unresolvedIdentity: boolean;
  readonly provenance: 'framework-tool-catalog.md' | 'screenshot';
}

/** Spellings compare without case, spaces or punctuation. `+` and `#` are kept as words, so C, C++ and C# stay three languages. */
export function normalizeStackLabel(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\+/g, 'plus').replace(/#/g, 'sharp').replace(/[^a-z0-9]/g, '');
}
const slug = (s: string): string => s.toLowerCase().replace(/\+/g, 'plus').replace(/#/g, 'sharp').replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface Seed {
  readonly label: string;
  readonly id?: string;
  readonly aliases?: readonly string[];
  readonly kind?: StackEntryKind;
  readonly provider?: string;
  readonly targets?: readonly StackTarget[];
  readonly related?: readonly string[];
  readonly presetOf?: readonly string[];
  readonly detect?: StackDetect;
  readonly unresolvedIdentity?: true;
  readonly provenance?: 'screenshot';
}
type S = string | Seed;
interface Group { readonly group: string; readonly category: StackCategoryId; readonly filter: StackFilter; readonly kind: StackEntryKind; readonly targets: readonly StackTarget[]; readonly seeds: readonly S[] }

const npm = (...n: string[]): StackDetect => ({ npm: n });
const py = (...n: string[]): StackDetect => ({ pypi: n });
const files = (...n: string[]): StackDetect => ({ files: n });
const W: StackTarget[] = ['web'];
const SV: StackTarget[] = ['server'];
const MOB: StackTarget[] = ['ios', 'android'];

const GROUPS: readonly Group[] = [
  { group: 'Web UI libraries/frameworks', category: 'frameworks', filter: 'web', kind: 'ui_library', targets: W, seeds: [
    { label: 'React', aliases: ['React.js', 'ReactJS'], detect: npm('react') }, { label: 'Vue', aliases: ['Vue.js', 'VueJS'], detect: npm('vue') },
    { label: 'Angular', detect: npm('@angular/core') }, { label: 'Svelte', detect: npm('svelte') }, { label: 'Solid', aliases: ['SolidJS', 'Solid.js'], detect: npm('solid-js') },
    { label: 'Qwik', detect: npm('@builder.io/qwik', '@qwik.dev/core') }, { label: 'Preact', detect: npm('preact') }, { label: 'Lit', detect: npm('lit') },
    { label: 'Alpine.js', aliases: ['Alpine'], detect: npm('alpinejs') }, { label: 'HTMX', detect: npm('htmx.org') }, { label: 'Ember', aliases: ['Ember.js'], detect: npm('ember-source') },
    { label: 'React (Vite)', kind: 'preset', presetOf: ['react', 'vite'], related: ['react', 'vite'], provenance: 'screenshot' },
  ] },
  { group: 'Web application frameworks', category: 'frameworks', filter: 'web', kind: 'framework', targets: ['web', 'server'], seeds: [
    { label: 'Next.js', aliases: ['Next', 'NextJS'], related: ['react'], detect: { npm: ['next'], files: ['next.config.*'] } },
    { label: 'React Router', related: ['react', 'remix'], detect: npm('react-router', 'react-router-dom') }, { label: 'Remix', related: ['react-router'], detect: npm('@remix-run/*') },
    { label: 'Nuxt', aliases: ['Nuxt.js'], related: ['vue'], detect: { npm: ['nuxt'], files: ['nuxt.config.*'] } },
    { label: 'SvelteKit', related: ['svelte'], detect: { npm: ['@sveltejs/kit'], files: ['svelte.config.*'] } },
    { label: 'Astro', detect: { npm: ['astro'], files: ['astro.config.*'] } }, { label: 'SolidStart', related: ['solid'], detect: npm('@solidjs/start') },
    { label: 'Qwik City', related: ['qwik'], detect: npm('@builder.io/qwik-city') }, { label: 'TanStack Start', detect: npm('@tanstack/react-start', '@tanstack/start') },
    { label: 'Gatsby', related: ['react'], detect: { npm: ['gatsby'], files: ['gatsby-config.*'] } },
  ] },
  { group: 'Static/content sites', category: 'frameworks', filter: 'web', kind: 'static_site', targets: W, seeds: [
    { label: 'VitePress', detect: npm('vitepress') }, { label: 'VuePress', detect: npm('vuepress') }, { label: 'Docusaurus', detect: npm('@docusaurus/core') },
    { label: 'Eleventy', aliases: ['11ty'], detect: npm('@11ty/eleventy') }, { label: 'Hugo', detect: files('hugo.toml', 'hugo.yaml') }, { label: 'Jekyll', detect: { gem: ['jekyll'] } },
    { label: 'MkDocs', detect: files('mkdocs.yml') },
  ] },
  { group: 'JavaScript/TypeScript APIs', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Express', aliases: ['Express.js', 'ExpressJS'], detect: npm('express') }, { label: 'Fastify', detect: npm('fastify') }, { label: 'Hono', detect: npm('hono') },
    { label: 'NestJS', aliases: ['Nest'], detect: npm('@nestjs/core') }, { label: 'Koa', detect: npm('koa') }, { label: 'AdonisJS', detect: npm('@adonisjs/core') },
    { label: 'Elysia', detect: npm('elysia') }, { label: 'Hapi', detect: npm('@hapi/hapi') }, { label: 'tRPC', detect: npm('@trpc/server') },
  ] },
  { group: 'Python APIs/web', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Django', detect: py('django') }, { label: 'Django REST Framework', aliases: ['DRF'], related: ['django'], detect: py('djangorestframework') },
    { label: 'FastAPI', detect: py('fastapi') }, { label: 'Flask', detect: py('flask') }, { label: 'Starlette', detect: py('starlette') }, { label: 'Litestar', detect: py('litestar') },
    { label: 'Tornado', detect: py('tornado') },
  ] },
  { group: 'PHP', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Laravel', detect: { composer: ['laravel/framework'] } }, { label: 'Symfony', detect: { composer: ['symfony/framework-bundle'] } }, { label: 'Slim', detect: { composer: ['slim/slim'] } },
    { label: 'CodeIgniter', detect: { composer: ['codeigniter4/framework'] } }, { label: 'CakePHP', detect: { composer: ['cakephp/cakephp'] } }, 'WordPress',
    { label: 'Drupal', detect: { composer: ['drupal/core'] } },
  ] },
  { group: 'Ruby', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Ruby on Rails', aliases: ['Rails'], detect: { gem: ['rails'] } }, { label: 'Sinatra', detect: { gem: ['sinatra'] } }, { label: 'Hanami', detect: { gem: ['hanami'] } },
  ] },
  { group: 'JVM', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: ['Spring Boot', 'Spring Framework', 'Quarkus', 'Micronaut', 'Ktor', 'Jakarta EE'] },
  { group: '.NET web', category: 'frameworks', filter: 'backend', kind: 'framework', targets: ['server', 'web'], seeds: [{ label: 'ASP.NET Core', id: 'aspnet-core' }, 'Blazor', { label: 'ASP.NET MVC', id: 'aspnet-mvc' }] },
  { group: 'Go', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Standard net/http', id: 'go-net-http', aliases: ['net/http'] }, { label: 'Gin', detect: { go: ['github.com/gin-gonic/gin'] } },
    { label: 'Echo', detect: { go: ['github.com/labstack/echo'] } }, { label: 'Fiber', detect: { go: ['github.com/gofiber/fiber'] } }, { label: 'Chi', detect: { go: ['github.com/go-chi/chi'] } },
    { label: 'Beego', detect: { go: ['github.com/beego/beego'] } },
  ] },
  { group: 'Rust web', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [
    { label: 'Axum', detect: { cargo: ['axum'] } }, { label: 'Actix Web', detect: { cargo: ['actix-web'] } }, { label: 'Rocket', detect: { cargo: ['rocket'] } },
    { label: 'Poem', detect: { cargo: ['poem'] } }, { label: 'Leptos', targets: W, detect: { cargo: ['leptos'] } }, { label: 'Yew', targets: W, detect: { cargo: ['yew'] } },
    { label: 'Dioxus', targets: ['web', 'desktop', 'ios', 'android'], detect: { cargo: ['dioxus'] } },
  ] },
  { group: 'Other server ecosystems', category: 'frameworks', filter: 'backend', kind: 'framework', targets: SV, seeds: [{ label: 'Phoenix/Plug', aliases: ['Phoenix'] }, 'Vapor', 'Hummingbird', 'Drogon', 'Crow'] },
  { group: 'Cross-platform mobile', category: 'frameworks', filter: 'mobile', kind: 'framework', targets: MOB, seeds: [
    { label: 'React Native', aliases: ['RN'], related: ['react', 'expo'], detect: npm('react-native') },
    { label: 'Expo', related: ['react-native', 'eas'], targets: ['ios', 'android', 'web'], detect: npm('expo') },
    { label: 'Flutter', related: ['dart'], targets: ['ios', 'android', 'web', 'desktop'], detect: { pub: ['flutter'] } },
    { label: 'Ionic Framework', aliases: ['Ionic'], related: ['capacitor'], detect: npm('@ionic/core', '@ionic/react', '@ionic/angular', '@ionic/vue') },
    { label: 'Capacitor', related: ['ionic-framework'], detect: npm('@capacitor/core') }, { label: 'NativeScript', detect: npm('@nativescript/core') },
    { label: '.NET MAUI', id: 'dotnet-maui', aliases: ['MAUI'], targets: ['ios', 'android', 'desktop'] },
    { label: 'Kotlin Multiplatform', aliases: ['KMP'], related: ['kotlin'] }, { label: 'Compose Multiplatform', related: ['kotlin-multiplatform', 'jetpack-compose'], targets: ['ios', 'android', 'desktop', 'web'] },
  ] },
  { group: 'Apple-native UI', category: 'frameworks', filter: 'mobile', kind: 'ui_library', targets: ['ios'], seeds: [{ label: 'SwiftUI', related: ['swift'] }, { label: 'UIKit', related: ['swift'] }, { label: 'AppKit', targets: ['desktop'], related: ['swift'] }] },
  { group: 'Android-native UI', category: 'frameworks', filter: 'mobile', kind: 'ui_library', targets: ['android'], seeds: [{ label: 'Jetpack Compose', related: ['kotlin'] }, { label: 'Android Views/XML', aliases: ['Android Views'] }] },
  { group: 'Desktop shells/UI', category: 'frameworks', filter: 'desktop', kind: 'framework', targets: ['desktop'], seeds: [
    { label: 'Electron', detect: npm('electron') }, { label: 'Tauri', detect: { npm: ['@tauri-apps/api', '@tauri-apps/cli'], cargo: ['tauri'] } }, 'Qt',
    { label: 'PySide', detect: py('pyside6', 'pyside2') }, { label: 'PyQt', detect: py('pyqt6', 'pyqt5') }, 'Avalonia', 'WPF', 'WinUI', 'GTK',
  ] },
  { group: 'Interactive/3D/game projects', category: 'frameworks', filter: 'desktop', kind: 'engine', targets: ['desktop', 'web'], seeds: [
    { label: 'Godot', detect: files('project.godot') }, 'Unity', 'Unreal Engine', { label: 'Phaser', targets: W, detect: npm('phaser') },
    { label: 'Three.js', targets: W, detect: npm('three') }, { label: 'Babylon.js', targets: W, detect: npm('@babylonjs/core') },
  ] },
  { group: 'AI/data application libraries', category: 'frameworks', filter: 'ai_data', kind: 'library', targets: SV, seeds: [
    { label: 'LangChain', detect: { npm: ['langchain'], pypi: ['langchain'] } }, { label: 'LangGraph', detect: { npm: ['@langchain/langgraph'], pypi: ['langgraph'] } },
    { label: 'LlamaIndex', detect: { npm: ['llamaindex'], pypi: ['llama-index'] } }, { label: 'Haystack', detect: py('haystack-ai') },
    { label: 'Semantic Kernel', detect: py('semantic-kernel') }, { label: 'DSPy', detect: py('dspy', 'dspy-ai') }, { label: 'Transformers', detect: py('transformers') },
    { label: 'PyTorch', aliases: ['torch'], detect: py('torch') }, { label: 'TensorFlow', detect: py('tensorflow') }, { label: 'JAX', detect: py('jax') },
    { label: 'scikit-learn', aliases: ['sklearn'], detect: py('scikit-learn') },
  ] },
  { group: 'Data app/prototype UI', category: 'frameworks', filter: 'ai_data', kind: 'framework', targets: W, seeds: [
    { label: 'Streamlit', detect: py('streamlit') }, { label: 'Gradio', detect: py('gradio') }, { label: 'Dash', detect: py('dash') }, { label: 'Panel', detect: py('panel') },
    { label: 'Shiny', detect: py('shiny') },
  ] },
  { group: 'Custom/older project', category: 'frameworks', filter: 'web', kind: 'generic', targets: W, seeds: ['Other/custom framework', 'plain HTML/CSS/JavaScript'] },
  { group: 'Languages', category: 'languages', filter: 'tools', kind: 'language', targets: [], seeds: [
    { label: 'JavaScript', aliases: ['JS'] }, { label: 'TypeScript', aliases: ['TS'], detect: { npm: ['typescript'], files: ['tsconfig.json'] } }, { label: 'Python', detect: files('pyproject.toml') },
    { label: 'Dart', detect: files('pubspec.yaml') }, { label: 'Swift', detect: files('Package.swift') }, { label: 'Kotlin', detect: files('build.gradle.kts') }, 'Java',
    { label: 'C#', aliases: ['CSharp'], detect: files('*.csproj') }, { label: 'PHP', detect: files('composer.json') }, { label: 'Ruby', detect: files('Gemfile') },
    { label: 'Go', aliases: ['Golang'], detect: files('go.mod') }, { label: 'Rust', detect: files('Cargo.toml') }, { label: 'Elixir', detect: files('mix.exs') }, 'C',
    { label: 'C++', aliases: ['CPP'] }, 'R', 'SQL',
  ] },
  { group: 'Execution runtimes', category: 'runtimes', filter: 'tools', kind: 'runtime', targets: [], seeds: [
    { label: 'Node.js', aliases: ['Node', 'NodeJS'], detect: files('.nvmrc', '.node-version') }, { label: 'Bun', detect: files('bun.lockb', 'bun.lock', 'bunfig.toml') },
    { label: 'Deno', detect: files('deno.json', 'deno.jsonc') }, 'Python', 'JVM', { label: '.NET', id: 'dotnet', aliases: ['dotnet'] }, 'PHP', 'Ruby', 'BEAM', 'browser', 'native binary',
    'provider-specific runtime',
  ] },
  { group: 'Auth/identity', category: 'auth', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'Clerk', provider: 'clerk', detect: npm('@clerk/*') }, { label: 'Better Auth', detect: npm('better-auth') }, { label: 'Auth0', provider: 'auth0', detect: npm('@auth0/*', 'auth0') },
    { label: 'Supabase Auth', provider: 'supabase', related: ['supabase'] }, { label: 'Firebase Authentication', aliases: ['Firebase Auth'], provider: 'firebase' },
    { label: 'Auth.js', aliases: ['NextAuth', 'NextAuth.js'], detect: npm('next-auth', '@auth/core') }, { label: 'Keycloak', detect: npm('keycloak-js') },
    { label: 'Amazon Cognito', aliases: ['Cognito', 'AWS Cognito'], provider: 'aws' }, { label: 'WorkOS', provider: 'workos', detect: npm('@workos-inc/*') }, 'custom OIDC/SAML',
  ] },
  { group: 'Payments/subscriptions', category: 'payments', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'Clerk Billing', provider: 'clerk', related: ['clerk'] }, { label: 'Stripe', provider: 'stripe', detect: { npm: ['stripe', '@stripe/*'], pypi: ['stripe'] } },
    { label: 'Polar', detect: npm('@polar-sh/*') }, { label: 'Paddle', detect: npm('@paddle/*') }, { label: 'Lemon Squeezy', detect: npm('@lemonsqueezy/*') },
    { label: 'PayPal', detect: npm('@paypal/*') }, 'Adyen', { label: 'RevenueCat', detect: npm('react-native-purchases', '@revenuecat/*') },
    { label: 'Apple StoreKit', aliases: ['StoreKit'], provider: 'apple', targets: ['ios'] }, { label: 'Google Play Billing', provider: 'google', targets: ['android'] },
  ] },
  { group: 'Database engines', category: 'database_engines', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'PostgreSQL', aliases: ['Postgres'], detect: { npm: ['pg', 'postgres'], pypi: ['psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'] } },
    { label: 'MySQL', detect: npm('mysql2', 'mysql') }, 'MariaDB', { label: 'SQLite', aliases: ['better-sqlite3'], detect: npm('better-sqlite3', 'sqlite3') },
    { label: 'MongoDB', aliases: ['Mongo'], detect: { npm: ['mongodb', 'mongoose'], pypi: ['pymongo'] } }, { label: 'SQL Server', aliases: ['MSSQL'] },
    { label: 'Redis', aliases: ['Redis/Valkey'], detect: { npm: ['redis', 'ioredis'], pypi: ['redis'] } }, 'Valkey', { label: 'DynamoDB', provider: 'aws' },
    { label: 'ClickHouse', detect: npm('@clickhouse/client') }, { label: 'DuckDB', detect: { npm: ['duckdb'], pypi: ['duckdb'] } }, 'Cassandra',
  ] },
  { group: 'Database/backend platforms', category: 'database_platforms', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'Supabase', provider: 'supabase', detect: { npm: ['@supabase/supabase-js'], pypi: ['supabase'] } }, { label: 'Neon', detect: npm('@neondatabase/serverless') },
    { label: 'Prisma Postgres', provider: 'prisma', related: ['prisma-orm'] }, { label: 'Firebase/Firestore', aliases: ['Firestore'], provider: 'firebase', detect: npm('firebase', 'firebase-admin') },
    { label: 'Convex', detect: npm('convex') }, { label: 'Appwrite', detect: npm('appwrite', 'node-appwrite') }, { label: 'PocketBase', detect: npm('pocketbase') },
    { label: 'PlanetScale', detect: npm('@planetscale/database') }, { label: 'Turso', detect: npm('@libsql/client') }, { label: 'Cloudflare D1', provider: 'cloudflare' },
    { label: 'Amazon RDS', provider: 'aws' }, { label: 'InstaCloud', unresolvedIdentity: true, provenance: 'screenshot' },
  ] },
  { group: 'ORM/query/migrations', category: 'orm', filter: 'backend', kind: 'library', targets: [], seeds: [
    { label: 'Prisma ORM', aliases: ['Prisma'], provider: 'prisma', detect: npm('prisma', '@prisma/client') }, { label: 'Drizzle', aliases: ['Drizzle ORM'], detect: npm('drizzle-orm') },
    { label: 'TypeORM', detect: npm('typeorm') }, { label: 'Sequelize', detect: npm('sequelize') }, { label: 'Knex', detect: npm('knex') }, { label: 'Kysely', detect: npm('kysely') },
    { label: 'SQLAlchemy', detect: py('sqlalchemy') }, { label: 'Alembic', detect: py('alembic') }, 'Django ORM', 'Entity Framework Core', 'Hibernate', 'Eloquent', 'Active Record',
    { label: 'Diesel', detect: { cargo: ['diesel'] } }, { label: 'SQLx', detect: { cargo: ['sqlx'] } }, 'Flyway', 'Liquibase',
  ] },
  { group: 'Product/web analytics', category: 'analytics', filter: 'web', kind: 'service', targets: [], seeds: [
    { label: 'PostHog', provider: 'posthog', detect: { npm: ['posthog-js', 'posthog-node'], pypi: ['posthog'] } }, { label: 'Plausible', detect: npm('plausible-tracker') },
    { label: 'Vercel Analytics', provider: 'vercel', detect: npm('@vercel/analytics') }, { label: 'Google Analytics', aliases: ['GA4'], provider: 'google' },
    { label: 'Mixpanel', detect: npm('mixpanel', 'mixpanel-browser') }, { label: 'Amplitude', detect: npm('@amplitude/*') }, 'Matomo',
  ] },
  { group: 'Security/rate limits', category: 'security', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'Arcjet', detect: npm('@arcjet/*') }, { label: 'Upstash Ratelimit', provider: 'upstash', detect: npm('@upstash/ratelimit') },
    { label: 'Cloudflare security services', provider: 'cloudflare' }, { label: 'Snyk', detect: files('.snyk') }, { label: 'Semgrep', kind: 'tool', detect: files('.semgrep.yml') },
    { label: 'CodeQL', kind: 'tool', provider: 'github', detect: files('.github/workflows/codeql.yml') }, { label: 'Trivy', kind: 'tool' },
    { label: 'Gitleaks', kind: 'tool', detect: files('.gitleaks.toml') }, { label: 'Dependabot', provider: 'github', detect: files('.github/dependabot.yml') },
    { label: 'Renovate', detect: files('renovate.json') }, { label: 'custom security check', kind: 'generic' },
  ] },
  { group: 'UI/design/styling', category: 'ui', filter: 'web', kind: 'library', targets: W, seeds: [
    { label: 'Tailwind CSS', aliases: ['Tailwind', 'TailwindCSS'], detect: npm('tailwindcss') }, { label: 'shadcn/ui', aliases: ['shadcn'], detect: files('components.json') },
    { label: 'Radix UI', detect: npm('@radix-ui/*') }, { label: 'Material UI', aliases: ['MUI'], detect: npm('@mui/material') }, { label: 'Chakra UI', detect: npm('@chakra-ui/react') },
    { label: 'Mantine', detect: npm('@mantine/core') }, { label: 'Ant Design', aliases: ['antd'], detect: npm('antd') }, { label: 'Bootstrap', detect: npm('bootstrap') },
    { label: 'UnoCSS', detect: npm('unocss') }, 'CSS Modules', { label: 'Sass', aliases: ['SCSS'], detect: npm('sass') }, { label: 'styled-components', detect: npm('styled-components') },
    { label: 'Emotion', detect: npm('@emotion/react', '@emotion/styled') }, { label: 'Figma', kind: 'service' }, { label: 'Storybook', kind: 'tool', detect: npm('storybook', '@storybook/*') },
  ] },
  { group: 'App state/data access', category: 'state', filter: 'web', kind: 'library', targets: [], seeds: [
    { label: 'TanStack Query', aliases: ['React Query'], detect: npm('@tanstack/react-query', '@tanstack/query-core') }, { label: 'SWR', detect: npm('swr') },
    { label: 'Apollo Client', detect: npm('@apollo/client') }, { label: 'Relay', detect: npm('react-relay') }, { label: 'Zustand', detect: npm('zustand') },
    { label: 'Redux Toolkit', aliases: ['RTK'], detect: npm('@reduxjs/toolkit') }, { label: 'Pinia', detect: npm('pinia') }, { label: 'MobX', detect: npm('mobx') },
    { label: 'Riverpod', detect: { pub: ['flutter_riverpod', 'riverpod'] } }, { label: 'Bloc', detect: { pub: ['flutter_bloc', 'bloc'] } }, { label: 'Provider', detect: { pub: ['provider'] } },
  ] },
  { group: 'API protocols/specifications', category: 'api_protocols', filter: 'backend', kind: 'protocol', targets: [], seeds: [
    { label: 'REST/OpenAPI', aliases: ['OpenAPI', 'REST', 'Swagger'] }, { label: 'GraphQL', detect: npm('graphql') }, { label: 'gRPC/Protobuf', aliases: ['gRPC', 'Protobuf', 'Protocol Buffers'], detect: npm('@grpc/grpc-js') },
    'JSON Schema', 'AsyncAPI', { label: 'WebSocket', detect: npm('ws') }, { label: 'SSE', aliases: ['Server-Sent Events'] },
  ] },
  { group: 'Testing/evaluation', category: 'testing', filter: 'tools', kind: 'tool', targets: [], seeds: [
    { label: 'Vitest', detect: npm('vitest') }, { label: 'Jest', detect: npm('jest') }, { label: 'Testing Library', aliases: ['React Testing Library'], detect: npm('@testing-library/*') },
    { label: 'Playwright', aliases: ['Playwright Test'], detect: npm('@playwright/test', 'playwright') }, { label: 'Cypress', detect: npm('cypress') },
    { label: 'WebdriverIO', detect: npm('webdriverio', '@wdio/cli') }, { label: 'pytest', detect: py('pytest') }, 'unittest', 'JUnit', 'TestNG',
    { label: 'PHPUnit', detect: { composer: ['phpunit/phpunit'] } }, { label: 'Pest', detect: { composer: ['pestphp/pest'] } }, { label: 'RSpec', detect: { gem: ['rspec', 'rspec-rails'] } },
    'xUnit', 'NUnit', 'Go testing', 'cargo test', 'Flutter test', { label: 'XCTest', targets: ['ios'] }, { label: 'Swift Testing', targets: ['ios'] }, { label: 'Espresso', targets: ['android'] },
    { label: 'Appium', targets: MOB }, { label: 'Maestro', targets: MOB }, { label: 'Detox', targets: MOB, detect: npm('detox') }, 'k6', { label: 'Locust', detect: py('locust') },
    { label: 'custom eval command', kind: 'generic' },
  ] },
  { group: 'Error monitoring/observability', category: 'observability', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'Sentry', detect: { npm: ['@sentry/*'], pypi: ['sentry-sdk'] } }, { label: 'Bugsnag', detect: npm('@bugsnag/*') }, { label: 'Crashlytics', provider: 'firebase', targets: MOB },
    { label: 'OpenTelemetry', aliases: ['OTel'], kind: 'library', detect: { npm: ['@opentelemetry/*'], pypi: ['opentelemetry-api'] } }, { label: 'Prometheus', kind: 'tool' },
    { label: 'Grafana', kind: 'tool' }, { label: 'Datadog', detect: npm('dd-trace') }, { label: 'New Relic', detect: npm('newrelic') }, 'Elastic', { label: 'Axiom', detect: npm('@axiomhq/*') },
    'Better Stack',
  ] },
  { group: 'Hosting/cloud', category: 'hosting', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'Vercel', provider: 'vercel', detect: files('vercel.json') }, { label: 'Netlify', detect: files('netlify.toml') },
    { label: 'Cloudflare', provider: 'cloudflare', detect: files('wrangler.toml', 'wrangler.jsonc', 'wrangler.json') }, { label: 'Render', detect: files('render.yaml') },
    { label: 'Railway', detect: files('railway.json', 'railway.toml') }, { label: 'Fly.io', aliases: ['Fly'], detect: files('fly.toml') }, { label: 'AWS', aliases: ['Amazon Web Services'], provider: 'aws' },
    { label: 'Google Cloud', aliases: ['GCP'], provider: 'google' }, { label: 'Azure', provider: 'microsoft' }, 'DigitalOcean', 'Hetzner', { label: 'self-hosted/custom', kind: 'generic' },
  ] },
  { group: 'CI/review', category: 'ci_review', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'GitHub Actions', aliases: ['GHA'], provider: 'github', detect: files('.github/workflows/*.yml', '.github/workflows/*.yaml') },
    { label: 'GitLab CI', detect: files('.gitlab-ci.yml') }, { label: 'CircleCI', detect: files('.circleci/config.yml') }, { label: 'Buildkite', detect: files('.buildkite/pipeline.yml') },
    { label: 'Jenkins', detect: files('Jenkinsfile') }, { label: 'Azure Pipelines', provider: 'microsoft', detect: files('azure-pipelines.yml') }, 'CodeRabbit', 'Greptile',
    { label: 'Copilot review', provider: 'github' }, { label: 'human review', kind: 'generic' }, { label: 'custom check', kind: 'generic' },
  ] },
  { group: 'Mobile build/distribution', category: 'mobile_build', filter: 'mobile', kind: 'tool', targets: MOB, seeds: [
    { label: 'EAS Build/Submit/Update', id: 'eas', aliases: ['EAS', 'EAS Build', 'Expo Application Services'], kind: 'service', related: ['expo'], detect: files('eas.json') },
    { label: 'Xcode', provider: 'apple', targets: ['ios'] }, { label: 'Android Studio/SDK', aliases: ['Android SDK', 'Android Studio'], provider: 'google', targets: ['android'] },
    { label: 'Gradle', kind: 'build_tool', detect: files('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts') }, { label: 'CocoaPods', targets: ['ios'], detect: files('Podfile') },
    { label: 'Swift Package Manager', aliases: ['SwiftPM', 'SPM'], targets: ['ios'] }, { label: 'Fastlane', detect: files('fastlane/Fastfile') },
    { label: 'Xcode Cloud', kind: 'service', provider: 'apple', targets: ['ios'] }, { label: 'Bitrise', kind: 'service', detect: files('bitrise.yml') },
    { label: 'Codemagic', kind: 'service', detect: files('codemagic.yaml') }, { label: 'Firebase App Distribution', kind: 'service', provider: 'firebase' },
    { label: 'TestFlight', kind: 'service', provider: 'apple', targets: ['ios'] }, { label: 'Google Play Console', kind: 'service', provider: 'google', targets: ['android'] },
  ] },
  { group: 'Email/messaging/push', category: 'messaging', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'Resend', detect: npm('resend') }, { label: 'Postmark', detect: npm('postmark') }, { label: 'SendGrid', detect: npm('@sendgrid/mail') },
    { label: 'Amazon SES', aliases: ['SES'], provider: 'aws', detect: npm('@aws-sdk/client-ses', '@aws-sdk/client-sesv2') }, { label: 'Mailgun', detect: npm('mailgun.js') },
    { label: 'SMTP', kind: 'protocol', detect: npm('nodemailer') }, { label: 'Twilio', detect: npm('twilio') }, { label: 'Firebase Cloud Messaging', aliases: ['FCM'], provider: 'firebase' },
    { label: 'APNs', aliases: ['Apple Push Notification service'], provider: 'apple', targets: ['ios'] }, { label: 'OneSignal', detect: npm('react-onesignal', 'onesignal-node') },
    { label: 'Novu', detect: npm('@novu/*') },
  ] },
  { group: 'Storage/media', category: 'storage', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'Amazon S3', aliases: ['S3', 'AWS S3'], provider: 'aws', detect: npm('@aws-sdk/client-s3') }, { label: 'Google Cloud Storage', aliases: ['GCS'], provider: 'google', detect: npm('@google-cloud/storage') },
    { label: 'Azure Blob Storage', provider: 'microsoft', detect: npm('@azure/storage-blob') }, { label: 'Cloudflare R2', provider: 'cloudflare' },
    { label: 'Supabase Storage', provider: 'supabase', related: ['supabase'] }, { label: 'Firebase Storage', provider: 'firebase' }, { label: 'MinIO', detect: npm('minio') },
    { label: 'Cloudinary', detect: npm('cloudinary') }, { label: 'UploadThing', detect: npm('uploadthing') }, { label: 'Mux', detect: npm('@mux/*') },
  ] },
  { group: 'Search/vector retrieval', category: 'search', filter: 'ai_data', kind: 'service', targets: [], seeds: [
    { label: 'PostgreSQL full-text', aliases: ['Postgres full-text search'], kind: 'library', related: ['postgresql'] }, { label: 'pgvector', kind: 'library', related: ['postgresql'], detect: npm('pgvector') },
    { label: 'Elasticsearch', detect: npm('@elastic/elasticsearch') }, { label: 'OpenSearch', detect: npm('@opensearch-project/opensearch') }, { label: 'Meilisearch', detect: npm('meilisearch') },
    { label: 'Typesense', detect: npm('typesense') }, { label: 'Algolia', detect: npm('algoliasearch') }, { label: 'Qdrant', detect: { npm: ['@qdrant/js-client-rest'], pypi: ['qdrant-client'] } },
    { label: 'Pinecone', detect: npm('@pinecone-database/pinecone') }, { label: 'Weaviate', detect: npm('weaviate-client') }, { label: 'Chroma', aliases: ['ChromaDB'], detect: { npm: ['chromadb'], pypi: ['chromadb'] } },
    { label: 'Milvus', detect: { npm: ['@zilliz/milvus2-sdk-node'], pypi: ['pymilvus'] } },
  ] },
  { group: 'Background jobs/queues', category: 'jobs', filter: 'backend', kind: 'service', targets: [], seeds: [
    { label: 'BullMQ', kind: 'library', detect: npm('bullmq') }, { label: 'Celery', kind: 'library', detect: py('celery') }, { label: 'Sidekiq', kind: 'library', detect: { gem: ['sidekiq'] } },
    { label: 'Dramatiq', kind: 'library', detect: py('dramatiq') }, { label: 'Hangfire', kind: 'library' }, { label: 'Temporal', detect: npm('@temporalio/*') },
    { label: 'Inngest', detect: npm('inngest') }, { label: 'Trigger.dev', detect: npm('@trigger.dev/*') }, { label: 'RabbitMQ', detect: npm('amqplib') }, { label: 'Kafka', aliases: ['Apache Kafka'], detect: npm('kafkajs') },
    { label: 'Amazon SQS', aliases: ['SQS'], provider: 'aws', detect: npm('@aws-sdk/client-sqs') }, { label: 'Google Cloud Pub/Sub', aliases: ['Pub/Sub'], provider: 'google', detect: npm('@google-cloud/pubsub') },
  ] },
  { group: 'Cache/realtime', category: 'cache_realtime', filter: 'backend', kind: 'service', targets: [], seeds: [
    'Redis', 'Valkey', { label: 'Memcached', detect: npm('memjs') }, { label: 'Upstash', provider: 'upstash', detect: npm('@upstash/redis') }, { label: 'Pusher', detect: npm('pusher', 'pusher-js') },
    { label: 'Ably', detect: npm('ably') }, { label: 'Socket.IO', kind: 'library', detect: npm('socket.io', 'socket.io-client') }, { label: 'Supabase Realtime', provider: 'supabase', related: ['supabase'] },
    { label: 'Firebase Realtime Database', provider: 'firebase' },
  ] },
  { group: 'Content/CMS', category: 'cms', filter: 'web', kind: 'service', targets: [], seeds: [
    { label: 'Sanity', detect: npm('sanity', '@sanity/client') }, { label: 'Contentful', detect: npm('contentful') }, { label: 'Strapi', detect: npm('@strapi/strapi') },
    { label: 'Directus', detect: npm('@directus/sdk') }, { label: 'Payload', aliases: ['Payload CMS'], detect: npm('payload') }, 'WordPress', { label: 'Ghost', detect: npm('@tryghost/content-api') },
    { label: 'TinaCMS', detect: npm('tinacms') },
  ] },
  { group: 'Feature flags/experiments', category: 'flags', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'PostHog flags', provider: 'posthog', related: ['posthog'] }, { label: 'LaunchDarkly', detect: npm('launchdarkly-js-client-sdk', '@launchdarkly/*') },
    { label: 'Unleash', detect: npm('unleash-client') }, { label: 'GrowthBook', detect: npm('@growthbook/growthbook') }, { label: 'Statsig', detect: npm('statsig-js', '@statsig/*') },
    { label: 'Firebase Remote Config', provider: 'firebase' },
  ] },
  { group: 'Product work/feedback', category: 'product_work', filter: 'tools', kind: 'service', targets: [], seeds: [
    { label: 'GitHub Issues', provider: 'github' }, 'Linear', 'Jira', 'Notion', 'Intercom', 'Zendesk', 'Help Scout', 'Crisp', 'Slack', { label: 'email/manual notes', kind: 'generic' },
  ] },
  { group: 'Package/build/monorepo tools', category: 'package_build', filter: 'tools', kind: 'package_manager', targets: [], seeds: [
    { label: 'npm', detect: files('package-lock.json') }, { label: 'pnpm', detect: files('pnpm-lock.yaml', 'pnpm-workspace.yaml') }, { label: 'Yarn', detect: files('yarn.lock') },
    { label: 'pip', detect: files('requirements.txt') }, { label: 'uv', detect: files('uv.lock') }, { label: 'Poetry', detect: files('poetry.lock') },
    { label: 'Composer', detect: files('composer.lock') }, { label: 'Bundler', detect: files('Gemfile.lock') }, { label: 'Cargo', detect: files('Cargo.lock') },
    { label: 'Maven', kind: 'build_tool', detect: files('pom.xml') }, 'Gradle', 'NuGet', { label: 'Dart pub', aliases: ['pub'], detect: files('pubspec.lock') },
    { label: 'Vite', id: 'vite', aliases: ['ViteJS'], kind: 'build_tool', detect: { npm: ['vite'], files: ['vite.config.*'] } }, { label: 'webpack', kind: 'build_tool', detect: npm('webpack') },
    { label: 'Rspack', kind: 'build_tool', detect: npm('@rspack/core') }, { label: 'Parcel', kind: 'build_tool', detect: npm('parcel') }, { label: 'esbuild', kind: 'build_tool', detect: npm('esbuild') },
    { label: 'Rollup', kind: 'build_tool', detect: npm('rollup') }, { label: 'Turborepo', aliases: ['Turbo'], kind: 'build_tool', detect: { npm: ['turbo'], files: ['turbo.json'] } },
    { label: 'Nx', kind: 'build_tool', detect: { npm: ['nx'], files: ['nx.json'] } }, { label: 'Bazel', kind: 'build_tool', detect: files('MODULE.bazel', 'WORKSPACE.bazel') },
  ] },
  { group: 'Runtime/environment tools', category: 'environment', filter: 'tools', kind: 'tool', targets: [], seeds: [
    { label: 'Docker', detect: files('Dockerfile') }, { label: 'Docker Compose', detect: files('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml') },
    { label: 'Dev Containers', aliases: ['devcontainer'], detect: files('.devcontainer/devcontainer.json') }, { label: 'Kubernetes', aliases: ['k8s'] },
    { label: 'Terraform', detect: files('*.tf') }, { label: 'Pulumi', detect: files('Pulumi.yaml') }, { label: 'Ansible', detect: files('ansible.cfg') }, { label: 'custom approved image', kind: 'generic' },
  ] },
  { group: 'Model access', category: 'model_access', filter: 'ai_data', kind: 'service', targets: [], seeds: [
    'Selected provider API/SDK', 'approved private endpoint', 'eligible device/local endpoint', { label: 'custom inference adapter', kind: 'generic' },
  ] },
];

function buildCatalog(): StackEntry[] {
  const out = new Map<string, { -readonly [K in keyof StackEntry]: StackEntry[K] }>();
  for (const g of GROUPS) {
    for (const s of g.seeds) {
      const seed: Seed = typeof s === 'string' ? { label: s } : s;
      const id = seed.id ?? slug(seed.label);
      const have = out.get(id);
      if (have) {
        // The same label in a second table is the same identity, listed in one more category.
        if (!have.categories.includes(g.category)) have.categories = [...have.categories, g.category];
        if (seed.detect && !have.detect) have.detect = seed.detect;
        continue;
      }
      out.set(id, {
        id, label: seed.label, aliases: seed.aliases ?? [], kind: seed.kind ?? g.kind, categories: [g.category], group: g.group, filter: g.filter,
        targets: seed.targets ?? g.targets, provider: seed.provider ?? null, related: seed.related ?? [], presetOf: seed.presetOf ?? null, detect: seed.detect ?? null,
        unresolvedIdentity: seed.unresolvedIdentity === true, provenance: seed.provenance === 'screenshot' ? 'screenshot' : 'framework-tool-catalog.md',
      });
    }
  }
  return [...out.values()];
}

export const STACK_CATALOG: readonly StackEntry[] = buildCatalog();
const BY_ID = new Map(STACK_CATALOG.map((e) => [e.id, e]));
const BY_SPELLING = new Map<string, string>();
// Labels and aliases first, so an id can never shadow another entry's label.
for (const e of STACK_CATALOG) for (const n of [e.label, ...e.aliases]) if (!BY_SPELLING.has(normalizeStackLabel(n))) BY_SPELLING.set(normalizeStackLabel(n), e.id);
for (const e of STACK_CATALOG) if (!BY_SPELLING.has(normalizeStackLabel(e.id))) BY_SPELLING.set(normalizeStackLabel(e.id), e.id);

export const stackEntry = (id: string): StackEntry | undefined => BY_ID.get(id);
/** The canonical id a label or alias names, however it is cased or spaced. Null: no entry. */
export function resolveStackLabel(label: string): string | null {
  const n = normalizeStackLabel(label);
  return n === '' ? null : (BY_SPELLING.get(n) ?? null);
}

/** The section an entry is selected in: the section of its first category. */
export const sectionOf = (e: StackEntry): StackSection => stackCategory(e.categories[0]!).section;

// ---- search ------------------------------------------------------------------------------------------------------------

export interface StackSearchGroup {
  readonly group: string;
  readonly entries: readonly StackEntry[];
}

/** Grouped results for a query, within one section and optionally one filter. Prefix matches first, then substring matches; each group keeps catalog order. */
export function searchStack(query: string, opts: { section?: StackSection; filter?: StackFilter | null; limit?: number } = {}): StackSearchGroup[] {
  const q = normalizeStackLabel(query);
  const limit = opts.limit ?? 40;
  const scored: { e: StackEntry; score: number; order: number }[] = [];
  STACK_CATALOG.forEach((e, order) => {
    if (opts.section && !e.categories.some((c) => stackCategory(c).section === opts.section)) return;
    if (opts.filter && e.filter !== opts.filter) return;
    if (q === '') { scored.push({ e, score: 2, order }); return; }
    const names = [e.label, ...e.aliases].map(normalizeStackLabel);
    const score = names.some((n) => n === q) ? 0 : names.some((n) => n.startsWith(q)) ? 1 : names.some((n) => n.includes(q)) ? 2 : -1;
    if (score >= 0) scored.push({ e, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  const groups = new Map<string, StackEntry[]>();
  for (const { e } of scored.slice(0, limit)) {
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }
  return [...groups.entries()].map(([group, entries]) => ({ group, entries }));
}

// ---- readiness --------------------------------------------------------------------------------------------------------

/** One verifier fact behind a tested axis: what ran, on which platform, at which version, and where that is written down. */
export interface PilotEvidence {
  readonly entryId: string;
  readonly suiteId: 'feedback-board';
  readonly suiteVersion: '0.1';
  readonly platform: 'web';
  readonly actions: readonly ('install' | 'build' | 'test')[];
  /** The file the version is pinned in. */
  readonly path: 'services/verifier/suites/feedback-board/manifest.json' | 'examples/feedback-board-starter/package.json';
  /** The key in that file. */
  readonly pin: string;
  readonly version: string;
}

const SUITE = 'services/verifier/suites/feedback-board/manifest.json' as const;
const STARTER = 'examples/feedback-board-starter/package.json' as const;
/**
 * What the pilot verifier suite actually runs (services/verifier/src/run.ts): `pnpm install` and `pnpm build` (tsc and vite build) on the Feedback Board starter, its
 * Express and SQLite server started with `pnpm start`, and the suite's Vitest and Playwright (Chromium) checks against it. Nothing else in the catalog has been run here.
 */
const PILOT_PINS: readonly Omit<PilotEvidence, 'suiteId' | 'suiteVersion' | 'platform'>[] = [
  { entryId: 'nodejs', pin: 'node', version: '24.x', path: SUITE, actions: ['install', 'build', 'test'] },
  { entryId: 'pnpm', pin: 'pnpm', version: '9.12.2', path: SUITE, actions: ['install', 'build', 'test'] },
  { entryId: 'vitest', pin: 'vitest', version: '5.1.0', path: SUITE, actions: ['test'] },
  { entryId: 'playwright', pin: '@playwright/test', version: '1.65.0', path: SUITE, actions: ['test'] },
  { entryId: 'react', pin: 'react', version: '19.3.1', path: STARTER, actions: ['build', 'test'] },
  { entryId: 'vite', pin: 'vite', version: '8.3.6', path: STARTER, actions: ['build'] },
  { entryId: 'typescript', pin: 'typescript', version: '5.9.3', path: STARTER, actions: ['build'] },
  { entryId: 'express', pin: 'express', version: '5.3.0', path: STARTER, actions: ['test'] },
  { entryId: 'sqlite', pin: 'better-sqlite3', version: '13.0.3', path: STARTER, actions: ['test'] },
];
export const PILOT_EVIDENCE: readonly PilotEvidence[] = PILOT_PINS.map((e) => ({ ...e, suiteId: 'feedback-board', suiteVersion: '0.1', platform: 'web' }));

export const READINESS_AXES = ['knowledge', 'skills', 'connector', 'auth', 'tested'] as const;
export type ReadinessAxisId = (typeof READINESS_AXES)[number];
export const READINESS_AXIS_LABELS: Readonly<Record<ReadinessAxisId, string>> = {
  knowledge: 'Profile knowledge', skills: 'Skills', connector: 'Connector', auth: 'Authentication', tested: 'Tested execution',
};
export type ReadinessState = 'not_linked' | 'none_reviewed' | 'not_applicable' | 'none_available' | 'not_connected' | 'not_tested' | 'tested' | 'unknown';

export interface ReadinessAxis {
  readonly axis: ReadinessAxisId;
  readonly state: ReadinessState;
  readonly label: string;
  readonly explanation: string;
  readonly evidence?: readonly PilotEvidence[];
}

const UNKNOWN = 'Unknown · not reviewed';

/**
 * The readiness of one selection, axis by axis. Never one badge. Every axis that nothing has checked says so: no reviewed knowledge or skills exist yet, no connector
 * exists, selecting creates no credential, and tested means only that the pilot suite ran it on web at the version it pins.
 */
export function readinessOf(item: StackItem): ReadinessAxis[] {
  if (item.kind === 'custom') {
    return READINESS_AXES.map((axis) => ({ axis, state: 'unknown', label: UNKNOWN, explanation: 'A custom entry is recorded as you named it. Nothing about it has been reviewed, linked, connected or run.' }));
  }
  const e = stackEntry(item.entryId);
  if (!e) return READINESS_AXES.map((axis) => ({ axis, state: 'unknown', label: UNKNOWN, explanation: 'This entry is not in the catalog this build carries.' }));
  const service = sectionOf(e) === 'services';
  const evidence = PILOT_EVIDENCE.filter((p) => p.entryId === e.id);
  const out: ReadinessAxis[] = [
    { axis: 'knowledge', state: 'not_linked', label: 'Not linked', explanation: 'No version-matched documentation is linked to this entry yet, so a worker gets only what you recorded here.' },
    { axis: 'skills', state: 'none_reviewed', label: 'No reviewed skills', explanation: 'Skills appear here only once a reviewed, pinned binding exists. None does yet.' },
    service
      ? { axis: 'connector', state: 'none_available', label: 'No connector', explanation: 'No connector, MCP server or API connection exists for this entry. Setting one up will be a separate action.' }
      : { axis: 'connector', state: 'not_applicable', label: 'Not applicable', explanation: 'A framework or library is recorded as context; it needs no connection.' },
    service
      ? { axis: 'auth', state: 'not_connected', label: 'Not connected', explanation: 'Selecting records your stack only. It creates no credential, makes no request and grants no access.' }
      : { axis: 'auth', state: 'not_applicable', label: 'Not applicable', explanation: 'Nothing to authenticate.' },
    evidence.length > 0
      ? {
        axis: 'tested', state: 'tested', label: 'Run by the pilot suite (web)', evidence,
        explanation: `Run on web by the Feedback Board verifier suite (feedback-board 0.1): ${[...new Set(evidence.flatMap((x) => x.actions))].join(', ')}, at ${evidence.map((x) => x.version).join(', ')}. Other versions, platforms and actions are not tested.`,
      }
      : { axis: 'tested', state: 'not_tested', label: 'Not tested', explanation: e.kind === 'preset' ? `A preset of ${(e.presetOf ?? []).map((id) => stackEntry(id)?.label ?? id).join(' and ')}: see each for what has run.` : 'Nothing in this workspace has run it. Selecting it is not a tested integration.' },
  ];
  return out;
}

export interface NativeCapabilities {
  readonly ios: boolean;
  readonly android: boolean;
}
/** No runner reports a native build capability in this build. */
export const NO_NATIVE: NativeCapabilities = { ios: false, android: false };

export interface TargetGate {
  readonly target: StackTarget;
  readonly state: 'passed' | 'not_run' | 'incomplete' | 'not_assessed';
  readonly label: string;
  readonly explanation: string;
}

const NATIVE_NOTE = 'Shared web checks passing does not verify native behaviour. Planning and code work can continue; this gate stays incomplete.';

/**
 * The verification gate of each target. iOS and Android are separate from web: without an eligible native build host they stay incomplete, whatever the web checks say.
 * A host that reports a native toolchain still has no native test here, so its gate is not assessed, never passed.
 */
export function targetGates(targets: readonly StackTarget[], opts: { webChecks: 'passed' | 'not_run'; native: NativeCapabilities }): TargetGate[] {
  return STACK_TARGETS.filter((t) => targets.includes(t)).map((target): TargetGate => {
    if (target === 'web' || target === 'server') {
      const name = target === 'web' ? 'Web' : 'Server';
      return opts.webChecks === 'passed'
        ? { target, state: 'passed', label: `${name} checks passed`, explanation: `The ${name.toLowerCase()} checks passed. They say nothing about other targets.` }
        : { target, state: 'not_run', label: `${name} checks not linked`, explanation: `No ${name.toLowerCase()} verification result is linked to this component yet.` };
    }
    if (target === 'ios') {
      return opts.native.ios
        ? { target, state: 'not_assessed', label: 'iOS build not assessed', explanation: `A runner reports a macOS host, but no iOS build or test has run here. ${NATIVE_NOTE}` }
        : { target, state: 'incomplete', label: 'iOS runner required', explanation: `No runner reports an eligible macOS host with Xcode, so iOS build, test and preview cannot run. ${NATIVE_NOTE}` };
    }
    if (target === 'android') {
      return opts.native.android
        ? { target, state: 'not_assessed', label: 'Android build not assessed', explanation: `A runner reports an Android toolchain, but no Android build or test has run here. ${NATIVE_NOTE}` }
        : { target, state: 'incomplete', label: 'Android build not assessed', explanation: `No runner reports an Android SDK, emulator or test device, so Android build, test and preview cannot run. ${NATIVE_NOTE}` };
    }
    return { target, state: 'incomplete', label: 'Desktop build not assessed', explanation: `No runner reports a desktop build environment. ${NATIVE_NOTE}` };
  });
}

// ---- selections -------------------------------------------------------------------------------------------------------

const Printable = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, 'no control characters');
const Text = (max: number) => Printable(max).trim().min(1);
/** A component's path: `.` for the repository root, or a relative path with no `.` or `..` segment. */
export const STACK_COMPONENT_PATH_MAX = 120;
export const StackComponentPathSchema = z.string().max(STACK_COMPONENT_PATH_MAX).regex(/^(?:\.|[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_@-][A-Za-z0-9_.@-]*)*)$/, 'expected . or a relative path');
const VersionSchema = Printable(40);
export const StackEvidenceSchema = z.strictObject({ path: Printable(200).min(1), detail: Printable(160) });
export type StackEvidence = z.infer<typeof StackEvidenceSchema>;
export const CanonicalSourceSchema = z.string().max(300).regex(/^https:\/\/[^\s<>"']+$/, 'expected an https URL');

export const StackCatalogItemSchema = z.strictObject({
  kind: z.literal('catalog'),
  entryId: z.string().min(1).max(64),
  version: VersionSchema.nullable(),
  origin: z.enum(['declared', 'detected']),
  evidence: StackEvidenceSchema.nullable(),
});
export const StackCustomItemSchema = z.strictObject({ kind: z.literal('custom'), label: Text(80), canonicalSource: CanonicalSourceSchema.nullable() });
export const StackItemSchema = z.discriminatedUnion('kind', [StackCatalogItemSchema, StackCustomItemSchema]);
export type StackItem = z.infer<typeof StackItemSchema>;

export const STACK_MAX_ITEMS = 20;
export const STACK_MAX_COMPONENTS = 30;
export const StackCategoryStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not_decided') }),
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({ state: z.literal('selected'), items: z.array(StackItemSchema).min(1).max(STACK_MAX_ITEMS) }),
]);
export type StackCategoryState = z.infer<typeof StackCategoryStateSchema>;

const NOT_DECIDED: StackCategoryState = { state: 'not_decided' };
const allNotDecided = (): Record<StackCategoryId, StackCategoryState> => Object.fromEntries(STACK_CATEGORY_IDS.map((id) => [id, { ...NOT_DECIDED }])) as Record<StackCategoryId, StackCategoryState>;

export const StackComponentSchema = z.strictObject({
  path: StackComponentPathSchema,
  name: Text(80),
  targets: z.array(z.enum(STACK_TARGETS)).max(STACK_TARGETS.length),
  /** Every category, explicitly. A category this build does not know yet reads as Not decided. */
  categories: z.partialRecord(StackCategoryIdSchema, StackCategoryStateSchema).transform((c) => ({ ...allNotDecided(), ...c }) as Record<StackCategoryId, StackCategoryState>),
});
export type StackComponent = z.infer<typeof StackComponentSchema>;

export const StackCommandProposalSchema = z.strictObject({
  componentPath: StackComponentPathSchema,
  kind: z.enum(['build', 'test']),
  script: Printable(60).min(1),
  /** How it would be run. Never run by this build. */
  command: Printable(100).min(1),
  /** The script's text as the manifest states it, as data. */
  body: Printable(200),
  evidencePath: Printable(200).min(1),
});
export type StackCommandProposal = z.infer<typeof StackCommandProposalSchema>;

export const STACK_SKIP_REASONS = ['symlink', 'too_large', 'unreadable', 'unsafe_path', 'limit'] as const;
export const StackDetectedItemSchema = z.strictObject({
  detectionId: z.string().min(1).max(200),
  componentPath: StackComponentPathSchema,
  entryId: z.string().min(1).max(64),
  version: VersionSchema.nullable(),
  evidence: StackEvidenceSchema,
});
export type StackDetectedItem = z.infer<typeof StackDetectedItemSchema>;
export const StackSkipSchema = z.strictObject({ path: Printable(200).min(1), reason: z.enum(STACK_SKIP_REASONS) });

export const StackDetectionRecordSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  detectedAt: z.iso.datetime(),
  runnerId: z.string().min(1).max(200),
  items: z.array(StackDetectedItemSchema.extend({ state: z.enum(['proposed', 'confirmed', 'dismissed']) })).max(400),
  commands: z.array(StackCommandProposalSchema).max(40),
  skipped: z.array(StackSkipSchema).max(200),
});
export type StackDetectionRecord = z.infer<typeof StackDetectionRecordSchema>;

export const StackDocumentSchema = z.strictObject({
  components: z.array(StackComponentSchema).max(STACK_MAX_COMPONENTS),
  detection: StackDetectionRecordSchema.nullable(),
});
export type StackDocument = z.infer<typeof StackDocumentSchema>;

export const emptyStack = (): StackDocument => ({ components: [], detection: null });

const AddItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('catalog'), entryId: z.string().min(1).max(64), version: VersionSchema.nullable().optional() }),
  z.strictObject({ kind: z.literal('custom'), label: Text(80), canonicalSource: CanonicalSourceSchema.nullable().optional() }),
]);

/** What an owner can change. Each is metadata only: none authenticates, installs, requests, spends or touches a repository. */
export const StackActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('component.upsert'), path: StackComponentPathSchema, name: Text(80), targets: z.array(z.enum(STACK_TARGETS)).max(STACK_TARGETS.length) }),
  z.strictObject({ kind: z.literal('component.remove'), path: StackComponentPathSchema }),
  z.strictObject({ kind: z.literal('category.set'), path: StackComponentPathSchema, category: StackCategoryIdSchema, state: z.enum(['not_decided', 'none']) }),
  z.strictObject({ kind: z.literal('item.add'), path: StackComponentPathSchema, category: StackCategoryIdSchema, item: AddItemSchema }),
  z.strictObject({ kind: z.literal('item.remove'), path: StackComponentPathSchema, category: StackCategoryIdSchema, key: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal('detection.confirm'), detectionId: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('detection.dismiss'), detectionId: z.string().min(1).max(200) }),
]);
export type StackAction = z.input<typeof StackActionSchema>;

export const STACK_ACTION_CODES = [
  'stack_component_not_found', 'stack_entry_unknown', 'stack_entry_wrong_category', 'stack_item_exists', 'stack_item_not_found', 'stack_detection_not_found',
  'stack_detection_settled', 'stack_limit',
] as const;
export type StackActionCode = (typeof STACK_ACTION_CODES)[number];
export type StackActionResult = { readonly ok: true; readonly doc: StackDocument } | { readonly ok: false; readonly code: StackActionCode; readonly message: string };

/** A selection's key within its category: the canonical id, or the custom label's spelling. */
export const stackItemKey = (item: StackItem): string => (item.kind === 'catalog' ? item.entryId : `custom:${normalizeStackLabel(item.label)}`);

const itemsOf = (s: StackCategoryState): StackItem[] => (s.state === 'selected' ? [...s.items] : []);
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Applies one owner action. Pure: the same document and action always give the same result. */
export function applyStackAction(doc: StackDocument, action: StackAction): StackActionResult {
  const fail = (code: StackActionCode, message: string): StackActionResult => ({ ok: false, code, message });
  const components = doc.components.map((c) => ({ ...c, categories: { ...c.categories } }));
  const find = (path: string) => components.find((c) => c.path === path);
  const done = (next: StackComponent[], detection = doc.detection): StackActionResult => ({ ok: true, doc: { components: [...next].sort(byPath), detection } });
  const add = (c: StackComponent, category: StackCategoryId, item: StackItem): StackActionCode | null => {
    const items = itemsOf(c.categories[category]);
    if (items.some((i) => stackItemKey(i) === stackItemKey(item))) return 'stack_item_exists';
    if (items.length >= STACK_MAX_ITEMS) return 'stack_limit';
    c.categories[category] = { state: 'selected', items: [...items, item] };
    return null;
  };
  switch (action.kind) {
    case 'component.upsert': {
      const targets = STACK_TARGETS.filter((t) => action.targets.includes(t));
      const have = find(action.path);
      if (have) {
        have.name = action.name.trim();
        have.targets = targets;
        return done(components);
      }
      if (components.length >= STACK_MAX_COMPONENTS) return fail('stack_limit', `at most ${STACK_MAX_COMPONENTS} components`);
      return done([...components, { path: action.path, name: action.name.trim(), targets, categories: allNotDecided() }]);
    }
    case 'component.remove': {
      if (!find(action.path)) return fail('stack_component_not_found', 'no component at that path');
      return done(components.filter((c) => c.path !== action.path));
    }
    case 'category.set': {
      const c = find(action.path);
      if (!c) return fail('stack_component_not_found', 'no component at that path');
      c.categories[action.category] = { state: action.state };
      return done(components);
    }
    case 'item.add': {
      const c = find(action.path);
      if (!c) return fail('stack_component_not_found', 'no component at that path');
      let item: StackItem;
      if (action.item.kind === 'catalog') {
        const e = stackEntry(action.item.entryId);
        if (!e) return fail('stack_entry_unknown', 'no such catalog entry');
        if (!e.categories.includes(action.category)) return fail('stack_entry_wrong_category', `${e.label} is not listed under ${stackCategory(action.category).label}`);
        item = { kind: 'catalog', entryId: e.id, version: action.item.version ?? null, origin: 'declared', evidence: null };
      } else {
        item = { kind: 'custom', label: action.item.label.trim(), canonicalSource: action.item.canonicalSource ?? null };
      }
      const code = add(c, action.category, item);
      return code ? fail(code, code === 'stack_item_exists' ? 'already selected' : `at most ${STACK_MAX_ITEMS} selections in a category`) : done(components);
    }
    case 'item.remove': {
      const c = find(action.path);
      if (!c) return fail('stack_component_not_found', 'no component at that path');
      const items = itemsOf(c.categories[action.category]);
      const rest = items.filter((i) => stackItemKey(i) !== action.key);
      if (rest.length === items.length) return fail('stack_item_not_found', 'no such selection');
      // Removing a selection records nothing about the provider: no data is deleted and no credential is revoked. The last one removed leaves the category undecided.
      c.categories[action.category] = rest.length > 0 ? { state: 'selected', items: rest } : { ...NOT_DECIDED };
      return done(components);
    }
    case 'detection.confirm':
    case 'detection.dismiss': {
      const det = doc.detection;
      const found = det?.items.find((i) => i.detectionId === action.detectionId);
      if (!det || !found) return fail('stack_detection_not_found', 'no such detection');
      if (found.state !== 'proposed') return fail('stack_detection_settled', 'this detection was already settled');
      const detection: StackDetectionRecord = { ...det, items: det.items.map((i) => (i.detectionId === found.detectionId ? { ...i, state: action.kind === 'detection.confirm' ? 'confirmed' : 'dismissed' } : i)) };
      if (action.kind === 'detection.dismiss') return done(components, detection);
      const e = stackEntry(found.entryId);
      if (!e) return fail('stack_entry_unknown', 'no such catalog entry');
      let c = find(found.componentPath);
      if (!c) {
        if (components.length >= STACK_MAX_COMPONENTS) return fail('stack_limit', `at most ${STACK_MAX_COMPONENTS} components`);
        c = { path: found.componentPath, name: found.componentPath === '.' ? 'Repository root' : found.componentPath, targets: [], categories: allNotDecided() };
        components.push(c);
      }
      const code = add(c, e.categories[0]!, { kind: 'catalog', entryId: e.id, version: found.version, origin: 'detected', evidence: found.evidence });
      if (code === 'stack_limit') return fail(code, `at most ${STACK_MAX_ITEMS} selections in a category`);
      return done(components, detection);
    }
  }
}

// ---- the Project Brain's view of it ------------------------------------------------------------------------------------

export interface StackSourceDraft {
  readonly sourceId: string;
  readonly title: string;
  readonly sections: BrainSection[];
}

const itemText = (i: StackItem): string => {
  if (i.kind === 'custom') return `${i.label} (custom, not reviewed${i.canonicalSource ? `; source ${i.canonicalSource}` : ''})`;
  const e = stackEntry(i.entryId);
  const tested = PILOT_EVIDENCE.some((p) => p.entryId === i.entryId);
  return `${e?.label ?? i.entryId}${i.version ? ` ${i.version}` : ''} (${i.origin === 'detected' && i.evidence ? `detected in ${i.evidence.path}` : 'declared'}; ${tested ? 'run on web by the pilot verifier suite' : 'not tested'})`;
};

/**
 * One Brain source per component: its targets, and every category the owner decided (a selection, or None). Undecided categories state nothing. The text describes the
 * target project's stack as recorded; it is context for a worker, quoted as data, and never an instruction, a grant or a command.
 */
export function stackBrainSources(doc: StackDocument): StackSourceDraft[] {
  return [...doc.components].sort(byPath).map((c) => {
    const gates = targetGates(c.targets, { webChecks: 'not_run', native: NO_NATIVE }).filter((g) => g.state === 'incomplete');
    const sections: BrainSection[] = [{
      anchor: `stack/${c.path}`, heading: c.name, key: `stack:${c.path}`,
      text: `Component ${c.name} at ${c.path}. Targets: ${c.targets.map((t) => STACK_TARGET_LABELS[t]).join(', ') || 'none declared'}.${gates.length > 0 ? ` ${gates.map((g) => `${STACK_TARGET_LABELS[g.target]} gate incomplete: ${g.label}.`).join(' ')}` : ''} These are the recorded stack choices for this path, not tested integrations unless stated.`,
    }];
    for (const cat of STACK_CATEGORIES) {
      const s = c.categories[cat.id];
      if (s.state === 'not_decided') continue;
      sections.push({
        anchor: `stack/${c.path}/${cat.id}`, heading: `${cat.label} (${c.path})`, key: `stack:${c.path}:${cat.id}`,
        text: s.state === 'none' ? `None: no ${cat.label} is used in this component.` : `Selected: ${s.items.map(itemText).join('; ')}.`,
      });
    }
    return { sourceId: `stack:${c.path}`, title: `Stack: ${c.name} (${c.path})`, sections };
  });
}

/** The component path a Brain key about the stack names, or null when the key is not about the stack. */
export function stackKeyPath(key: string): string | null {
  const m = /^stack:([^:]+)(?::|$)/.exec(key);
  return m ? m[1]! : null;
}

/** Whether a component at `componentPath` is in scope for a task allowed to change `paths`. The repository root is in scope for every task. */
export function stackInScope(componentPath: string, paths: readonly string[]): boolean {
  if (componentPath === '.') return true;
  return paths.some((raw) => {
    const p = raw.replace(/\/+$/, '');
    return p === '' || p === '.' || p === componentPath || p.startsWith(`${componentPath}/`) || componentPath.startsWith(`${p}/`);
  });
}

// ---- static detection -------------------------------------------------------------------------------------------------

/** Manifests whose text is read (as data) for dependency names. */
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pubspec.yaml']);
/** Trees that are vendored, generated or VCS metadata: never read. */
const IGNORED_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', '.venv', 'venv', 'target', 'Pods', '.next', '.nuxt', '.svelte-kit', 'bower_components', '__pycache__']);
export const STACK_DETECTION_MAX_BYTES = 256 * 1024;
export const STACK_DETECTION_MAX_DEPTH = 6;
export const STACK_DETECTION_MAX_FILES = 300;

const globRe = (g: string): RegExp => new RegExp(`(?:^|/)${g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
const FILE_SIGNATURES: readonly { readonly re: RegExp; readonly glob: string; readonly entryId: string; readonly lockfile: boolean }[] = STACK_CATALOG.flatMap((e) =>
  (e.detect?.files ?? []).map((glob) => ({ re: globRe(glob), glob, entryId: e.id, lockfile: /(?:lock|\.lockb)(?:\.|$)|lock\.json$|lock\.yaml$/.test(glob) })),
);

const safeRepoPath = (path: string): boolean =>
  path.length > 0 && path.length <= 200 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/** Whether detection reads this path: a named manifest, lockfile or config file, not inside a vendored or generated tree, at a safe relative path. */
export function isStackDetectionPath(path: string): boolean {
  if (!safeRepoPath(path)) return false;
  const segs = path.split('/');
  if (segs.length > STACK_DETECTION_MAX_DEPTH) return false;
  if (segs.slice(0, -1).some((s) => IGNORED_DIRS.has(s))) return false;
  return MANIFESTS.has(segs.at(-1)!) || FILE_SIGNATURES.some((f) => f.re.test(path));
}
/** Whether detection needs a path's text, as opposed to its presence. */
export const isStackManifestPath = (path: string): boolean => isStackDetectionPath(path) && MANIFESTS.has(path.split('/').at(-1)!);

export interface StackDetectionFile {
  readonly path: string;
  /** The file's text, for a manifest. Absent for a file whose presence is the signature. */
  readonly content?: string;
}
export interface StackDetectionResult {
  readonly items: StackDetectedItem[];
  readonly commands: StackCommandProposal[];
  readonly skipped: { path: string; reason: (typeof STACK_SKIP_REASONS)[number] }[];
}

const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');

interface Index { readonly npm: Map<string, string[]>; readonly npmScopes: Map<string, string[]>; readonly pypi: Map<string, string[]>; readonly go: [string, string][]; readonly cargo: Map<string, string[]>; readonly gem: Map<string, string[]>; readonly composer: Map<string, string[]>; readonly pub: Map<string, string[]> }
function buildIndex(): Index {
  const idx: Index = { npm: new Map(), npmScopes: new Map(), pypi: new Map(), go: [], cargo: new Map(), gem: new Map(), composer: new Map(), pub: new Map() };
  const put = (m: Map<string, string[]>, k: string, id: string): void => { m.set(k, [...(m.get(k) ?? []), id]); };
  for (const e of STACK_CATALOG) {
    for (const n of e.detect?.npm ?? []) n.endsWith('/*') ? put(idx.npmScopes, n.slice(0, -1), e.id) : put(idx.npm, n, e.id);
    for (const n of e.detect?.pypi ?? []) put(idx.pypi, n, e.id);
    for (const n of e.detect?.go ?? []) idx.go.push([n, e.id]);
    for (const n of e.detect?.cargo ?? []) put(idx.cargo, n, e.id);
    for (const n of e.detect?.gem ?? []) put(idx.gem, n, e.id);
    for (const n of e.detect?.composer ?? []) put(idx.composer, n, e.id);
    for (const n of e.detect?.pub ?? []) put(idx.pub, n, e.id);
  }
  return idx;
}
const INDEX = buildIndex();
const npmIds = (name: string): string[] => [...(INDEX.npm.get(name) ?? []), ...[...INDEX.npmScopes.entries()].filter(([scope]) => name.startsWith(scope)).flatMap(([, ids]) => ids)];
const pyName = (s: string): string => s.toLowerCase().replace(/_/g, '-');

const PMS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/**
 * Static detection over files read from a commit. Pure: it parses manifests as data, notes the presence of lockfiles and config files, and proposes build and test
 * commands from package.json scripts without running anything. Every detected entry carries the path and the text it was read from.
 */
export function detectStack(input: readonly StackDetectionFile[]): StackDetectionResult {
  const found = new Map<string, StackDetectedItem>();
  const commands: StackCommandProposal[] = [];
  const skipped: StackDetectionResult['skipped'] = [];
  const files = [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const present = new Set(files.map((f) => f.path));
  const hit = (componentPath: string, entryId: string, version: string | null, evidence: StackEvidence): void => {
    const detectionId = `det:${componentPath}:${entryId}`;
    if (found.has(detectionId) || !stackEntry(entryId) || found.size >= 400) return;
    found.set(detectionId, { detectionId, componentPath, entryId, version: version === null ? null : clean(version, 40) || null, evidence: { path: evidence.path, detail: clean(evidence.detail, 160) } });
  };
  let read = 0;
  // Manifests first, so an entry's evidence is the line that names it and its version; then the files whose presence is the signature.
  for (const f of files) {
    if (!isStackDetectionPath(f.path)) { skipped.push({ path: clean(f.path, 200) || '?', reason: 'unsafe_path' }); continue; }
    const name = f.path.split('/').at(-1)!;
    if (!MANIFESTS.has(name)) continue;
    const comp = dirOf(f.path);
    if (!StackComponentPathSchema.safeParse(comp).success) { skipped.push({ path: f.path, reason: 'unsafe_path' }); continue; }
    if (f.content === undefined) continue;
    if (f.content.length > STACK_DETECTION_MAX_BYTES) { skipped.push({ path: f.path, reason: 'too_large' }); continue; }
    if (++read > STACK_DETECTION_MAX_FILES) { skipped.push({ path: f.path, reason: 'limit' }); continue; }
    try {
      parseManifest(name, f.path, comp, f.content, hit, commands, present);
    } catch {
      skipped.push({ path: f.path, reason: 'unreadable' });
    }
  }
  for (const f of files) {
    if (!isStackDetectionPath(f.path)) continue;
    // The component is the directory above the matched tail.
    for (const sig of FILE_SIGNATURES) {
      const m = sig.re.exec(f.path);
      if (!m) continue;
      const head = f.path.slice(0, m.index);
      const comp = head === '' ? '.' : head;
      if (!StackComponentPathSchema.safeParse(comp).success) continue;
      hit(comp, sig.entryId, null, { path: f.path, detail: sig.lockfile ? 'lockfile' : 'config file' });
    }
  }
  const items = [...found.values()].sort((a, b) => (a.componentPath < b.componentPath ? -1 : a.componentPath > b.componentPath ? 1 : a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return { items, commands: commands.slice(0, 40), skipped: skipped.slice(0, 200) };
}

type Hit = (componentPath: string, entryId: string, version: string | null, evidence: StackEvidence) => void;

function parseManifest(name: string, path: string, comp: string, text: string, hit: Hit, commands: StackCommandProposal[], present: ReadonlySet<string>): void {
  const record = (o: unknown): Record<string, unknown> => (o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {});
  if (name === 'package.json' || name === 'composer.json') {
    const json = record(JSON.parse(text));
    if (name === 'composer.json') {
      for (const field of ['require', 'require-dev']) {
        for (const [dep, v] of Object.entries(record(json[field]))) for (const id of INDEX.composer.get(dep) ?? []) hit(comp, id, typeof v === 'string' ? v : null, { path, detail: `${field}.${dep} ${typeof v === 'string' ? v : ''}` });
      }
      return;
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [dep, v] of Object.entries(record(json[field]))) {
        const version = typeof v === 'string' ? v : null;
        for (const id of npmIds(dep)) hit(comp, id, version, { path, detail: `${field}.${dep} ${version ?? ''}` });
      }
    }
    let pm: string | null = null;
    if (typeof json['packageManager'] === 'string') {
      const m = /^([a-z]+)@([0-9][^+\s]*)/.exec(json['packageManager']);
      if (m && PMS.has(m[1]!)) {
        pm = m[1]!;
        hit(comp, m[1] === 'bun' ? 'bun' : m[1]!, m[2]!, { path, detail: `packageManager ${clean(json['packageManager'], 60)}` });
      }
    }
    const node = record(json['engines'])['node'];
    if (typeof node === 'string') hit(comp, 'nodejs', node, { path, detail: `engines.node ${node}` });
    // A lockfile beside this manifest or at the root names the package manager the scripts would run with; without one, npm.
    const beside = (file: string): boolean => present.has(comp === '.' ? file : `${comp}/${file}`) || present.has(file);
    pm ??= beside('pnpm-lock.yaml') ? 'pnpm' : beside('yarn.lock') ? 'yarn' : beside('bun.lockb') || beside('bun.lock') ? 'bun' : 'npm';
    const scripts = record(json['scripts']);
    for (const kind of ['build', 'test'] as const) {
      const body = scripts[kind];
      if (typeof body !== 'string') continue;
      commands.push({ componentPath: comp, kind, script: kind, command: `${pm} run ${kind}`, body: clean(body, 200), evidencePath: path });
    }
    return;
  }
  if (name === 'requirements.txt') {
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=!~][^;]*)?/.exec(line);
      if (!m) continue;
      for (const id of INDEX.pypi.get(pyName(m[1]!)) ?? []) hit(comp, id, m[2]?.trim() ?? null, { path, detail: clean(line, 160) });
    }
    return;
  }
  if (name === 'pyproject.toml') {
    const seen = new Set<string>();
    const req = (dep: string, version: string | null, detail: string): void => {
      const n = pyName(dep);
      if (seen.has(n)) return;
      seen.add(n);
      for (const id of INDEX.pypi.get(n) ?? []) hit(comp, id, version, { path, detail });
    };
    for (const m of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=!~][^"';]*)?[^"']*["']/g)) req(m[1]!, m[2]?.trim() ?? null, clean(m[0], 160));
    for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["']([^"']*)["']/gm)) req(m[1]!, m[2]!, clean(m[0], 160));
    return;
  }
  if (name === 'go.mod') {
    for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gm)) {
      for (const [prefix, id] of INDEX.go) if (m[1] === prefix || m[1]!.startsWith(`${prefix}/`)) hit(comp, id, m[2]!, { path, detail: `${m[1]} ${m[2]}` });
    }
    return;
  }
  if (name === 'Cargo.toml') {
    let deps = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[')) { deps = /dependencies\]$/.test(line); continue; }
      if (!deps) continue;
      const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*?version\s*=\s*"([^"]*)")/.exec(line);
      if (!m) continue;
      for (const id of INDEX.cargo.get(m[1]!) ?? []) hit(comp, id, m[2] ?? m[3] ?? null, { path, detail: clean(line, 160) });
    }
    return;
  }
  if (name === 'Gemfile') {
    for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) for (const id of INDEX.gem.get(m[1]!) ?? []) hit(comp, id, m[2] ?? null, { path, detail: clean(m[0], 160) });
    return;
  }
  if (name === 'pubspec.yaml') {
    let deps = false;
    for (const raw of text.split('\n')) {
      if (/^\S/.test(raw)) { deps = /^(dev_)?dependencies:\s*$/.test(raw); continue; }
      if (!deps) continue;
      const m = /^ {2}([a-z0-9_]+):\s*(.*)$/.exec(raw);
      if (!m) continue;
      for (const id of INDEX.pub.get(m[1]!) ?? []) hit(comp, id, m[2]!.trim() || null, { path, detail: clean(raw, 160) });
    }
  }
}
