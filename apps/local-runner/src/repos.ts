import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A runner reports a project only when its path is the root of a git repository. Anything else is a path it could never build from. */
export async function gitBackedProjects(repos: Readonly<Record<string, string>>, log: (line: string) => void): Promise<string[]> {
  const projects: string[] = [];
  for (const [project, path] of Object.entries(repos)) {
    // `.git` is a directory in a clone and a file in a linked worktree.
    if (await stat(join(path, '.git')).then(() => true, () => false)) projects.push(project);
    else log(`project ${project}: ${path} is not a git repository, so it is not reported as a checkout. Check the --repo path.`);
  }
  return projects;
}
