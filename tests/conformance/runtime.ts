import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptHandle, RuntimeAdapter, SandboxHandle, SandboxSpec, TaskBundle } from '@selarikru/protocol';

export interface RuntimeUnderTest {
  readonly runtime: RuntimeAdapter;
  /** A fresh, valid spec for a new attempt. Each call returns a distinct task and attempt identity. */
  newSpec(): Promise<SandboxSpec>;
  /** A command that keeps running until it is stopped. */
  longRunning(handle: SandboxHandle): TaskBundle;
  /** Removes anything the factory made outside the runtime (temp directories), and any sandbox left behind. */
  cleanup(handles: readonly SandboxHandle[]): Promise<void>;
}

/** Upper bound for a stop acknowledgement, in ms. The adapter's own timeouts must keep it under this. */
const STOP_BOUND_MS = 90_000;

/**
 * RuntimeAdapter conformance: create, start, stop acknowledgment, inspect and destroy. Every runtime adapter (local sbx,
 * the later cloud adapter) must pass this unchanged. `make` is called once per test.
 */
export function runtimeConformance(name: string, make: () => Promise<RuntimeUnderTest>): void {
  describe(`RuntimeAdapter conformance: ${name}`, () => {
    const handles: SandboxHandle[] = [];
    let current: RuntimeUnderTest | null = null;

    afterEach(async () => {
      if (current) await current.cleanup(handles.splice(0));
      current = null;
    });

    async function setup(): Promise<RuntimeUnderTest> {
      current = await make();
      return current;
    }
    async function created(rt: RuntimeUnderTest): Promise<SandboxHandle> {
      const h = await rt.runtime.create(await rt.newSpec());
      handles.push(h);
      return h;
    }

    it('capabilities: states its location and that it never falls back to the host', async () => {
      const rt = await setup();
      const caps = await rt.runtime.capabilities();
      expect(['local', 'cloud']).toContain(caps.location);
      expect(caps.hostFallback).toBe(false);
      expect(['confirmed', 'requested_only']).toContain(caps.stopAcknowledgement);
    });

    it('create returns a handle that inspect finds; a stopped sandbox is normal', async () => {
      const rt = await setup();
      const h = await created(rt);
      expect(h.sandboxId.length).toBeGreaterThan(0);
      const snap = await rt.runtime.inspect(h);
      expect(snap.exists).toBe(true);
      expect(['running', 'stopped']).toContain(snap.state);
      expect(snap.sandboxId).toBe(h.sandboxId);
    });

    it('start returns an attempt handle bound to the sandbox, and inspect sees it running', async () => {
      const rt = await setup();
      const h = await created(rt);
      const a: AttemptHandle = await rt.runtime.start(h, rt.longRunning(h));
      expect(a.sandboxId).toBe(h.sandboxId);
      expect(typeof a.startedAt).toBe('string');
      expect(a.exited).toBeInstanceOf(Promise);
      expect((await rt.runtime.inspect(h)).state).toBe('running');
      await rt.runtime.stop(a);
    });

    it('stop acknowledges within a bound, confirms termination, and the run ends', async () => {
      const rt = await setup();
      const h = await created(rt);
      const a = await rt.runtime.start(h, rt.longRunning(h));
      const t0 = Date.now();
      const ack = await rt.runtime.stop(a);
      expect(Date.now() - t0).toBeLessThan(STOP_BOUND_MS);
      expect(ack.attemptId).toBe(a.attemptId);
      expect(ack.sandboxId).toBe(h.sandboxId);
      expect(ack.status).toBe('stopped');
      expect(ack.terminationConfirmed).toBe(true);
      await expect(Promise.race([a.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not end')), 10_000))])).resolves.toBeTruthy();
      expect((await rt.runtime.inspect(h)).state).not.toBe('unknown');
    });

    it('stop twice is safe', async () => {
      const rt = await setup();
      const h = await created(rt);
      const a = await rt.runtime.start(h, rt.longRunning(h));
      await rt.runtime.stop(a);
      const again = await rt.runtime.stop(a);
      expect(again.status).toBe('stopped');
    });

    it('destroy removes the sandbox, and destroying again succeeds', async () => {
      const rt = await setup();
      const h = await created(rt);
      await rt.runtime.destroy(h);
      const snap = await rt.runtime.inspect(h);
      expect(snap.exists).toBe(false);
      expect(snap.state).toBe('absent');
      await expect(rt.runtime.destroy(h)).resolves.toBeUndefined();
    });

    it('destroy while an attempt is running ends the attempt', async () => {
      const rt = await setup();
      const h = await created(rt);
      const a = await rt.runtime.start(h, rt.longRunning(h));
      await rt.runtime.destroy(h);
      await expect(Promise.race([a.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not end')), 15_000))])).resolves.toBeTruthy();
      expect((await rt.runtime.inspect(h)).exists).toBe(false);
    });

    it('creating again for the same task reconciles the earlier sandbox instead of leaving two workers', async () => {
      const rt = await setup();
      const first = await created(rt);
      const retrySpec: SandboxSpec = { ...(await rt.newSpec()), taskId: first.taskId };
      const second = await rt.runtime.create(retrySpec);
      handles.push(second);
      expect((await rt.runtime.inspect(first)).exists).toBe(first.sandboxId === second.sandboxId);
      expect((await rt.runtime.inspect(second)).exists).toBe(true);
    });
  });
}
