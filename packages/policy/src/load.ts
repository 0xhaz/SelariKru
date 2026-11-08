import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePolicy, type Policy } from './policy.ts';

/** The only I/O in this package: reads and validates a policy file. */
export function loadPolicyFile(path: string): Policy {
  return parsePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadDefaultPolicy(): Policy {
  return loadPolicyFile(fileURLToPath(new URL('../../../policies/default.json', import.meta.url)));
}
