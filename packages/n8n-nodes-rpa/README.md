# n8n-nodes-rpa

Robotic process automation (RPA) for self-hosted [n8n](https://n8n.io). Take a screenshot of a page, read its text, save
it as a PDF, extract a table or a list, fill in and submit a form, or download a file: a URL and one or two fields, no
code. For sites behind a login there is **Run Steps**: a signed list of browser steps that repairs itself with an AI
chat model when the site changes, with a person approving every fix. **Import Steps** turns a Chrome Recorder export,
Playwright code or a UiPath project into such steps.

A personal open-source project (MIT), not an official n8n product. Full documentation:
**https://github.com/jb-n8n/n8n-nodes-rpa**

## Install

In a self-hosted n8n: **Settings → Community nodes → Install**, package `n8n-nodes-rpa`. n8n must allow community
packages (`N8N_COMMUNITY_PACKAGES_ENABLED=true`, the default) and the install of unverified ones. n8n Cloud runs only
verified community nodes, and a node that drives a browser cannot be verified, so this package is for self-hosted n8n
only.

**Or from the GitHub Release.** Each version is also attached to its
[GitHub Release](https://github.com/jb-n8n/n8n-nodes-rpa/releases) as `n8n-nodes-rpa-<version>.tgz` (the same tarball
npm has), with a build attestation and a SHA-256 file. Check it, install it into n8n's nodes folder as the user n8n
runs as, then restart n8n (on macOS use `shasum -a 256 -c`):

```sh
v=0.1.0
gh release download "v$v" --repo jb-n8n/n8n-nodes-rpa --pattern "n8n-nodes-rpa-$v.tgz*"
gh attestation verify "n8n-nodes-rpa-$v.tgz" --repo jb-n8n/n8n-nodes-rpa
sha256sum -c "n8n-nodes-rpa-$v.tgz.sha256"
npm install --prefix ~/.n8n/nodes --omit=peer --ignore-scripts "./n8n-nodes-rpa-$v.tgz"
```

The folder is `~/.n8n/nodes` (`$N8N_USER_FOLDER/.n8n/nodes` when `N8N_USER_FOLDER` is set); n8n loads every
`n8n-nodes-*` package in its `node_modules` at start. `--omit=peer` keeps n8n's own `n8n-workflow`; the three
dependencies come from the npm registry at exact versions. For n8n in Docker, copy the tarball into the container and
run the same command there with `docker exec -u node`, with the folder at `/home/node/.n8n/nodes` on a volume. n8n does
not list a package installed this way under **Settings → Community nodes**; upgrade it the same way.

**Queue mode:** every n8n process loads nodes from its own disk, so the main instance, every worker and every webhook
processor need the package. Install it on each, use `N8N_REINSTALL_MISSING_PACKAGES=true` with the Community nodes
install, or run an image with the package baked in: the repository's `docker/n8n.Dockerfile` builds n8n 2.45.3 with it,
from the source at a tag or from the downloaded tarball (`--build-arg RPA_PACKAGE=release --build-context
rpa-release=<directory holding the tarball>`).

The node drives a browser it does not run itself. Point the **RPA Browser** credential at one of:

- **Browser Server**: a browser server over the Playwright protocol (`ws://…` or `wss://…` with a token), such as
  Browserless or the `rpa-browser` image, `ghcr.io/jb-n8n/rpa-browser` (Playwright's run-server behind a token gate,
  with a session limit, health checks, metrics and drain). The server's version must match this package's
  `playwright-core` (1.63).
- **Chrome DevTools Protocol**: a Chromium you run with remote debugging. Lower fidelity, and no downloads.
- **Local Browser**: a Chromium installed next to n8n, for development only.

The repository's [Hello world in 10 minutes](https://github.com/jb-n8n/n8n-nodes-rpa#hello-world-in-10-minutes) starts
n8n, a browser server and a sandbox site with one `docker compose up`. To run the browser as a scaled service next to
n8n in queue mode, follow the runbooks for
[Kubernetes](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/deploy/kubernetes.md) and
[Amazon ECS](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/deploy/aws-ecs.md) (Helm chart and Terraform
modules included).

## Operations

| Operation | What it does |
|---|---|
| Screenshot | A PNG of the full page, the viewport or one element |
| Get Page | The page's text, its HTML, or just its title and URL |
| Save as PDF | The page as a PDF |
| Extract Data | A table or a repeated list as items, with an optional ID pattern and row count check |
| Fill and Submit Form | Fills a form on the page and submits it (never a password field) |
| Download File | The file a link or button downloads, checked by its contents |
| Run Steps | A JSON list of browser steps, for sites behind a login; optional AI Repair |
| Sign Steps | Signs repaired steps once a person approves them (HMAC), so Run Steps runs only what was approved |
| Import Steps | Turns a Chrome Recorder export, Playwright code or a UiPath project into steps for approval. Typed passwords are never imported, and imports never write |

Each quick operation shows the steps it ran in its output, ready to paste into Run Steps. The package also ships a JSON
Schema of the step document for editor autocomplete, at `dist/schema/steps.schema.json`
([Step schema](https://github.com/jb-n8n/n8n-nodes-rpa#run-steps-reference)).

## Credentials

- **RPA Browser**: where the browser runs (above), an optional token and Slow Motion.
- **RPA Site Login**: the login page, username, password and optional TOTP secret for one site, and the sites the
  browser may open and the forms it may submit. Secrets reach the page only through a sign-in step and are masked in
  every output, log and trace.
- **RPA Step Signing**: the HMAC key that Sign Steps signs with and Run Steps checks.
- **RPA Redis**: optional; in queue mode with several workers, it shares the login breaker and the run lock between
  them.
- **RPA Desktop Runner**: for Run Steps with desktop steps (`"surface": "desktop"`): a desktop runner's `wss://` URL,
  its token and its certificate fingerprint, checked before the token is sent. See Desktop runs in the repository
  README.

## Templates

The package ships workflow templates in `templates/`; import them with **… → Import → From file**:

| Template | What it does |
|---|---|
| RPA: Hello world | The first screenshot and a table from the sandbox site |
| RPA: 0 Connection check | One screenshot of your site: proves the browser reaches it before anyone writes steps |
| RPA: 1 Create tables | Creates the two Data Tables the feed uses (run once) |
| RPA: 2 Data feed | The self-healing data feed: runs the newest approved steps on a schedule, repairs them with AI when the site changes |
| RPA: 3 Approve steps | Emails the evidence of a repair, waits for a person's approval, signs the steps |
| RPA: 5 Import a bot | A form in front of Import Steps: upload a recording, code or a UiPath project; what passes goes to approval |

## When something fails

Errors carry a code and a message that says what to do. Two you may meet first:

| You see | What to do |
|---|---|
| `browser_unavailable`: `The browser server is version X but this node needs Y.` | Use a browser server with the Playwright version the message names. |
| `browser_unavailable`: `The browser service at … had no free browser session for 60 s.` | Every browser session was busy for 60 s: add browser capacity (more replicas or sessions per replica) or start fewer RPA runs at once. |

The full list is under [Error codes](https://github.com/jb-n8n/n8n-nodes-rpa#error-codes).

## Safety

Every run opens only the sites its operation allows, blocks your private network unless you allow it, sends writes only
where the steps declare them, and keeps a scrubbed browser trace. AI repair works on a masked snapshot, is proven in a
fresh browser with no model and no writes, and never runs until a person approves it through the approval link sent to
the approver. The link is a bearer link: anyone who receives or forwards the approval message can approve, so send it to
one person. See
[Safety model](https://github.com/jb-n8n/n8n-nodes-rpa#safety-model) and the
[security review](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/security-review.md).

## Support

Best effort, through [GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues). Report vulnerabilities privately,
as [SECURITY.md](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/SECURITY.md) describes. Changes are listed in the
[CHANGELOG](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/CHANGELOG.md).

## License

[MIT](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/LICENSE)
