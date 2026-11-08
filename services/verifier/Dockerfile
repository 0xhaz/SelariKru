# Pinned verifier image. The Playwright version must equal @playwright/test in package.json (1.65.0).
# Build from the repository root:  docker build -f services/verifier/Dockerfile -t selarikru-verifier:playwright-1.65.0 .
# Base images are pinned by digest (tag kept for readability).
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d

# The starter pins Node 24; the base ships a newer Node, so use the official Node 24 binary.
COPY --from=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c /usr/local/bin/node /usr/local/bin/node
# better-sqlite3 has no prebuilt binary for this Node, so node-gyp needs a toolchain (top-level packages pinned).
RUN node -v | grep -q '^v24\.' && npm install -g pnpm@9.12.2 --no-fund --no-audit \
 && apt-get update && apt-get install -y --no-install-recommends python3=3.12.3-0ubuntu2.1 make=4.3-4.1build2 g++=4:13.2.0-7ubuntu1 \
 && rm -rf /var/lib/apt/lists/*

# Candidate code (install scripts, build, start) runs as this unprivileged user; the verifier tree stays root-owned.
RUN groupadd -g 10001 cand && useradd -u 10001 -g 10001 -m -d /home/cand -s /usr/sbin/nologin cand

ENV VERIFY_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d \
    VERIFY_CAND_UID=10001 VERIFY_CAND_GID=10001 VERIFY_CAND_HOME=/home/cand CI=true
WORKDIR /verifier
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/verifier/package.json services/verifier/package.json
RUN pnpm install --frozen-lockfile --filter @selarikru/verifier...
COPY services/verifier services/verifier
# The base image leaves /ms-playwright world-writable; root launches those browsers, so lock it down together with
# everything else root executes or loads. /verifier-tmp is root's private TMPDIR (Playwright's transform cache lives there).
RUN mkdir -m 700 /verifier-out /verifier-tmp \
 && chown -R root:root /verifier /ms-playwright /usr/local/lib/node_modules \
 && chmod -R go-w /verifier /ms-playwright /usr/local/lib/node_modules /usr/local/bin/node
ENV TMPDIR=/verifier-tmp PWTEST_CACHE_DIR=/verifier-tmp/pw-cache
WORKDIR /verifier/services/verifier
ENTRYPOINT ["pnpm", "exec", "tsx", "src/run.ts"]
