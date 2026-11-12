# Operator guide

For whoever runs n8n and the browser: installing the node, where the browser runs and how it is guarded, queue mode,
and the n8n settings that matter.

**Contents:** [Install the node](#install-the-node) · [Where the browser runs](#where-the-browser-runs) ·
[Queue mode](#queue-mode) · [Login breaker and run lock](#login-breaker-and-run-lock) · [Other settings](#other-settings)

## Install the node

- **From n8n**: **Settings → Community nodes → Install**, package `n8n-nodes-rpa`. n8n must allow unverified community
  packages. This one cannot be verified, because it depends on `playwright-core`. It runs on self-hosted n8n only.
- **In an image**: `docker/n8n.Dockerfile` installs the package next to n8n so it is there before n8n starts, from the
  source or from a release tarball (`--build-arg RPA_PACKAGE=release --build-context rpa-release=<directory holding the tarball>`).
  Loading needs `N8N_COMMUNITY_PACKAGES_ENABLED=true`. In n8n 2, `N8N_UNVERIFIED_PACKAGES_ENABLED=false` only stops
  installs from **Settings → Community nodes**. n8n 3 changes that, so check it before upgrading.
- **From the GitHub Release**: each release carries the npm tarball `n8n-nodes-rpa-<version>.tgz`, with a build
  attestation and its SHA-256. Check it and install it into n8n's nodes folder as the user n8n runs as, then restart n8n:

  ```sh
  v=0.1.0
  gh release download "v$v" --repo jb-n8n/n8n-nodes-rpa --pattern "n8n-nodes-rpa-$v.tgz*"
  gh attestation verify "n8n-nodes-rpa-$v.tgz" --repo jb-n8n/n8n-nodes-rpa
  sha256sum -c "n8n-nodes-rpa-$v.tgz.sha256"   # macOS: shasum -a 256 -c
  npm install --prefix ~/.n8n/nodes --omit=peer --ignore-scripts "./n8n-nodes-rpa-$v.tgz"
  ```

  `--omit=peer` keeps n8n's own `n8n-workflow`. n8n does not list a package installed this way under **Settings →
  Community nodes**. In queue mode, install it on the main instance, every worker and every webhook processor, or use
  the image.
- **Check what you install**: npm shows which commit and workflow built each version (`npm audit signatures`). The
  package's only runtime dependencies are `playwright-core`, `fflate` and `redis`, at exact versions.

## Where the browser runs

The node does not ship a browser. The **RPA Browser** credential says where Chromium runs, and the node talks to it
over the Playwright protocol. So the browser server is a Playwright server, and its Playwright version must match the
node's (1.63).

| Where | Use it for | Endpoint URL |
|---|---|---|
| Compose stack (`docker-compose.yml`) | Trying it out, and the reference setup | `ws://browser:3000/` (Private Network Endpoint on, token required) |
| The `rpa-browser` image with `docker run` | One machine without compose | `ws://127.0.0.1:3000/` and the token |
| A Windows machine with the [Windows package](../install/windows.md), installed with `-WithBrowser` | Bots that run on that machine | the browser's **Connection Line** |
| Kubernetes or Amazon ECS (`deploy/`) | Production at scale, next to n8n in queue mode | `ws://rpa-browser.<namespace>.svc.cluster.local:3000/` or `ws://<internal load balancer>:3000/` |
| A hosted Playwright endpoint such as Browserless | Production without running a browser | `wss://...`, token in the Token field |
| A browser server with its own certificate | A server on another machine over TLS | `wss://<host>:<port>/`, token, and **Certificate Fingerprint (SHA-256)** |
| Local Browser | Development only | none. Run `npx playwright install chromium` |
| Chrome DevTools Protocol | Vendors that only speak CDP. Lower fidelity, and downloads are refused | `wss://...` or `https://...` |

**Which addresses are accepted.** `ws://` only for loopback (`127.0.0.1`, `localhost`, `[::1]`), or for a host on a
private network when **Private Network Endpoint** is on and a token is set. Every other endpoint must be `wss://` with
a token. Put the token in the Token field, not in the URL. Local Browser runs with n8n's network identity and files:
use it for development only.

**The compose stack.** The `browser` service runs `playwright run-server` on the container's loopback (port 3001),
behind a small gate on port 3000 that checks the token (`images/browser/gate`). No port is published on your machine:
n8n connects to `ws://browser:3000/` over the compose network. The gate accepts a connection only with
`Authorization: Bearer <BROWSER_TOKEN>` (from `.env`, see `.env.example`) and refuses launch options other than
`headless`, `timeout` and `slowMo`. The container runs with no Linux capabilities and Chromium without its own
sandbox, so the container is the boundary around the pages it opens. `docker compose up -d browser` starts only the
browser, and `docker-compose.dev.yml` publishes the gate on `127.0.0.1:3000` for tools on your machine. A wrong token
fails `browser_unavailable` with `The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.`
The service, from `docker-compose.yml`:

```yaml
  browser:
    build:
      context: images/browser
    image: n8n-rpa/rpa-browser:local
    restart: unless-stopped
    user: pwuser
    working_dir: /home/pwuser
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    mem_limit: 2g
    pids_limit: 1024
    environment:
      BROWSER_GATE_TOKEN: ${BROWSER_TOKEN:?set BROWSER_TOKEN in .env}
      BROWSER_GATE_PORT: "3000"
      BROWSER_UPSTREAM_PORT: "3001"
    networks: [browser]
```

The browser is not on the network that holds Mailpit, so a page that took over the browser cannot read approval links.
It can still reach the internet and n8n on port 5678. For production, put an egress firewall in front of the browser
that lets it reach only the sites your runs visit.

**The published image.** `ghcr.io/jb-n8n/rpa-browser:<version>` (linux/amd64 and linux/arm64, with a build
attestation: `gh attestation verify oci://ghcr.io/jb-n8n/rpa-browser:<version> --owner jb-n8n`). To run it without
compose: `docker run -d --name rpa-browser -p 127.0.0.1:3000:3000 --cap-drop ALL --security-opt no-new-privileges:true -e BROWSER_GATE_TOKEN=<token> ghcr.io/jb-n8n/rpa-browser:<version>`.

**Sessions, health, metrics and stop.** The gate takes at most `BROWSER_GATE_MAX_SESSIONS` sessions (default 4, 1 to
64) and answers more with `503`. `GET /healthz` on port 3000 answers `200 ok`. Prometheus metrics are on port 9464
(`BROWSER_GATE_METRICS_PORT`, `0` turns them off), counts only. On stop the gate drains: it refuses new sessions and
waits up to `BROWSER_GATE_DRAIN_SECONDS` (600) for open ones. Docker kills a container 10 s after `docker stop` unless
you set `stop_grace_period`. On Amazon ECS, `BROWSER_GATE_ECS_PROTECTION=on` keeps a task with open sessions out of
scale-in, and `BROWSER_GATE_EMF=on` prints CloudWatch metrics (needs `BROWSER_GATE_SERVICE_NAME`).

**TLS, a token file and the listen address** (image 0.2.0 or later), for a gate with nothing in front of it:
- `BROWSER_GATE_TOKEN_FILE`: a file that holds the token, at least 32 printable ASCII characters. Save it as ASCII or UTF-8.
- `BROWSER_GATE_TLS_KEY_FILE` and `BROWSER_GATE_TLS_CERT_FILE`: a PEM key and certificate, both or neither. The gate
  then serves TLS on port 3000 (n8n connects with `wss://`), and a plain-text request to that port gets no HTTP answer.
  The certificate may be self-signed.
- `BROWSER_GATE_HOST`: the one address the session port listens on. `BROWSER_GATE_METRICS_HOST`: the metrics port's
  address (`127.0.0.1` when TLS is on).

With TLS on, a connection that is not a session is closed 10 s after its handshake, `/healthz` included, so a health
checker opens a new connection for each check. The port holds at most 256 connections. There is no limit per address
and no rate limit: limit the port to n8n's address with a firewall. The Helm chart's readiness probe and the ECS
module's health check ask `/healthz` over plain HTTP, so neither fits TLS mode as shipped.

**A server with its own certificate.** Use mode **Browser Server**, a `wss://` Endpoint URL, the token, and the
server certificate's SHA-256 fingerprint in **Certificate Fingerprint (SHA-256)**. The node then connects only to a
server that presents that certificate, and checks it before it sends the token. The fingerprint takes the place of the
issuer, host name and date checks. Without a fingerprint, the certificate must be one that n8n's Node.js process trusts:
one from an authority built into Node.js or listed in the file `NODE_EXTRA_CA_CERTS` names, not one from the operating
system's certificate store, which Node.js does not read by default. A self-signed certificate, one from an unknown
issuer, an expired one, or one whose name does not match the address fails with
`n8n does not trust the browser server's certificate. If the server uses a certificate of its own, put its SHA-256 fingerprint in Certificate Fingerprint (SHA-256) on the RPA Browser credential.`
Other failures, such as a certificate that is not yet valid, fail with the `Could not connect to the browser server`
message. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`: it turns certificate checks off for every connection n8n makes.

**Version matching.** This package uses `playwright-core` 1.63.0, so a self-run server is
`mcr.microsoft.com/playwright:v1.63.0` with `playwright@1.63.0` (pinned in `images/browser/server/package-lock.json`).
The credential test and every run report a mismatch and name the version they need. An ungated server for
development only, bound to loopback:

```bash
docker run -d --name browser --init -p 127.0.0.1:3000:3000 mcr.microsoft.com/playwright:v1.63.0 \
  /bin/sh -c "npx -y playwright@1.63.0 run-server --port 3000 --host 0.0.0.0"
```

**Hosted endpoints and other vendors.** Any hosted endpoint that runs a Playwright 1.63 server works in mode **Browser
Server**. Vendors that only speak the Chrome DevTools Protocol connect in mode **Chrome DevTools Protocol (CDP)**. In
both, the endpoint must allow a browser-level DevTools session, which the engine uses to check redirects.

**Deploy at scale.** `deploy/` runs the same `rpa-browser` image as a scaled service next to an n8n in queue mode,
so Chromium does not run in an n8n pod or task. Each replica serves a fixed number of sessions. The service scales on session use (ECS, or Kubernetes with KEDA and Prometheus) or on CPU, and drains open sessions on scale-in.
The Helm chart is `deploy/helm/rpa-browser`. The Terraform modules are `deploy/terraform/modules/k8s-browser` and
`deploy/terraform/modules/aws-ecs-browser`, and `deploy/terraform/examples/` has examples. After `terraform apply`,
`deploy/scripts/configure-n8n.mjs` creates the RPA Browser credential through n8n's public API and imports the
templates, with `N8N_API_KEY` and `RPA_BROWSER_TOKEN` in the environment. Then run `0-connection-check.json` against
your login page. `deploy/test/kind-e2e.sh` runs the chart on a throwaway kind cluster. The runbooks:
[`docs/deploy/kubernetes.md`](../deploy/kubernetes.md) and [`docs/deploy/aws-ecs.md`](../deploy/aws-ecs.md).

**Traces and Slow Motion.** The `trace` binary is a Playwright trace: open it with
`npx playwright@1.63.0 show-trace trace.zip`. The credential's **Slow Motion (ms)** waits before each browser action,
for a demo or a live view (over CDP or a Browser Server, a live view attached to the page can also show the running step). Keep it at 0 in production.

### Address checks run in n8n

The private-network block resolves host names with n8n's own resolver and checks the server address the browser
reports for each response. A remote browser behind an explicit proxy, or with its own DNS view, can reach another
address than the one n8n resolved. Give the browser the same DNS view as n8n and no forward proxy, or let the browser's
network reach only what runs may visit. Hosts you listed are resolved like any program on the n8n machine,
`/etc/hosts` included. Hosts allowed only because any site may load files are resolved with c-ares straight from the
DNS servers, so `/etc/hosts` is skipped and a VPN split-DNS name does not resolve: such names fail closed. List the
host (**Options → Also Allow These Sites**, the Allowed Hosts of the run) to resolve it like a listed site.

## Queue mode

- Set `EXECUTIONS_MODE=queue` on every n8n process (main and workers): the node reads it to know that a Site Login
  needs Redis. A process started as `n8n worker` counts as queue mode too.
- Attach an **RPA Redis** credential to Run Steps. The breaker and the run lock are then shared by every worker, under
  keys that start with `playwrightGuard:`. Without Redis in queue mode, Run Steps with a Site Login is a configuration
  error. A lock left by a worker that died frees itself after the run budget plus one minute.
- Give the node its own Redis ACL user: `ACL SETUSER rpa on >PASSWORD ~playwrightGuard:* +get +set +del +eval +select +ping +quit`.
  Breaker keys never expire, so avoid the `allkeys-*` eviction policies. Redis Cluster is not supported: Run Steps
  fails closed (an error item, no login). If Redis fails exactly while a trip is recorded, at most one more login can
  happen before the next failed login trips it again.

## Login breaker and run lock

One failed login stops every further login with that Site Login, so a wrong password does not lock the account. After
`login_failed`, a corrected username, password or TOTP Secret gets one try. Adding, replacing or removing the Site Login's TOTP Secret also counts as a changed login and gets one try.
In the other cases (the login was right, the account was locked, or the breaker opened in 0.2.0 or earlier), type a
new **Login Breaker Reset Key**. To tell a corrected login from the rejected one, the breaker keeps a fingerprint of
the rejected login: a salted scrypt hash, keyed with the TOTP Secret when there is one. It holds no username or
password, but someone who can read the workflow's static data or Redis can test guesses against it.

n8n saves the breaker with the workflow's static data only for production runs, not for manual executions: a breaker
tripped in a manual execution holds until n8n restarts. With RPA Redis it is kept in Redis. The Site Login also keys
the run lock: two workflows with the same Site Login share it (`busy`). A Site Login that n8n reports without an id is
a configuration error (`The RPA Site Login credential has no id. Save the credential, then select it again on this node.`).

## Other settings

- **Hosts are exact.** Case and default ports do not matter, and wildcards are not allowed. With a Site Login, add
  every site the login redirects to under **Sites the Browser May Open**. If an allowed site loads a script, style or
  image from another CDN, add it under **Sites It May Load Files From**. List the sites an embedded widget loads from
  under **Sites Allowed in Embedded Frames**.
- **Shutdown**: `N8N_GRACEFUL_SHUTDOWN_TIMEOUT` (30 s) can cut a run short during a deploy. Set it above **Max Seconds**
  if runs must finish.
- **Binary data**: traces, screenshots, PDFs and files are n8n binary data. Watch the database size, or use n8n's
  filesystem or S3 binary data mode.
- **Who can roll a bot back**: anyone who can edit the `playwright_steps` Data Table can switch a bot back to an
  earlier approved version. They cannot make it run steps nobody approved. Limit who can edit Data Tables.
- **A second site with its own Site Login** in the data feed needs a copy of workflow 3 too, with the new Site Login on
  its **Sign steps**: steps signed by the original are bound to the original Site Login.
- **Support**: best effort, through [GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues). Report security
  issues as [`SECURITY.md`](../../SECURITY.md) describes.
