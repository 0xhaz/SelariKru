import { afterEach, describe, expect, it } from 'vitest';
import { api, AppUnderTest, SEED_ITEMS } from '../lib/harness.ts';

/** Every independent case gets a brand new process on a brand new SQLite file. */
const started: AppUnderTest[] = [];
async function fresh(seed: boolean) {
  const app = new AppUnderTest({ seed });
  started.push(app);
  await app.start();
  return { app, c: api(app) };
}
afterEach(async () => {
  await Promise.all(started.splice(0).map((a) => a.stop()));
});

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const counts = (all: number, open: number, planned: number, done: number) => ({ all, open, planned, done });
function expectError(res: { status: number; body: any }, status: number) {
  expect(res.status).toBe(status);
  expect(typeof res.body?.error?.code).toBe('string');
  expect(res.body.error.code.length).toBeGreaterThan(0);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
}

describe('feedback API', () => {
  it('FB-01 create: valid titles return 201 and are persisted; title trimmed; missing description is ""', async () => {
    for (const title of ['abc', '🌱🌱🌱', 'a'.repeat(120)]) {
      const { c } = await fresh(false);
      const res = await c.create({ title });
      expect(res.status, `title length ${[...title].length}`).toBe(201);
      const item = res.body.item;
      expect(item.title).toBe(title);
      expect(item.description).toBe('');
      expect(item.status).toBe('open');
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.createdAt).toMatch(ISO_UTC);
      const list = await c.list();
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([item]);
      expect(list.body.counts).toEqual(counts(1, 1, 0, 0));
    }
    const { c } = await fresh(false);
    const trimmed = await c.create({ title: '  \t abc  \n', description: '   keep me   ' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.item.title).toBe('abc');
    expect(trimmed.body.item.description).toBe('keep me');
    expect((await c.list()).body.items[0].title).toBe('abc');
    const maxDescription = 'd'.repeat(1000);
    const { c: c2 } = await fresh(false);
    const big = await c2.create({ title: 'Valid title', description: maxDescription });
    expect(big.status).toBe(201);
    expect(big.body.item.description).toBe(maxDescription);
  });

  it('FB-01 astral boundary: 120 astral characters accepted, 121 rejected (code points, not UTF-16 units)', async () => {
    const ok = await fresh(false);
    const title = '🌱'.repeat(120);
    const res = await ok.c.create({ title });
    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe(title);
    expect((await ok.c.list()).body.items[0].title).toBe(title);

    const bad = await fresh(false);
    const rejected = await bad.c.create({ title: '🌱'.repeat(121) });
    expectError(rejected, 400);
    expect((await bad.c.list()).body.counts.all).toBe(0);
  });

  it('FB-01 counting: code points after trimming, separate title and description limits, no normalization', async () => {
    const accepted: Array<[string, { title: string; description?: string }, { title: string; description: string }]> = [
      ['120 characters surrounded by whitespace', { title: `  ${'a'.repeat(120)}  ` }, { title: 'a'.repeat(120), description: '' }],
      ['120 code points made of combining marks', { title: 'e\u0301'.repeat(60) }, { title: 'e\u0301'.repeat(60), description: '' }],
      ['title kept in decomposed form (no NFC)', { title: 'e\u0301bc', description: 'Cafe\u0301' }, { title: 'e\u0301bc', description: 'Cafe\u0301' }],
      ['1,000 astral code points in the description', { title: 'Valid title', description: '🌱'.repeat(1000) }, { title: 'Valid title', description: '🌱'.repeat(1000) }],
      ['1,000 characters surrounded by whitespace in the description', { title: 'Valid title', description: ` ${'d'.repeat(1000)} ` }, { title: 'Valid title', description: 'd'.repeat(1000) }],
    ];
    for (const [label, payload, expected] of accepted) {
      const { c } = await fresh(false);
      const res = await c.create(payload);
      expect(res.status, label).toBe(201);
      expect(res.body.item.title, label).toBe(expected.title);
      expect(res.body.item.description, label).toBe(expected.description);
      const stored = (await c.list()).body.items[0];
      expect(stored.title, label).toBe(expected.title);
      expect(stored.description, label).toBe(expected.description);
    }
  });

  it('FB-02 counting: trimming happens before counting; code points, not UTF-16 units or graphemes', async () => {
    const rejected: Array<[string, { title: string; description?: string }]> = [
      ['two characters surrounded by whitespace', { title: '  ab  ' }],
      ['two astral code points (four UTF-16 units)', { title: '🌱🌱' }],
      ['122 code points forming 61 graphemes', { title: 'e\u0301'.repeat(61) }],
      ['1,001 astral code points in the description', { title: 'Valid title', description: '🌱'.repeat(1001) }],
      ['1,002 code points forming 501 graphemes in the description', { title: 'Valid title', description: 'e\u0301'.repeat(501) }],
    ];
    for (const [label, payload] of rejected) {
      const { c } = await fresh(true);
      expectError(await c.create(payload), 400);
      expect((await c.list()).body.counts, label).toEqual(counts(3, 1, 1, 1));
    }
  });

  it('FB-02 reject: invalid input returns 400 and leaves the row count unchanged', async () => {
    const creates: Array<[string, unknown]> = [
      ['whitespace-only title', { title: '   ' }],
      ['two-character title', { title: 'ab' }],
      ['121-character title', { title: 'a'.repeat(121) }],
      ['1,001-character description', { title: 'Valid title', description: 'a'.repeat(1001) }],
      ['numeric title', { title: 123 }],
      ['missing title', { description: 'no title here' }],
      ['numeric description', { title: 'Valid title', description: 123 }],
    ];
    for (const [label, payload] of creates) {
      const { c } = await fresh(true);
      expectError(await c.create(payload), 400);
      const after = await c.list();
      expect(after.body.counts, label).toEqual(counts(3, 1, 1, 1));
      expect(after.body.items, label).toHaveLength(3);
    }
    const { c } = await fresh(true);
    expectError(await c.patch('fb_001', { status: 'archived' }), 400);
    expectError(await c.patch('fb_001', { status: 5 }), 400);
    const after = await c.list();
    expect(after.body.counts).toEqual(counts(3, 1, 1, 1));
    expect(after.body.items.find((i: any) => i.id === 'fb_001').status).toBe('open');
  });

  it('FB-03 order: seeded list is newest first with descending-id tie-break', async () => {
    const { c } = await fresh(true);
    const res = await c.list();
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual(['fb_003', 'fb_002', 'fb_001']);
    expect(res.body.items).toEqual([...SEED_ITEMS].reverse());
    const created = await c.create({ title: 'Brand new' });
    expect(created.status).toBe(201);
    const after = await c.list();
    expect(after.body.items.map((i: any) => i.id)).toEqual([created.body.item.id, 'fb_003', 'fb_002', 'fb_001']);
  });

  it('FB-04 status: new item is open; PATCH persists each status; missing id is 404', async () => {
    const { c } = await fresh(true);
    const created = await c.create({ title: 'Status walk' });
    expect(created.status).toBe(201);
    expect(created.body.item.status).toBe('open');
    const id = created.body.item.id;
    for (const status of ['planned', 'done', 'open']) {
      const res = await c.patch(id, { status });
      expect(res.status).toBe(200);
      expect(res.body.item.status).toBe(status);
      expect(res.body.item.id).toBe(id);
      const list = await c.list();
      expect(list.body.items.find((i: any) => i.id === id).status).toBe(status);
    }
    expectError(await c.patch('fb_missing', { status: 'done' }), 404);
    expect((await c.list()).body.counts.all).toBe(4);
  });

  it('FB-05 filter: counts stay global under each filter and update after changes; unknown status is 400', async () => {
    const { c } = await fresh(true);
    const expectFilters = async (c0: ReturnType<typeof api>, expected: ReturnType<typeof counts>) => {
      for (const filter of ['all', 'open', 'planned', 'done'] as const) {
        const res = await c0.list(filter);
        expect(res.status, filter).toBe(200);
        expect(res.body.counts, filter).toEqual(expected);
        expect(res.body.items, filter).toHaveLength(expected[filter]);
        if (filter !== 'all') for (const i of res.body.items) expect(i.status).toBe(filter);
      }
      expect((await c0.list()).body.items).toHaveLength(expected.all); // no query means all
    };
    await expectFilters(c, counts(3, 1, 1, 1));
    expect((await c.create({ title: 'Another open' })).status).toBe(201);
    await expectFilters(c, counts(4, 2, 1, 1));
    expect((await c.patch('fb_001', { status: 'done' })).status).toBe(200);
    await expectFilters(c, counts(4, 1, 1, 2));
    expectError(await c.list('archived'), 400);
  });

  it('FB-06 persist: saved items and statuses survive an API process restart on the same database', async () => {
    const { app, c } = await fresh(false);
    const a = await c.create({ title: 'Survives restart', description: 'kept' });
    const b = await c.create({ title: 'Second item' });
    expect((await c.patch(b.body.item.id, { status: 'planned' })).status).toBe(200);
    const before = await c.list();
    await app.restart();
    const after = await c.list();
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    expect(after.body.items.map((i: any) => i.id).sort()).toEqual([a.body.item.id, b.body.item.id].sort());
    expect(after.body.items.find((i: any) => i.id === b.body.item.id).status).toBe('planned');
    // a second restart still sees the same data (and writes after restart work)
    await app.restart();
    expect((await c.create({ title: 'After restart' })).status).toBe(201);
    expect((await c.list()).body.counts.all).toBe(3);
  });

  it('FB-06 persist: seeding only fills an empty database, so a restart with the seed file set does not duplicate or revert rows', async () => {
    const { app, c } = await fresh(true);
    expect((await c.patch('fb_001', { status: 'done' })).status).toBe(200);
    await app.restart();
    const res = await c.list();
    expect(res.body.counts).toEqual(counts(3, 0, 1, 2));
    expect(res.body.items.find((i: any) => i.id === 'fb_001').status).toBe('done');
  });

  it('FB-07 states: an empty database lists no items and zero counts', async () => {
    const { c } = await fresh(false);
    const res = await c.list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], counts: counts(0, 0, 0, 0) });
  });

  it('FB-08 a11y and safety: script-like text is stored and returned verbatim as data', async () => {
    const { c } = await fresh(false);
    const title = '<script>window.demoCanary=1</script>';
    const res = await c.create({ title, description: '<img src=x onerror="window.demoCanary=1">' });
    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe(title);
    expect(res.body.item.description).toBe('<img src=x onerror="window.demoCanary=1">');
    expect((await c.list()).body.items[0].title).toBe(title);
  });
});
