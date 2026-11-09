import { describe, expect, it } from 'vitest';
import { RecordStoreUnavailableError, validRecordOf, type LatestAppliedRecord } from './verification-record.ts';

const SHA = 'a'.repeat(40);
const trusted = { checkManifestSha256: 'b'.repeat(64), verifierSha256: 'c'.repeat(64) };
const latest: LatestAppliedRecord = { recordId: 'rec', sha256: 'd'.repeat(64), checkRunIds: ['cr1'], live: true };
const bar = (get: () => Promise<Uint8Array | null>) => ({ artifacts: { get }, trusted: () => trusted });

describe('validRecordOf', () => {
  it('reads an absent or corrupt record as not valid: those are facts about the record', async () => {
    await expect(validRecordOf(latest, SHA, bar(async () => null))).resolves.toBeNull();
    const corrupt = Object.assign(new Error('hash mismatch'), { name: 'ArtifactIntegrityError' });
    await expect(validRecordOf(latest, SHA, bar(async () => { throw corrupt; }))).resolves.toBeNull();
  });

  it('a failed read is not a verdict: it rejects instead of reading as not valid', async () => {
    const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    await expect(validRecordOf(latest, SHA, bar(async () => { throw eio; }))).rejects.toBeInstanceOf(RecordStoreUnavailableError);
  });
});
