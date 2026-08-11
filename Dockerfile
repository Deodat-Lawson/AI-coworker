# syntax=docker/dockerfile:1
#
# The relay, and only the relay. Desktop apps, agents and knowledge bases run on
# people's own machines — nothing in this image ever sees one, and it needs no
# model credentials.

# ---- build: compile shared + server, and nothing that drags in Electron ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
# npm reads every workspace's manifest even when it installs only two of them.
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
COPY packages/desktop/package.json packages/desktop/

RUN npm ci --include-workspace-root \
      --workspace @ai-coworker/shared \
      --workspace @ai-coworker/server

COPY packages/shared packages/shared
COPY packages/server packages/server
RUN npx tsc -b packages/server

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
COPY packages/desktop/package.json packages/desktop/

RUN npm ci --omit=dev --include-workspace-root \
      --workspace @ai-coworker/shared \
      --workspace @ai-coworker/server \
 && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist

# Accounts, workspaces and the meeting schedule belong on a mounted volume: the
# image is disposable, and a relay that forgets its accounts locks everybody out.
ENV HOST=0.0.0.0 \
    PORT=8787 \
    AI_COWORKER_RELAY_STATE=/data/relay-state.json \
    AI_COWORKER_WORKSPACE_STATE=/data/relay-workspaces.json \
    AI_COWORKER_ACCOUNT_STATE=/data/relay-accounts.json

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
