#!/usr/bin/env bash
# Builds the pinned verifier image and verifies a candidate inside it.
#   docker-verify.sh <candidate-dir> <results-json-path>
# The candidate is mounted read-only; the runner copies it to a fresh temp directory inside the container,
# so each run starts clean. Only the results directory is writable from the host side.
set -euo pipefail
CANDIDATE="$(cd "${1:?candidate dir}" && pwd)"
RESULTS="${2:?results json path}"
mkdir -p "$(dirname "$RESULTS")"
RESULTS_DIR="$(cd "$(dirname "$RESULTS")" && pwd)"
RESULTS_FILE="$(basename "$RESULTS")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="selarikru-verifier:playwright-1.65.0"
docker build -q -f "$ROOT/services/verifier/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
rm -f "$RESULTS_DIR/$RESULTS_FILE"
docker run --rm --ipc=host \
  -v "$CANDIDATE:/candidate:ro" \
  -v "$RESULTS_DIR:/results" \
  -e CANDIDATE_DIR=/candidate -e "RESULTS_PATH=/results/$RESULTS_FILE" \
  "$IMAGE"
