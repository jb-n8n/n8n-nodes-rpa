# The rpa-browser image: the Playwright image (its browsers), playwright 1.63.0's run-server installed here from
# server/package-lock.json, the token gate (gate/gate.mjs and its ECS module gate/ecs.mjs, no dependencies) and the
# supervisor (entrypoint.sh) under tini.
# npm ci checks every package against the lockfile's integrity hashes, so the container downloads nothing at start.
# Build context: this directory (images/browser). Compose, ECS and Kubernetes all run this same image.
# Base image pinned by digest (the tag is kept for readability); Dependabot proposes digest updates. The image tag, the
# lockfile and the engine's playwright-core move together (README: Version matching).

FROM mcr.microsoft.com/playwright:v1.64.1@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

# tini is PID 1: it forwards signals to the supervisor and reaps orphaned browser processes. Kubernetes has no init
# option, so the image brings its own. Pinned to the version in the base image's distribution (Ubuntu 24.04 noble/universe).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini=0.19.0-1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/rpa-browser/server
COPY --chmod=0644 server/package.json server/package-lock.json ./
# --ignore-scripts: the browsers come with the image, nothing needs to run at install. Root owns the install, the gate and
# the supervisor, so they are read-only to pwuser.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# COPY --chmod would give the gate directory it creates the file's mode (0644, not traversable), so create it first.
RUN mkdir -p /opt/rpa-browser/gate
COPY --chmod=0644 gate/gate.mjs /opt/rpa-browser/gate/gate.mjs
COPY --chmod=0644 gate/ecs.mjs /opt/rpa-browser/gate/ecs.mjs
COPY --chmod=0755 entrypoint.sh /opt/rpa-browser/entrypoint.sh

# The gate's port (WebSocket) and the run-server's loopback port. BROWSER_GATE_TOKEN has no default: the gate refuses to
# start without a token of at least 32 characters.
ENV BROWSER_GATE_PORT=3000 \
  BROWSER_UPSTREAM_PORT=3001
EXPOSE 3000

# Chromium writes profiles, downloads and caches to /tmp. Declared a volume so that a read-only root filesystem still has
# a writable /tmp: on ECS a bind mount at a VOLUME path gets the image's contents, owner and mode (AWS: "Use bind mounts
# with Amazon ECS"); without the VOLUME, Fargate creates it root-owned 0755 and pwuser couldn't write it. Root-owned 1777,
# like a normal /tmp. Kubernetes ignores VOLUME; the chart mounts an emptyDir there.
RUN chown root:root /tmp && chmod 1777 /tmp
VOLUME ["/tmp"]

USER pwuser
WORKDIR /home/pwuser
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/rpa-browser/entrypoint.sh"]
