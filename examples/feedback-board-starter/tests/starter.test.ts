import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

const root = resolve(__dirname, '..');
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('starter.health', () => {
  it('GET /health returns 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe('starter.baseline', () => {
  it('has no feedback API: /api/feedback returns 404 for every method', async () => {
    for (const method of ['GET', 'POST', 'PATCH']) {
      const res = await fetch(`${base}/api/feedback`, { method });
      expect(res.status, method).toBe(404);
    }
    expect((await fetch(`${base}/api/feedback/fb_001`, { method: 'PATCH' })).status).toBe(404);
  });

  it('has no feedback implementation or UI in server, src or migrations', () => {
    const impl = [...files(join(root, 'server')), ...files(join(root, 'src')), ...files(join(root, 'migrations'))]
      .filter((f) => !f.endsWith('.gitkeep'));
    for (const f of impl) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\/api\/feedback|create\s+table\s+(if\s+not\s+exists\s+)?feedback|<form|<select|<input|<textarea/i);
    }
    expect(readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql'))).toEqual([]);
  });
});
