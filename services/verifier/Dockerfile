# Pinned verifier image. The Playwright tag must equal the @playwright/test version in package.json (1.65.0).
# Build from the repository root:  docker build -f services/verifier/Dockerfile -t selarikru-verifier:playwright-1.65.0 .
FROM mcr.microsoft.com/playwright:v1.65.0-noble

# The starter pins Node 24; this base image ships a newer Node, so use the official Node 24 binary.
COPY --from=node:24.22.1-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN node -v | grep -q '^v24\.' \
 && npm install -g pnpm@9.12.2 --no-fund --no-audit \
 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENV VERIFY_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble CI=true
WORKDIR /verifier
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/verifier/package.json services/verifier/package.json
RUN pnpm install --frozen-lockfile --filter @selarikru/verifier...
COPY services/verifier services/verifier
WORKDIR /verifier/services/verifier
ENTRYPOINT ["pnpm", "exec", "tsx", "src/run.ts"]
