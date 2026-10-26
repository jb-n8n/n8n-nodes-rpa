#!/bin/sh
# The rpa-browser supervisor. tini is PID 1 and runs this script; this script runs the Playwright run-server and the gate.
# /bin/sh in this image is dash: no `wait -n`, no arrays, no `local` beyond what dash allows.
#
# The run-server listens on the container's loopback only; the gate on BROWSER_GATE_PORT (3000) forwards WebSocket upgrades
# that carry the token. The run-server needs no auth and shares this network namespace with the browsers it launches, so a
# page that reached 127.0.0.1:3001 could drive it. The engine already blocks page requests and WebSockets to loopback; as
# a second layer, the run-server only answers on a random 128-bit path generated here at each container start. The path is
# not exposed outside the container: BROWSER_UPSTREAM_PATH is set for the gate process only (so it is not in `docker
# inspect` or the image config), and the run-server's stdout (which prints the full address) and stderr go to /dev/null,
# so neither reaches the container logs. The gate's own output is kept: its errors still show in the logs. Never add
# --unsafe to the run-server.
#
# The run-server is started without BROWSER_GATE_TOKEN in its environment, so neither it nor the browsers it launches
# ever hold the token; only the gate needs it.
#
# Supervision:
# - TERM or INT (docker stop, a Kubernetes pod deletion, an ECS task stop): signal only the gate and wait for it to exit
#   (the gate drains: it refuses new sessions and waits for the open ones, up to BROWSER_GATE_DRAIN_SECONDS). A second
#   TERM or INT is passed on to the gate, which then exits at once. Then stop the run-server, then exit 0.
# - The run-server or the gate exits on its own: stop the other and exit 1, so the orchestrator restarts the container.
set -u

RS=''
GATE=''
SLEEPER=''
SIGNALS=0
# A trapped signal makes the `wait` in nap() return at once; the loops below then see SIGNALS go up.
trap 'SIGNALS=$((SIGNALS + 1))' TERM INT

# Sleeps $1 seconds in a way trapped signals interrupt (a foreground `sleep` is not interruptible, `wait` on a background
# one is), and dash reaps every finished child while it waits, so `kill -0` stops succeeding once a process has exited.
nap() {
  sleep "$1" &
  SLEEPER=$!
  wait "$SLEEPER"
}

P="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
env -u BROWSER_GATE_TOKEN /opt/rpa-browser/server/node_modules/.bin/playwright run-server --port "${BROWSER_UPSTREAM_PORT:-3001}" --host 127.0.0.1 --path "/$P" >/dev/null 2>&1 &
RS=$!
BROWSER_UPSTREAM_PATH="/$P" node /opt/rpa-browser/gate/gate.mjs &
GATE=$!
P=''

while [ "$SIGNALS" = 0 ] && kill -0 "$RS" 2>/dev/null && kill -0 "$GATE" 2>/dev/null; do
  nap 1
done
kill "$SLEEPER" 2>/dev/null

if [ "$SIGNALS" -gt 0 ]; then
  kill -TERM "$GATE" 2>/dev/null
  SENT=1
  # Wait for the gate to finish draining; pass every further signal on to it (the gate exits at once on its second).
  # If the gate dies on its own during the drain (a crash, an OOM kill), this still ends with exit 0: a stop was asked
  # for, the container is going away either way, and the open sessions end with it.
  while kill -0 "$GATE" 2>/dev/null; do
    if [ "$SIGNALS" -gt "$SENT" ]; then
      SENT=$SIGNALS
      kill -TERM "$GATE" 2>/dev/null
    fi
    nap 0.2
  done
  # While a browser is alive, the run-server's own SIGTERM handler closes the browsers without exiting, so a TERM that
  # arrives while the last session's browser is still closing is swallowed. Repeat TERM every second, KILL after 10 s.
  I=0
  while kill -0 "$RS" 2>/dev/null; do
    if [ "$I" = 100 ]; then
      echo "rpa-browser: the run-server did not stop within 10 s of TERM; killing it" >&2
      I=101
    fi
    if [ "$I" -ge 100 ]; then
      kill -KILL "$RS" 2>/dev/null
      nap 0.1
      continue
    fi
    [ $((I % 10)) = 0 ] && kill -TERM "$RS" 2>/dev/null
    I=$((I + 1))
    nap 0.1
  done
  exit 0
fi

# No waiting here: when this script exits, tini exits and the container's remaining processes are killed with it.
kill -TERM "$RS" "$GATE" 2>/dev/null
echo "rpa-browser: the run-server or the gate stopped; exiting so the container restarts" >&2
exit 1
