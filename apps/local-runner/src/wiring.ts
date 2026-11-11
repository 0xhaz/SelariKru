import { parseCodingWorkers, type CodingWorkers } from '@selarikru/domain';
import type { RunnerHarnessReport } from '@selarikru/protocol';
import { DEFAULT_HARNESSES, type RunnerHarness } from './attempt.ts';
import { harnessReportFor } from './loop.ts';

/**
 * What the runner binary launches, from its environment. `SELARIKRU_CODING_WORKERS` absent or empty is `off`, the hackathon build: no model harness is registered or
 * probed, and only the no-model apply worker is reported. Anything but `off` or `claude_code` stops startup.
 */
export function runnerWiring(env: Readonly<Record<string, string | undefined>>, probe: () => Promise<readonly RunnerHarnessReport[]>): {
  readonly codingWorkers: CodingWorkers;
  readonly harnesses: readonly RunnerHarness[];
  readonly harnessReport: () => Promise<readonly RunnerHarnessReport[]>;
} {
  const codingWorkers = parseCodingWorkers(env['SELARIKRU_CODING_WORKERS']);
  if (codingWorkers === null) throw new Error('SELARIKRU_CODING_WORKERS must be "off" or "claude_code"');
  return { codingWorkers, harnesses: codingWorkers === 'off' ? [] : DEFAULT_HARNESSES, harnessReport: harnessReportFor(codingWorkers, probe) };
}
