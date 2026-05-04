# syntax=docker/dockerfile:1.6
#
# Three-process container for the OutSystems ONE 2026 QA lab:
#   1. openclaw-gateway (loopback :18789)
#   2. REST server (:3100, exposed)  — POST /test_user_story, async webhook
#   3. outsystemscc reverse tunnel (outbound, no listen)
#
# Designed for multi-arch buildx (linux/amd64 + linux/arm64). Pin every
# external dep so a release tag produces a deterministic image.

ARG NODE_VERSION=22-bookworm-slim
ARG OPENCLAW_VERSION=2026.4.15
ARG PLAYWRIGHT_MCP_VERSION=0.0.70
ARG OUTSYSTEMSCC_VERSION=2.0.7

# ---- builder stage: compile TypeScript ---------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && \
    npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ARG OPENCLAW_VERSION
ARG PLAYWRIGHT_MCP_VERSION
ARG OUTSYSTEMSCC_VERSION
ARG TARGETARCH

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    WORKSPACE_ROOT=/data/workspace-qa \
    GATEWAY_URL=http://127.0.0.1:18789/v1/chat/completions \
    PORT=3100

# Base utilities: ca-certificates for HTTPS, openssl for token minting,
# curl/tar for downloading outsystemscc, tini for clean PID-1 signal handling,
# git because openclaw's transitive deps include git+https URLs.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssl \
        tar \
        tini \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw + Playwright MCP, pinned. The single npm install -g layer keeps the
# image cache stable as long as the versions don't change.
RUN npm install -g \
        openclaw@${OPENCLAW_VERSION} \
        @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
    && npm cache clean --force

# Chromium binary + its apt runtime libs. --with-deps runs apt-get for the
# Debian/Ubuntu package list that Playwright's Chromium needs.
RUN npx --yes playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*

# OutSystems Cloud Connector. github releases publish per-arch tarballs whose
# names line up with Docker's TARGETARCH (amd64 / arm64).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) arch=amd64 ;; \
        arm64) arch=arm64 ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/OutSystems/cloud-connector/releases/download/v${OUTSYSTEMSCC_VERSION}/outsystemscc_${OUTSYSTEMSCC_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/outsystemscc.tgz; \
    tar -xzf /tmp/outsystemscc.tgz -C /usr/local/bin outsystemscc; \
    chmod +x /usr/local/bin/outsystemscc; \
    rm /tmp/outsystemscc.tgz; \
    /usr/local/bin/outsystemscc --help >/dev/null 2>&1 || true

# Apply the in-tree screenshot patches to the global openclaw install. Idempotent.
COPY scripts/patch-openclaw.mjs /opt/scripts/patch-openclaw.mjs
RUN node /opt/scripts/patch-openclaw.mjs

# Workspace template (read-only). Entrypoint copies into /data/workspace-qa
# on first start when the bind-mounted volume is empty.
COPY workspace-qa /opt/workspace-qa

# Sanitized openclaw config; entrypoint substitutes the gateway token.
COPY openclaw.template.json /opt/openclaw.template.json

# Built REST server (dist/ + production node_modules).
WORKDIR /opt/mcp-qa
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Entrypoint last so iteration on it doesn't bust earlier layers.
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3100
VOLUME ["/data/workspace-qa"]

# tini reaps zombies and forwards signals; entrypoint.sh manages the three
# child processes itself.
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
