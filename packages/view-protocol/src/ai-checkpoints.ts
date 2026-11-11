/**
 * H12: AI step checkpoints as a data source carries them. The shape and the storage split are the domain's (ai-checkpoint.ts): a data source stores only what
 * `checkpointStorage` says belongs on the server, and refuses anything else before it is sent. Restricted, secret or locked checkpoints stay in the browser.
 */
export { AiCheckpointSchema, checkpointStorage, type AiCheckpoint } from '@selarikru/domain';
