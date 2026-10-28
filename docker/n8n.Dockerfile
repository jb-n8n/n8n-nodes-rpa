# syntax=docker/dockerfile:1
# Builds n8n with the n8n-nodes-rpa package baked in. Build context: the repository root. The package comes from one of:
# - source (the default): the workspace at the checked-out commit, built and packed here.
#     docker build -f docker/n8n.Dockerfile -t <image> .
# - release: a tarball downloaded from the GitHub release (check it first: gh attestation verify, sha256sum -c), in a
#   directory passed as the build context rpa-release; that directory must hold exactly one n8n-nodes-rpa-*.tgz.
#     docker build -f docker/n8n.Dockerfile --build-arg RPA_PACKAGE=release --build-context rpa-release=<dir> -t <image> .
# Base images are pinned by digest (the tag is kept for readability); Dependabot proposes digest updates.

ARG RPA_PACKAGE=source

FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS base

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

FROM build AS package-source

FROM base AS package-release
COPY --from=rpa-release n8n-nodes-rpa-*.tgz /packs/
RUN test "$(ls /packs | wc -l)" -eq 1 || { echo "the rpa-release context must hold exactly one n8n-nodes-rpa-*.tgz" >&2; exit 1; }

# BuildKit builds only the stage RPA_PACKAGE selects.
FROM package-${RPA_PACKAGE} AS package

FROM base AS install
WORKDIR /opt/n8n-rpa
COPY --from=package /packs /packs
# The engine is bundled inside the node package; its dependencies (playwright-core, fflate, redis) come from the registry, pinned.
# --omit=peer: n8n-workflow is a peer dependency and n8n provides its own copy, so it must not be installed beside it.
# --ignore-scripts: neither the package nor its dependencies have install scripts, so none may run.
RUN npm init -y >/dev/null \
 && npm install --ignore-scripts --omit=dev --omit=peer --no-audit --no-fund /packs/n8n-nodes-rpa-*.tgz

FROM n8nio/n8n:2.45.3@sha256:bf88c3783fc4b2a90a007bb99b04ad2f6a9627f41499baf72ca67559c51c7f4c
USER root
COPY --from=install /opt/n8n-rpa/node_modules /opt/n8n-rpa/node_modules
# Also in the nodes folder itself, where n8n loads it from, for containers that skip the entrypoint below: n8n's Helm
# chart starts workers and webhook processors with `command: ["n8n"]`. A volume mounted on /home/node/.n8n hides this
# copy; the entrypoint then copies the package from /opt/n8n-rpa into the volume.
COPY --from=install --chown=node:node /opt/n8n-rpa/node_modules /home/node/.n8n/nodes/node_modules
COPY docker/n8n-entrypoint.sh /n8n-rpa-entrypoint.sh
RUN chmod 0755 /n8n-rpa-entrypoint.sh && chown -R node:node /opt/n8n-rpa
USER node
ENTRYPOINT ["tini", "--", "/n8n-rpa-entrypoint.sh"]
