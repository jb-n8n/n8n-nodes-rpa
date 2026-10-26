#!/bin/sh
# Copies the baked n8n-nodes-rpa package (and its dependencies) into the n8n user folder on every start, so an
# image upgrade replaces what an older start copied into the n8n_data volume, then hands over to n8n's entrypoint.
set -e
SRC=/opt/n8n-rpa/node_modules
NODES=/home/node/.n8n/nodes/node_modules
mkdir -p "$NODES"
for name in $(ls -A "$SRC"); do
  rm -rf "$NODES/$name"
  cp -R "$SRC/$name" "$NODES/$name"
done
exec /docker-entrypoint.sh "$@"
