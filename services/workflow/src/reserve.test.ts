import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { formatMicros, toMicros, type Scheduler } from './index.ts';
import {
  CAPS, PROJECT, RUN, TENANT, countRows, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, testClock, type TestDb,
} from '../test/helpers.ts';

let t: TestDb;
let s: Scheduler;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db, { limitUsd: 0.3 });
  s = makeScheduler(t.db, testClock());
});

const seedReservation = (over: Record<string, unknown>) =>
  t.db.insert(schema.budgetReservations).values({ tenantId: TENANT, projectId: PROJECT, reservationId: 'res_x', runId: RUN, amountUsd: '0.1', state: 'reserved', ...over });

describe('budget reservations', () => {
  it('decimal amounts do not drift', () => {
    expect(toMicros(0.1) + toMicros(0.2)).toBe(toMicros(0.3));
    expect(formatMicros(1_250_000)).toBe('1.250000');
    expect(formatMicros(0)).toBe('0.000000');
  });

  it('a limit that exactly fits is allowed, one more micro is not', async () => {
    await seedTask(t.db, specFor('a', { maxCostUsd: 0.1 }));
    await seedTask(t.db, specFor('b', { maxCostUsd: 0.2 }));
    await seedTask(t.db, specFor('c', { maxCostUsd: 0.000001 }));
    const caps = { maxConcurrentTotal: 5 };
    expect(await s.claimNext(runner('r1'), caps)).not.toBeNull();
    expect(await s.claimNext(runner('r2'), caps)).not.toBeNull();
    expect(await s.tryClaim(runner('r3'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 'c', reason: 'budget:exceeds_limit' }] });
    expect(await countRows(t.db, 'budget_reservations')).toBe(2);
  });

  it('an outstanding reservation of unknown amount denies new reservations', async () => {
    await seedReservation({ amountUsd: null });
    await seedTask(t.db, specFor('a', { maxCostUsd: 0.01 }));
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'a', reason: 'budget:unknown_cost' }] });
  });

  it('released reservations stop counting; settled ones keep counting', async () => {
    await seedReservation({ amountUsd: '0.3', state: 'released' });
    await seedTask(t.db, specFor('a', { maxCostUsd: 0.3 }));
    expect(await s.claimNext(runner('r1'), CAPS)).not.toBeNull();
    await t.db.insert(schema.budgetReservations).values({ tenantId: TENANT, projectId: PROJECT, reservationId: 'res_y', runId: RUN, amountUsd: '0', state: 'settled' });
    await seedTask(t.db, specFor('b', { maxCostUsd: 0.01 }));
    expect(await s.tryClaim(runner('r2'), { maxConcurrentTotal: 5 })).toMatchObject({ ok: false, skipped: [{ taskId: 'b', reason: 'budget:exceeds_limit' }] });
  });

  it('a malformed run budget denies', async () => {
    for (const limitUsd of ['lots', -1, null]) {
      await resetDb(t.db, { limitUsd });
      await seedTask(t.db, specFor('a', { maxCostUsd: 0.01 }));
      expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'a', reason: 'budget:missing_limit' }] });
    }
  });
});
