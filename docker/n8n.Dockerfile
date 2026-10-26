# syntax=docker/dockerfile:1
# Builds n8n with the n8n-nodes-rpa community package baked in. Build context: the repository root.
# Base images are pinned by digest (the tag is kept for readability); Dependabot proposes digest updates.

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base

FROM base AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY sandbox ./sandbox
# The gate is a workspace package (a dev dependency of the engine); pnpm pack can't resolve workspace:* without it.
COPY images/browser/gate ./images/browser/gate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter n8n-nodes-rpa build \
 && mkdir -p /packs \
 && pnpm --filter n8n-nodes-rpa pack --pack-destination /packs

FROM base AS install
WORKDIR /opt/n8n-rpa
COPY --from=build /packs /packs
# The engine is bundled inside the node package; its dependencies (playwright-core, fflate, redis) come from the registry, pinned.
# --omit=peer: n8n-workflow is a peer dependency and n8n provides its own copy, so it must not be installed beside it.
# --ignore-scripts: neither the package nor its dependencies have install scripts, so none may run.
RUN npm init -y >/dev/null \
 && npm install --ignore-scripts --omit=dev --omit=peer --no-audit --no-fund /packs/n8n-nodes-rpa-*.tgz

FROM n8nio/n8n:2.41.0@sha256:7217b80f0dd060c1328f328f7ce4f4bb106efd4d4da78157ca5a8cf3f81edfaf
USER root
COPY --from=install /opt/n8n-rpa/node_modules /opt/n8n-rpa/node_modules
COPY docker/n8n-entrypoint.sh /n8n-rpa-entrypoint.sh
RUN chmod 0755 /n8n-rpa-entrypoint.sh && chown -R node:node /opt/n8n-rpa
USER node
ENTRYPOINT ["tini", "--", "/n8n-rpa-entrypoint.sh"]
