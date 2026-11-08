#!/usr/bin/env bash
# Builds the pinned verifier image and verifies a candidate inside it.
#   docker-verify.sh <candidate-dir> <results-json-path>
# The candidate is mounted read-only and copied to a fresh temp directory inside the container, where install, build and
# start run as an unprivileged user. The result file is copied to <results-json-path> after the container has exited.
set -euo pipefail
CANDIDATE="$(cd "${1:?candidate dir}" && pwd)"
RESULTS="${2:?results json path}"
mkdir -p "$(dirname "$RESULTS")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="selarikru-verifier:playwright-1.65.0"
docker build -q -f "$ROOT/services/verifier/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
NAME="selarikru-verify-$$-$RANDOM"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
rm -f "$RESULTS"
set +e
# No host directory is writable from inside the container: the runner writes the result to a root-only path in the
# container filesystem, and this script copies it out with `docker cp` after the container has exited.
# Capabilities: only what the runner needs to drop to the candidate uid, hand it files, clean up after it and stop its processes.
docker run --name "$NAME" --shm-size=1gb --security-opt no-new-privileges --cap-drop=ALL \
  --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=KILL --cap-add=DAC_OVERRIDE --cap-add=FOWNER \
  -v "$CANDIDATE:/candidate:ro" \
  -e CANDIDATE_DIR=/candidate -e RESULTS_PATH=/verifier-out/result.json \
  ${VERIFY_SHOW_SETUP:+-e VERIFY_SHOW_SETUP=$VERIFY_SHOW_SETUP} \
  "$IMAGE"
CODE=$?
set -e
docker cp "$NAME:/verifier-out/result.json" "$RESULTS" >/dev/null 2>&1 || true
exit $CODE
