# Changelog

All notable changes to `n8n-nodes-rpa`, the `rpa-browser` image and the Windows package. Versions follow
[Semantic Versioning](https://semver.org/); until 1.0, a minor version may change behavior. The node is released with
`v<version>` tags, the image with `browser-v<version>` tags, the Windows package with `desktop-v<version>` tags.

## 0.2.0 (YYYY-MM-DD)

The node `n8n-nodes-rpa` 0.2.0, the image `ghcr.io/jb-n8n/rpa-browser:0.2.0` (Playwright 1.63.0), and the first
Windows package: the GitHub Release `desktop-v0.2.0` with `rpa-windows-x64.zip`, `rpa-browser-windows-x64.zip` and
`Get-Rpa.ps1`, each with its SHA-256 and a build attestation (not code-signed).
[`docs/install/windows.md`](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/install/windows.md) is the install
guide, and [`docs/install/licensing.md`](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/install/licensing.md)
a note on what Microsoft's terms say about unattended automation on Windows (not legal advice). Tried on n8n 2.45.3.
Coming from 0.1.0, read [Upgrading from 0.1.0](#upgrading-from-010) first.

### New: Windows desktop bots

- **Desktop steps** (`"surface": "desktop"`): Run Steps drives a Windows app through the RPA desktop runner, with the new **RPA Desktop Runner** credential. UI Automation locators, and the verbs `click`, `doubleClick`, `fill`, `select`, `check`, `waitFor`, `read` (also of the clipboard), `key` and `expectFile` (a file the app saved, returned to n8n like a download). They are signed and approved like browser steps, with the steps that save, post or submit marked as writes.
- **The Windows package**: the desktop runner (`RpaRunner.exe`, TLS and a token), the policy tool (`RpaPolicy.exe`), the **RPA Recorder**, the **RPA Supervisor** service and the ERP Demo sample app, for Windows Server 2019 or later (Windows 10 1809 and 11 with automatic sign-in or a person signed in).
- **Install in one command**: `.\Get-Rpa.ps1 -AllowFrom <n8n address>` downloads the package, checks its SHA-256 (and its build attestation where the GitHub CLI is signed in), unpacks it under `C:\Program Files\RPA package\<version>` and runs the installer, which lists what it changes and asks for `YES`.
- **Nobody signed in**: on Windows Server a new bot user is unattended by default (`-Unattended`). The RPA Supervisor signs the bot user in when n8n connects and out after it. `-AutoSignIn` and signing in by hand are the other modes.
- **A local policy** on the Windows machine, which only administrators change, lists the apps the runner may start and the buttons and keys that count as writes. The policy tool shows a change in plain lines and applies it after an administrator says yes.
- **The RPA Recorder** records a person's work in a Windows app as steps, asks after **Finish** which values change from run to run, and saves to `Documents\RPA recordings`. **Allow this app…** allows the app and protects the buttons the recording clicked that save, post or submit, in one question; for an app allowed before, the question says that bots approved earlier stop at those buttons unless that step was ticked as a write. **Open the import form** opens n8n's form with the recording's path on the clipboard. The recorder does not read password boxes, uploads nothing and holds no login. Tried on WinForms and Win32 apps.
- **The `rpa` command** (`C:\Program Files\RPA Runner\rpa.cmd`): `rpa connection [-ShowTokens] [-Address …]` prints the **Connection Line**, one line with the address, token and fingerprint that n8n needs; `rpa status`; `rpa policy apply <file>`.
- **The Connection Line's address**: without `-Address`, the one this machine has on its route to n8n when `-AllowFrom` names one address, else the computer's name. Behind a NAT the installer asks once for the name or address n8n can reach, and `rpa connection` and upgrades keep it.
- **A browser on the Windows machine**, only with `-WithBrowser`: Chromium behind a token gate with its own certificate, in the second zip. Adding or removing it lists what changes and asks for `YES`; an upgrade keeps it or its absence.
- **Third-party notices** in each zip: its section of `THIRD-PARTY-NOTICES.md` and the licence texts of what it ships, copied from the components by the build. Playwright's FFmpeg build is not shipped: nothing in RPA records video.
- **The desktop test bed**: `deploy/terraform/modules/aws-ec2-desktop-runner` runs the package on a Windows Server 2022 VM on EC2.

### New: set up, import and approve

- **The setup command**, `n8n-nodes-rpa setup` (the package's bin): it makes the **RPA Step Signing** key, with a Connection Line the **RPA Desktop Runner** credential, and imports and publishes **RPA: 5 Import a bot** at `/form/rpa-import` (an address with an id when another form has that one). Run where n8n runs, as n8n's user, it needs no API key: it works through n8n's own command line, after checking that it reaches the running n8n's database. Elsewhere, or with `--api-key`, it uses n8n's public API and an API key.
- **Setup options**: `--approver`, `--form-login basic` (a user name and password instead of n8n's sign-in), `--site-login <name>` and `--allow-private-network` for **Import steps** and **Sign steps**, `--desktop-runner <name>`, `--signing-key <name>` when your project has several RPA Step Signing credentials, and `--new-workflow --site-login <name>` for a second form, that Site Login's own, at an address of its own.
- **Setup run again** reuses what your project owns (its RPA Step Signing and RPA Browser whatever their names), asks before it replaces a Connection Line, lists how a form it made, or RPA 0.1.0 made, differs from this version's template and asks `Update this form to this version? (y/N)`, and ends by saying whether the Windows machine is connected (n8n's command line cannot test it, and the command says so), and what to do.
- **Approve on the import form**: **RPA: 5 Import a bot** opens with n8n's sign-in, shows each imported step list on a review page and signs what you approve, recording the n8n user who approved, who must be on **Sign steps → Approver Allowlist**. Approval by email (template 3) stays an option for a second person (`approval` in the template's **Settings**).
- **The review page** shows each step as a sentence built from the step itself (its action, target and value), the author's description beside it (grey, or red when it names another action, another site or a value the step does not hold), the Site Login it signs for, a mark on a step that finds its control by its row or place, and the steps that save, post or submit as tick boxes.
- **Every import ends in a workflow that runs the bot**, for every source: a UiPath project, a Chrome Recorder export, Playwright code, an RPA recording or a step document (steps you wrote). **Import Steps** works out the source from the file.
- **The workflow the form hands over** has its RPA credentials picked (by name and id, never a value), reads the active steps from `playwright_steps` each run, writes a run log row to `playwright_runs` (with the code, message, guidance, returned file and account), ends a failed run as failed so an Error Workflow runs, names the form that made it, and says in its notes what to set. For a bot that types a secret, the last page and the notes say what goes into **RPA Secret Variables**.
- **Change an approved bot, or sign it again**, on its form: leave **Bot file** empty and type the bot's name, then choose **Sign the approved steps again, unchanged**, **Change values** (a page of fields, one per value the steps type, choose or open, up to 40) or **Change the steps as JSON**. The review page lists what changed (old → new values, steps added, removed and moved) and warns when the approved version's signature does not fit this form's key and Site Login.
- **Versions**: an approved change is the next version (the review page and the last page say `version 2, replacing version 1`), a version number is used once, one approval per version signs, and two approvals at the same moment leave the last one running. A file uploaded under a running bot's name is its next version too.
- **A UiPath project's values become start values** of the generated workflow (never a secret, a password-like name or a Site Login value), and UiPath imports walk Retry Scope, Try Catch, While, Switch, Flowchart and State Machine bodies.
- **Sample bots** for the sample site ([docs/samples](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/samples)), and guides for a first browser bot, a first desktop bot, recording, moving a bot and [one bot with many accounts](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/guides/many-accounts.md).

### New: in the node

- **RPA node version 2**: a new node starts with **Runs On** at **A browser** (four credential slots on Run Steps), shows RPA Redis only with **Share Login Breaker Across Workers (RPA Redis)** on, and has Signature and Approved By on its Settings tab. A saved version 1 node keeps version 1 and shows, keeps and runs what it did. The templates and the generated workflows use version 2.
- **Runs On** on Run Steps and Import Steps chooses which credential slots the node shows: **A browser**, **A Windows desktop app**, or **Browser and desktop apps** (version 1's default).
- **RPA Secret Variables**, a credential for passwords and other secrets that steps type as `{{var.name}}`: masked everywhere, typed only by signed steps, and, with **May Be Typed Into** filled, only into the apps and site hosts it lists.
- **New browser steps and options**: `press`, `hover`, a `click` with `modifiers`, `when` on a hidden element or a variable, `fill.secret`, a `select` of several values, `{{var.name}}` in a locator's name or text (not in a step that writes or signs in), and a `signIn` that sets a new password the site forces (`changePassword`, error code `password_change_failed`).
- **One-time code from a workflow**: a sign-in's `totp` with `"source": "workflow"` types the code that **Options → One-Time Code Workflow** returns (for a code from an email or an app); `totp.via` and `totp.check` click through a factor choice and tick boxes such as "Trust this browser".
- **One Site Login, many accounts**: with the username as an expression on the items, the login breaker, the run lock and the block after a password change are kept per account, and a run's item carries `account`, the user name it signed in with (never the password).
- **A control that is not there says what the page shows instead**: the message lists the page's visible links and buttons, or its fields, nearest in name first, and the error item carries them in `details.missingControls`.
- **Sign Steps**: **Approver** can be **Who Signed In to n8n on the Approval Form**; **Approved By** may be empty when the Approver Allowlist holds one address; **Check Only** checks an approved version's signature without signing.
- **The RPA Browser credential**: **Certificate Fingerprint (SHA-256)** for a `wss://` browser server with a self-signed certificate (checked before the token is sent), and a **Connection Line** field. The `rpa-browser` image's gate can serve TLS, read its token from a file and listen on a chosen address: the 0.1.0 image does not read these settings.
- **New error code** `runner_unavailable`; `busy` also means a desktop runner busy with another run. A failure's guidance is on its error item too (`details.guidance`).

### Changed

- **The template `RPA: 1 Create tables` is gone.** Templates 2, 3 and 5 and the generated workflows make the Data Tables when they are missing.
- **RPA: 3 Approve steps** asks for approval of desktop steps too, says `version N`, and lists the steps as sentences built from the steps; Sign Steps refuses when those sentences differ from the steps it signs.
- **A generated workflow's browser Run steps has AI Repair off**, also for UiPath projects (0.1.0 had it on); its note says how to turn self-repair on.
- **After `login_failed`**, a corrected username, password or TOTP Secret gets one try without a new **Login Breaker Reset Key**.
- **Max Seconds** may be up to 600 (was 300), and a browser step's `timeoutMs` up to 300000 (was 120000).
- **Messages**: a step list that does not parse reads `invalid steps: …` (was `invalid script: …`); a blocked request names its method, host and path and where to allow it; a site the browser cannot reach and a value a field refuses are said in plain words (the latter is `policy_violation`); `locked_out` says "this account"; guidance is shorter and fits its cause.
- **The RPA Browser credential is no longer marked required** on the node: desktop steps run without it. A browser operation without it fails with `This operation runs in a browser: attach an RPA Browser credential.`
- **The RPA Site Login's Forms It May Submit and Requests That Only Read take no expression**, as its sites and pages do.
- **The compose stack** runs n8n 2.45.3 (0.1.0: 2.41.0), builds the package in a `node:26-alpine` stage, runs Mailpit 1.32 with its mail in the `mailpit_data` volume, and sets `N8N_WEBHOOK_URL` (n8n 2.45 warns that `WEBHOOK_URL` is deprecated).
- The README and the guides are rewritten around three ways in; the reference moved to `docs/reference/`.

### Fixed

- **A rejected password is `login_failed`** without a `detect` step: when the site sends the password page back, the step fails and the login breaker opens. In 0.1.0 the run passed the sign-in and failed later as drift, and AI Repair then tried to repair it.
- **Import Steps drops a recorded password from fields named in other languages** (Kennwort, contraseña, mot de passe, パスワード and more) and from a field named `pass`. Passenger, passport, compass and bypass fields are no longer taken for password fields.
- **A `paginate` whose body holds a `submit` or a `download`** takes no `{{var.name}}` in its own `when`, `expect` or `next`: they decide how often the write runs.
- **A UiPath browser bot that downloads a file** can be approved: the import form asks about the file it downloads. A generated workflow keeps **Allow Private Network** when the import had it on.
- **The approval emails say that the evidence and the change list are as reported by the run**; Sign Steps recomputes the safety flags from the steps.
- **Allow Unsigned Writes** and the README say what the switch hands over: unsigned steps may sign in, so whoever can set the steps drives the Site Login.

### Security

- **Template 3's approval emails show step and page text as text.** n8n's send-and-wait email turns `&lt;`, `&gt;`, `&amp;` and quotes back into characters, so a name, a step, a value, the evidence or the change list holding markup could show in 0.1.0's approval email as a link or an image. Template 3 now writes `<`, `>` and `&` in that text as `‹`, `›` and `＆`, and an address in step text is not a link. Sign Steps still checked what it signed. Import template 3 again after the upgrade.
- **RPA: 5 Import a bot** refuses an address that carries values (anything after `?`) before anything is read: n8n fills a form's fields from its address.
- A secret variable's value is masked in screenshots, and a screenshot or PDF of a page that shows one is refused.
- A sign-in judges a login form by its own action, and a refusal names the address to list under **Pages Where the Password May Be Typed**.
- With Basic Auth on the import form, the form's pages after the first are not behind the password: anyone who has a page's address can open and submit it.
- The RPA Secret Variables credential is not bound to the signed steps: share it only with people who may approve imports ([Security](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/security.md#secret-variables)).

### Upgrading from 0.1.0

Nothing stored is renamed: the node type `playwright`, the four 0.1.0 credential types and their fields, the Data Tables
`playwright_steps` and `playwright_runs`, and the signatures of approved browser steps are read as before. In this order:

1. **Before you upgrade, answer every approval email that is still open**: approve or reject it in **RPA: 3 Approve
   steps**. The 0.1.0 compose stack's Mailpit keeps no mail, so the upgrade deletes open approval emails. An approval
   answered after the upgrade is still signed, but one whose email is gone can only expire (after `approvalTimeoutHours`
   in template 3's **Settings**, 72 by default), and until then the data feed reports a changed site instead of
   repairing it. From this version on, Mailpit keeps its mail in the `mailpit_data` volume.
2. **Upgrade the node and the browser together.** On the compose stack: keep `.env`, update the repository, and run
   `docker compose up --build -d`. This moves n8n to 2.45.3 (from 2.41.0), builds the browser of this version and moves
   Mailpit to 1.32. Your workflows, credentials, Data Tables and login breakers are kept. Sign in to n8n again
   afterwards. Elsewhere, use the image `rpa-browser:0.2.0`: the gate's TLS, token file and listen address need it.
3. **Your 0.1.0 workflows keep running.** Their RPA nodes stay at version 1 with their credentials, signed bots keep
   running on their schedule, and `playwright_runs` keeps its columns. A new RPA node is version 2. One exception: a
   Site Login whose **Forms It May Submit** or **Requests That Only Read** is set with an expression stops runs with a
   configuration error that names the field. Type the lists in again.
4. **A login breaker that opened in 0.1.0** still stops every account of that Site Login after the upgrade, even with
   the credential corrected: 0.1.0 kept it under the Site Login alone. Its message says so (`before the upgrade`).
   Type a new value in **Options → Login Breaker Reset Key** on the node to let the next run log in.
5. **Bots made by 0.1.0's import have no sign-in check.** In 0.1.0 a wrong password failed later, as a changed site.
   Now it fails `login_failed` at the sign-in and opens the breaker.
6. **Import templates 2 and 3 again**, as new workflows. Template 3 has the security fix above and shows each step as
   a sentence. The 0.1.0 template 3 keeps working, so nothing reminds you. In the new template 3, pick what its
   **Set once** note names: the SMTP credential on its email nodes, and on its RPA nodes the same RPA Step Signing and
   RPA Site Login your data feed uses. Point **Approve steps** in your data feed at the new template 3, then unpublish
   the 0.1.0 templates 3 and 2.
   Template 1 is gone: the templates create the Data Tables themselves, and use your 0.1.0 tables as they are.
7. **Set up the import form with the setup command**, or import template 5 again. The command uses your project's
   **RPA Step Signing** credential whatever its name (0.1.0 had n8n name it `RPA Step Signing account`), so your
   bots still fit the form; it names the credential in its last lines. With several, it asks which one, or takes
   `--signing-key "<its name>"`. It reuses your **RPA Browser** the same way.
8. **The 0.1.0 form**: with 0.1.0's **RPA: 5 Import a bot** in your project, the command says that RPA 0.1.0 made
   it, lists what was changed in it by hand since, and asks `Update this form to this version? (y/N)`. `y` keeps
   its address, title, the credentials picked on its nodes, Allow Private Network and the workflow on Approve steps,
   and its new **Sign steps** signs with your key for the Site Login on **Import steps**. Its sign-in becomes n8n's
   sign-in; add `--form-login basic` to keep its Basic Auth login. Imports are then approved on the form; its sticky
   **Approval by email** says how to send them to template 3 instead. Without a terminal it asks nothing and changes
   nothing. An archived workflow is not counted.
9. **Queue mode**: on a version 2 node, turn on **Share Login Breaker Across Workers (RPA Redis)** before you can pick
   RPA Redis. Version 1 nodes keep their RPA Redis credential.
10. **Workflows the import form makes** write their run log to the `playwright_runs` table you have. A table made by
    0.1.0 has no `account` column, so that value is not logged there
    ([Data Tables](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/templates.md#data-tables)).

## 0.1.0 (2026-10-28)

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
