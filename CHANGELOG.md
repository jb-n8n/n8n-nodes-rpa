# Changelog

All notable changes to `n8n-nodes-rpa`, the `rpa-browser` image and the Windows package. Versions follow
[Semantic Versioning](https://semver.org/); until 1.0, a minor version may change behavior. The node is released with
`v<version>` tags, the image with `browser-v<version>` tags, the Windows package with `desktop-v<version>` tags.

## Unreleased

- A run may last up to 600 seconds (Max Seconds, was 300), and a browser step's `timeoutMs` may be 100 to 300000 (was 120000). A longer run holds its browser session and its Site Login lock for as long as it runs. A Windows run's Max Seconds also rises to 600, while a Windows step keeps its 120000 limit.
- A browser step's `when` may now also be `{ hidden: <locator> }` (run only when the element does not show) or a run variable compared with literal text, `{ var, equals }` or `{ var, notEquals }`; write the opposite condition on the next step in place of an else. A variable condition is refused on `signIn`, `submit`, `download`, a `paginate` that holds a `submit` or `download`, the click that opens a write window, and a variable that a secret `fill` types. Step lists signed before keep their signature and run as before; a list that uses the new forms is refused by 0.2.0.
- Two new browser steps and a click with keys held: `press` sends one key chord (`{ key, target? }`: Enter, Tab, Escape, Backspace, Delete, arrows, PageUp, PageDown, Home, End, F1 to F12, alone or after Ctrl, Alt and Shift, or Ctrl+A), `hover` moves the mouse over an element, and `modifiers` beside a `click` (`["Ctrl"]`, `["Shift"]`, `["Alt"]`) holds keys during it. A key that types a character, a paste and `{{var.name}}` in `key` are refused, and so is a `press` on a password field. `press` is not a declared write: an Enter that would post a form is refused like a click on its button, and an Enter that sends a search by GET passes. Step lists signed before keep their signature and run as before; a list that uses the new steps is refused by 0.2.0.
- Import Steps: a hover in Playwright code or a UiPath project (Hover) becomes a `hover` step, and a UiPath browser click with Ctrl, Shift or Alt held (KeyModifiers) becomes a `click` with `modifiers`. A UiPath browser click with the right or middle button, or with another key held, is reported as not translated; it used to import as a plain click. The Chrome Recorder's hovers are still dropped, and Enter is imported as before.

## 0.2.0 (2026-11-10)

The node `n8n-nodes-rpa` 0.2.0, the image `ghcr.io/jb-n8n/rpa-browser:0.2.0` (Playwright 1.63.0, the gate settings
below) and the first Windows package, `rpa-windows-x64.zip` (GitHub Release `desktop-v0.2.0`, with its SHA-256 and a
build attestation). [`docs/install/windows.md`](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/install/windows.md) is
the install guide, with a sample flow; [`docs/install/licensing.md`](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/install/licensing.md) is a note on what
Microsoft's terms say about unattended automation on Windows (not legal advice).

### Desktop steps

- **Desktop step sets** (`"surface": "desktop"`): Run Steps drives a Windows app through the RPA desktop runner, with
  the **RPA Desktop Runner** credential (runner URL, token, certificate fingerprint). UI Automation locators; the verbs
  `click`, `fill`, `select`, `check`, `waitFor`, `read`, `key` and `expectFile` (a file the app saved, returned like a
  download). Steps are signed and approved like browser steps; Sign Steps' **Write Steps** marks the steps that save,
  post or submit. 0.1.0 refuses desktop steps.
- **Import Steps** turns the desktop activities of a UiPath project into desktop step sets for approval, and the
  generated workflow runs each one on the RPA Desktop Runner credential.
- **The desktop runner** (`RpaRunner.exe`): a WebSocket server with TLS and a token, in the signed-in session of the
  bot user. A local policy on the Windows machine, which only administrators can change, lists the apps it may start
  and the controls and keys that count as writes. **The policy tool** (`RpaPolicy.exe`) shows a change to that policy
  in plain lines and applies it after an administrator says yes.

### Sign-in codes, locator variables, secret fill and clipboard reads (#54)

- **One-time code from a workflow**: a sign-in's `totp` can say `"source": "workflow"`; Run Steps runs the workflow
  named in **Options → One-Time Code Workflow** and types the code it returns (for a code from an email or an
  authenticator app). `totp.via` clicks through a factor choice or "Send me the code" page before the code field, and
  `totp.check` ticks boxes such as "Trust this browser" before the code is submitted.
- **Variables in locators**: `{{var.name}}` in the name of a role locator, in a visible text locator and in a desktop
  condition's `name`, rendered each run; refused in every locator of a step that writes or signs in. A `select` may
  take a list of values.
- **`fill.secret`**: signed steps can type a per-run secret from a variable into a password field; the value is
  masked from the start of the run.
- **Clipboard reads** for desktop steps (`read { clipboard: true, as }`), for apps whose value is only available
  through a Copy button. The runner returns only the run's own fresh copy, and only when its policy sets
  `clipboardRead`. Its policy can also list helper processes (`helperProcesses`), so that a web view app's elements
  resolve.

### A browser server with its own certificate

- **Certificate Fingerprint (SHA-256)** on the RPA Browser credential: in Browser Server mode with a `wss://` address,
  the node connects only to a server whose certificate has that SHA-256 fingerprint, and checks it before it sends the
  token. For a browser server with a self-signed certificate, such as the one the Windows package installs.
- **The gate** (`images/browser/gate`) can serve TLS, read its token from a file and listen on a chosen address. These
  settings need the `rpa-browser` image 0.2.0 or later: the 0.1.0 image does not read them.

### The Windows package

- `Install-Rpa.ps1` installs the runner, the policy tool, a browser host (Node.js, the gate with TLS, the browser
  server and Chromium) and the ERP Demo on Windows 10 1809 or later, Windows 11 or Windows Server 2019 or later. Both
  programs run in the bot user's session, started by scheduled tasks at that user's sign-in. The installer creates a
  standard local bot user or uses one you name, writes both tokens, limits the firewall rules to the addresses you
  give, and checks who can change the package and the data directory before it uses them. `-AutoSignIn` sets up
  automatic sign-in only when asked for, and lists what it changes first.
- `Show-RpaConnection.ps1` prints what the n8n credentials need: the URLs and fingerprints, and the tokens with
  `-ShowTokens`. `Uninstall-Rpa.ps1` removes the install and puts back what `-AutoSignIn` changed; `-RemoveData` removes
  the data directory too.
- The browser host opens the browser with a window on the bot user's desktop for every client that does not ask
  otherwise, so runs from n8n get a browser with a window. Save as PDF needs a headless browser and fails on it.
- The package is built, installed and driven end to end on Windows in CI (GitHub's `windows-latest`, Windows Server
  2025), and released from the `Desktop release` workflow after a reviewer approves it. It is not code-signed.
- **The desktop test bed**: `deploy/terraform/modules/aws-ec2-desktop-runner` (with an example and
  `deploy/scripts/desktop-testbed.sh`) runs the package on a Windows Server 2022 VM on EC2.

### Coming from 0.1.0

- **Templates 3 and 5 changed**: **RPA: 3 Approve steps** has four new nodes (**Desktop steps?**, **Ask for approval
  (desktop steps)**, **Desktop answer** and **Email signed steps**), and **RPA: 5 Import a bot** has new texts. Import
  both again and pick the SMTP credential on the new email nodes; a 0.1.0 workflow 3 approves desktop steps without the
  Write steps question.
- **The compose stack** runs n8n from the `n8nio/n8n:2.45.3` image (0.1.0: 2.41.0), builds the package in a
  `node:26-alpine` stage, and runs Mailpit 1.32.
- **Error codes**: a new code, `runner_unavailable`; `busy` also means a desktop runner busy with another run; Run
  Steps' Data has `values` for desktop reads. The `browser_unavailable` message for a server that cannot be reached
  has a new sentence for a Windows install.
- **RPA Browser is no longer marked required** on the node (desktop steps run without it), so n8n does not flag it
  when it is missing; a browser operation without it fails with `This operation runs in a browser: attach an RPA
  Browser credential.`

### Fixes

- **A rejected password is `login_failed`** without a `detect` step: when the site sends the password page back
  after `signIn` submitted it, the step fails with `login_failed` (`account_locked` when the page says the account is
  locked) and the login breaker opens. In 0.1.0 a hand-written sign-in passed, and the run failed later as drift (with
  AI Repair on, the model then tried to repair it).
- **The Allow Unsigned Writes option and the README now state what the switch hands over**: unsigned steps may sign in,
  so whoever can set the steps drives the Site Login.
- **A `paginate` whose body holds a `submit` or a `download` takes no `{{var.name}}` in its own `when`, `expect` or
  `next`**: they decide whether and how often the write runs. Run Steps and the schema refuse it when the steps are read.
- **Import Steps drops a recorded password from fields named in other languages**, not only English: Kennwort,
  contraseña, mot de passe, senha, wachtwoord, пароль, パスワード, 密码, 비밀번호 and more; such a field, and one named
  `pass`, starts the `signIn` as an English one does. In 0.1.0 a Chrome recording or Playwright code kept the typed
  password as a literal in the draft. Passenger, passport, compass and bypass fields are no longer stripped as
  password fields.
- **The approval emails say that the evidence and the change list are as reported by the run**: in **RPA: 3 Approve
  steps**, the review email's Evidence and What changed and the approval email's Evidence. Sign Steps recomputes the
  safety flags from the steps, not these. The desktop approval email (**Ask for approval (desktop steps)**) keeps its
  `Evidence:` label: its evidence is a fixed text and its change list is checked step by step. Import template 3 again
  for the new texts.

## 0.1.0 (2026-10-26)

First public release: the node `n8n-nodes-rpa` 0.1.0 on npm (the same tarball is attached to the GitHub Release, with
a build attestation) and the image `ghcr.io/jb-n8n/rpa-browser:0.1.0` (Playwright 1.63.0).

### The node

- **Quick operations**: Screenshot, Get Page, Save as PDF, Extract Data (table or list), Fill and Submit Form, Download
  File. A URL and one or two fields; GET only, except the form's own submit.
- **Run Steps**: a JSON list of browser steps for sites behind a login, with a Site Login credential (username, password,
  TOTP) whose secrets reach the page only through a sign-in step and are masked everywhere. Optional AI Repair: when
  the steps stop matching the site, a chat model finds the data in the same browser, the engine compiles its actions
  into new steps and proves them in a fresh browser with no model and no writes. The repaired steps carry the proof
  run's trace for the reviewer.
- **Sign Steps**: signs approved steps with an HMAC key; Run Steps refuses unsigned or edited steps by default.
- **Import Steps**: turns a Chrome Recorder export, Playwright code or a UiPath project into steps for approval. Typed
  passwords are never imported, imports never write, and what passes a fresh-browser replay comes out on Repaired
  Steps for Sign Steps. A UiPath import also returns the rest of the bot as an n8n workflow file, in which each browser
  sequence has AI Repair on and sends its repairs to approval.
  - An imported sign-in keeps a "Stay signed in?" answer (No, Yes or "Don't show this again") in the login block, and a
    code typed from a UiPath TOTP activity becomes the sign-in's code (the Site Login's authenticator types a fresh one).
  - With an Expected File, a dialog's confirming click (Continue, OK, Save) that ends the recording after the export
    click, with no address change or URL check between them, becomes the download.
- **Two-page sign-ins**: `signIn.next` for identity-first sign-ins (email, Next, password, as Microsoft Entra and Okta
  do); the agent and the importers build it. A rejected username is `login_failed` when the site sends the username
  page back; an inline error on the same page times out as drift, and AI repair is not attempted once the username was
  typed.
- **Self-healing downloads**: download steps can declare file checks (name, type, columns, rows), enforced on every run;
  AI repair of steps that download one checked file; **Expected File** for a first run; the file's facts as evidence in
  the review and checked by Sign Steps.
  - File checks find the header in the first 10 non-empty rows, and the CSV delimiter is the one with consistent
    per-line counts (semicolon files with decimal commas work).
  - A repair keeps the click of a failed download trigger that opened a dialog (for example an Export → format popup),
    shown in the change list as "Open <trigger>". When the agent itself tries a download on such a control and the
    click opens a dialog without a file, the click is kept as a successful click before the agent's dialog steps.
  - Downloads refuse a Chrome DevTools Protocol (CDP) browser connection up front with a configuration error: CDP
    cannot read downloaded files.
- **Requests That Only Read** on the Site Login: POSTs that only read (for example an OData `$batch` or a report
  screen's postback) pass in every run, are never counted as writes, and are listed in the review evidence.
- **Repairs**: typed filter values that equal one run variable compile to `{{var.*}}`, and the agent's prompt carries the
  run's variable names and masked values. Repairs no longer propose `#id` fallbacks on generated ids (SAP, UI5, React,
  Ember, hex salts) or `href` fallbacks carrying a session segment. A repair fills each field once. The agent sees what
  a field already holds, but never a value on a login page or in a credential-class field. Proofs open the work's entry
  page with the reused session, so sites that keep window state on the server (such as SAP GUI for HTML) prove.
- **Approval**: the approval text renders every value on one line and quotes values that could fake a clause. A pending
  Repaired steps item with an unsafe value, or a download step with no checks (shown as `checks: no checks`), is refused at Sign
  Steps once and must be produced again. When "RPA: 3 Approve steps" activates a version, older `active` rows of the
  same name become `superseded`.
- **Queue mode**: with several n8n workers, an **RPA Redis** credential on Run Steps shares the login breaker and the
  run lock between them; a lock left by a worker that died frees itself. In queue mode, Run Steps with a Site Login
  and no Redis credential is a configuration error.
- **Browser service**: runs wait up to 60 s for a free browser session, then fail `browser_unavailable` with "no free
  browser session"; the credential test passes when every session is busy. With Slow Motion on, a live view shows the
  running step in Browser Server mode too.
- **Step schema**: a JSON Schema of the step document (`dist/schema/steps.schema.json`) for editor autocomplete.
- **Templates**: Hello world, "RPA: 0 Connection check" (proves the browser reaches your site), the self-healing data
  feed (create tables, the feed, approve repaired steps) and "RPA: 5 Import a bot" (a form in front of Import Steps,
  with approval through "RPA: 3 Approve steps").
- **Safety**: a per-run site allowlist, checked on every redirect hop before the browser sends it, private networks
  blocked by default, writes only where steps declare them, a login breaker and a run lock per Site Login, scrubbed
  browser traces.
- **Browser connections**: a browser server over the Playwright protocol (such as Browserless or the `rpa-browser`
  image), Chrome DevTools Protocol, or a local browser for development. Slow Motion for live views and debugging.

### The browser service

- **The `rpa-browser` image**: Playwright's run-server behind a token gate, with a supervisor under tini. A session
  limit per replica (`503` busy), `/healthz`, Prometheus metrics on port 9464, drain on stop, and optional ECS task
  protection and CloudWatch EMF metrics. Published to GHCR for linux/amd64 and linux/arm64 with a build attestation.
- **Helm chart** `deploy/helm/rpa-browser` (KEDA, CPU or fixed scaling; NetworkPolicy; optional Cilium FQDN policy) and
  **Terraform modules** `k8s-browser` and `aws-ecs-browser`, with eks-attach, ecs-attach and EKS-managed
  (`terraform-aws-n8n`) examples. The token never enters Terraform state.
- `deploy/scripts/configure-n8n.mjs` creates the RPA Browser credential and imports the templates through n8n's public
  API; runbooks for Kubernetes and Amazon ECS in `docs/deploy/`.

### Sandbox (repository only, not in the package)

- The sandbox site gained an SAP look-alike (a classic web GUI and a Fiori list report), a realistic mode with an SAP
  logon, SAP GUI for HTML and an OpenUI5 Fiori app, single sign-on with MFA in front of it (`SANDBOX_SAP_LOGIN=sso`),
  and an identity-first mode (`SANDBOX_SAP_LOGIN=sso2`, with an optional "Stay signed in?" page, `IDP_KMSI`), with an
  onboarding runbook in `docs/onboarding/`.
