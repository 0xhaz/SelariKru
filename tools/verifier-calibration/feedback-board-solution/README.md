Private verifier calibration. Never provide to workers. Not evidence of platform generation.

# Feedback Board calibration solution

A minimal correct implementation of the Feedback Board contract (`examples/feedback-board-starter/contract/`), kept only to prove that the protected verifier in `services/verifier` can pass 8/8 on a correct app and fails 8/8 on the bare starter.

`overlay/` is applied on top of a temporary copy of the starter by `../run.ts`. It must never be copied into the starter, a worker bundle, a prompt, a worktree handed to a worker or any published artifact. `../guard.test.ts` fails if any of its files or its header text appear in the starter tree.
