import { spawnSync } from 'node:child_process';

/** Number of live (non-zombie) processes whose real or effective uid is `uid`. */
export function candidateProcessCount(uid: number): number {
  const ps = spawnSync('ps', ['-eo', 'ruid=,euid=,stat='], { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error(`ps failed (status ${ps.status}); cannot verify that candidate processes are gone`);
  return ps.stdout.split('\n').filter((l) => {
    const [ruid, euid, stat] = l.trim().split(/\s+/);
    return (Number(ruid) === uid || Number(euid) === uid) && !(stat ?? '').startsWith('Z');
  }).length;
}

/** Human-readable listing of live candidate processes, for failure messages. */
export function candidateProcessListing(uid: number): string {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,ruid=,euid=,stat=,args='], { encoding: 'utf8' });
  return ps.stdout.split('\n').filter((l) => { const [, , r, e, st] = l.trim().split(/\s+/); return (Number(r) === uid || Number(e) === uid) && !(st ?? '').startsWith('Z'); }).map((l) => l.trim().slice(0, 160)).join(' | ');
}

/**
 * Kills every process of the candidate uid. A helper that runs AS that uid calls kill(-1, SIGKILL), which signals
 * everything the uid can signal in one syscall (a fork-hopping daemon cannot slip between a listing and a kill). The
 * helper's exit status is checked and the loop repeats until no candidate process is left; if some remain after the
 * bound this throws, and callers must fail closed.
 */
export function killCandidateProcesses(uid: number, gid: number, attempts = 40): void {
  let last = 'no attempt made';
  for (let i = 0; i < attempts; i++) {
    const helper = spawnSync(process.execPath, ['-e', 'try { process.kill(-1, "SIGKILL"); } catch (e) { process.exit(e.code === "ESRCH" ? 0 : 3); }'], { uid, gid, timeout: 10_000, stdio: 'ignore' });
    if (helper.status !== 0 && helper.signal === null) last = `kill helper exited with status ${helper.status}`;
    else if (helper.signal !== null && helper.signal !== 'SIGKILL') last = `kill helper ended by ${helper.signal}`;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    const left = candidateProcessCount(uid);
    if (left === 0) return;
    last = `${left} candidate process(es) still alive`;
  }
  throw new Error(`could not stop all candidate processes after ${attempts} attempts (${last})`);
}
