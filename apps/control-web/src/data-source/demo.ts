import type { EngineeringDataSource } from '@selarikru/view-protocol';

/**
 * The only way the mock data source reaches the app. It is a dynamic import behind `import.meta.env.DEV`: in a production build Vite
 * replaces the flag with `false`, the branch is dead and the import is never emitted, so the mock and its fixtures are not in the bundle.
 * `data-source-mock` is a devDependency for the same reason. Do not import it anywhere else.
 */
export async function loadDemoDataSource(): Promise<EngineeringDataSource | null> {
  if (!import.meta.env.DEV) return null;
  const { createDemoDataSource } = await import('@selarikru/data-source-mock');
  return createDemoDataSource();
}
