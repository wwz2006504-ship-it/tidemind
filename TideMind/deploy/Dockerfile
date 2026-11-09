FROM node:24-bookworm-slim
# Build context is the isolated package root, never a production directory.
COPY --chown=node:node TideMind/deploy/existing/ /app/TideMind/deploy/existing/
COPY --chown=node:node integration/store-batch.mjs /app/integration/store-batch.mjs
COPY --chown=node:node integration/activity-gate.mjs /app/integration/activity-gate.mjs
USER node
WORKDIR /app/TideMind/deploy/existing
CMD ["node", "/app/TideMind/deploy/existing/tidemind-api.mjs", "--dry-run"]
