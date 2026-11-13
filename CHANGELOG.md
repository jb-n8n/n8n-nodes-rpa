# Changelog

All notable changes to `n8n-nodes-rpa`, the `rpa-browser` image and the Windows package. Versions follow
[Semantic Versioning](https://semver.org/); until 1.0, a minor version may change behavior. The node is released with
`v<version>` tags, the image with `browser-v<version>` tags, the Windows package with `desktop-v<version>` tags.

## Unreleased

### Added

- **A sample bot for the first browser bot**: [docs/samples/sandbox-line-items.steps.json](docs/samples/sandbox-line-items.steps.json), a step document that signs in to the compose stack's sample site and exports a report as a CSV file. The browser bot guide now starts with it: the setup command with `--browser-url`, a Site Login, the import form, approve, run. No chat model or email server is needed until its second part, where a bot repairs itself. Tried on n8n 2.45.3.
- **One bot, many accounts**: a guide ([docs/guides/many-accounts.md](docs/guides/many-accounts.md)) for a bot that signs in to one site with many accounts. One RPA Site Login whose username and password are expressions on the items, one approval and one workflow serve every account. Tried on n8n 2.45.3 with three accounts of the sample site.
- **Set up the import form in one command**: `npx n8n-nodes-rpa setup` creates the RPA Step Signing key and, with a Connection Line, the RPA Desktop Runner credential, then imports and publishes **RPA: 5 Import a bot** with your n8n address as the approver (the API key's owner when n8n tells it, or `--approver`). It prints the form's address, and reuses what it made when run again. `--form-login basic` gives the form a user name and password instead of n8n's sign-in, printed once. Its last line is about the API key you gave: what it can do, when it expires, and to revoke it in n8n when the setup is done (**Settings → n8n API**, the key's **⋯** menu, **Revoke**). Its words follow n8n's own labels: **Create API key**, **Allow access**, **Revoke**.
- **Open the import form** in the RPA Recorder: after saving, it opens n8n's **Import a bot** form in the browser and puts the recording's path on the clipboard, to paste in the form's file box. It asks for the form's address once. The recorder uploads nothing and holds no login.
- **The RPA Recorder** on the Windows machine (Start menu: **RPA Recorder**). It records a person's work in a Windows app as steps, asks once after **Finish** which values change from run to run, saves to `Documents\RPA recordings`, and allows the recorded app with one button (**Allow this app…**). It does not read password boxes. Tried on WinForms and Win32 apps.
- **Install in one command**: `.\Get-Rpa.ps1 -AllowFrom <n8n address>` downloads the Windows package, checks its SHA-256 (and its build attestation where the GitHub CLI is signed in), unpacks it under `C:\Program Files\RPA package\<version>` and runs the installer.
- **The `rpa` command** in `C:\Program Files\RPA Runner\rpa.cmd`: `rpa connection [-ShowTokens] [-Address …]`, `rpa status`, `rpa policy apply <file>`.
- **Nobody signed in**: `-Unattended` on Windows Server 2019 or later. A service, the RPA Supervisor, signs the bot user in for each run and out afterwards.
- **A Connection Line** field on the RPA Desktop Runner and RPA Browser credentials: paste the one line `rpa connection -ShowTokens` prints. The separate fields still work.
- **RPA Secret Variables**, a credential for passwords and other secrets that steps type as `{{var.name}}`. Run Steps masks its values everywhere, and only signed steps type them.
- **Approve on the import form**: **RPA: 5 Import a bot** shows each imported step list on a review page, with the steps that save or send as tick boxes, and signs what you approve. Approval by email stays as an option.
- **Every import ends in a workflow that runs the bot**, for every source. A recording's variables start with the recorded values. **Import Steps** works out the source from the file, takes a step document (steps you wrote), and takes a One-Time Code Workflow.
- New steps: browser `press`, `hover`, a `click` with `modifiers`, `when` on a hidden element or a variable, a `signIn` that sets a new password the site forces (`changePassword`, with the new error code `password_change_failed`), and the desktop `doubleClick`. UiPath imports now walk Retry Scope, Try Catch, While, Switch, Flowchart and State Machine bodies.
- **The workflow the import form hands over has its RPA credentials picked**: each **Run steps** carries the credentials the import used, by name and id (never a value). Import Steps has two slots it never reads, **RPA Step Signing** and **RPA Desktop Runner** "only passed on to the workflow file", and the setup command fills them. In another n8n, n8n takes the only credential of the same name, or asks for one.
- **The workflow the import form hands over keeps a run log**: every run writes a row to `playwright_runs` (made when missing), with the error code when it failed. A failed run still ends as failed under **Executions**, so an Error Workflow set in the workflow's settings runs.
- **A UiPath project's values become start values**: a variable that desktop steps type or choose starts, in the generated workflow, with its argument's default or what the invoking workflow passes in. Never for a secret (in any letter case), a name like a password, PIN, secret or token, a value of the RPA Site Login, or a value the import removed as a secret.
- **Change an approved bot, or sign it again, on the import form.** Leave **Bot file** empty on **RPA: 5 Import a bot** and type the bot's name: the next page shows the steps that run now in a box. Change them, or leave them as they are to sign them again after the signing key changed. **Review** opens the same review page as an import, and Sign Steps checks them as it checks an import. Approved, they become a new row that supersedes the old one. Rejected, the old one keeps running. This replaces copying the `steps` value out of the Data Table into a file. The page says who can open it, and that it cannot tell steps signed with an older key from steps changed in the Data Table.
- **Third-party notices in the Windows zips.** Each zip lists the third-party software it ships, with versions and licences, and carries their licence and notice texts, which the build copies from the components: the package in `THIRD-PARTY-NOTICES.md` and `licenses\` at its top (the .NET runtime, FlaUI and the Microsoft packages), the browser package in `browser\THIRD-PARTY-NOTICES.md` and `browser\licenses\` (Node.js, Playwright, Chrome for Testing and Chrome Headless Shell, Playwright's winldd). An install without the browser has the package's only, and `-NoBrowser` removes the browser's with its files. Node's licence moved there from `browser\LICENSE-node.txt`. Playwright's ffmpeg build, which Playwright uses only to record video, is no longer in the browser package. Nothing in RPA records video. The repository has a `THIRD-PARTY-NOTICES.md` with a section for each zip, which also covers the browser image and the npm package.

### Changed

- **The sample bots read as their steps, and the rows sample returns whole rows.** Each step's description in [docs/samples](docs/samples) is the sentence the review page builds for it, so the review page shows no description in brackets for them. The rows sample reads the notices table: each row has its ID, date, type, models and summary, not the ID alone.
- **The Connection Line carries an address n8n can use.** Without `-Address`, `rpa connection` (and the installer's closing lines with `-Unattended`) puts in the line the address this machine has on its route to the one n8n address given with `-AllowFrom`. It looks the route up in this machine's own routing table and sends nothing. With several addresses, a range, any address, a loopback address or no route, the line carries the computer's name as before. A new line says which address the line carries and how to choose another with `-Address`.
- **The setup command picks your Site Login and the private-network switch**: `--site-login <name>` sets an RPA Site Login you made in n8n, found by its name in the command's project, on **Import steps** and **Sign steps**. The command never makes a Site Login or reads its values. `--allow-private-network` turns on **Allow Private Network** on **Import steps**. Both apply when the command makes the workflow. One that is there already is left as it is, and the command says what to set on it. The browser bot guide now makes the Site Login first and has no step that opens the import workflow: five steps to a first bot instead of six.
- **A browser bot that reads rows can be approved on the import form.** A step document whose `extract` and `extractTable` steps state their `idPattern` is checked with it at import, so the form asks for nothing more, and the workflow it hands over runs with the same **ID Pattern** on **Run steps**. Without one, the refusal says to add it to each of those steps. The form's last page now says why a step list could not be proved. A second sample, [docs/samples/sandbox-rows.steps.json](docs/samples/sandbox-rows.steps.json), reads the sample site's notices.
- **Runs On** on Run Steps and Import Steps chooses which credential slots the node shows: **A browser**, **A Windows desktop app**, or **Browser and desktop apps** (the default, every slot as before, so saved nodes keep their credentials). The steps still decide where they run. The workflow an import makes sets it on each **Run steps**, so a desktop bot shows three slots.
- **The login breaker, the run lock and the block after a password change are kept per account** (the Site Login and the username). With a username set by an expression, one account's wrong password, run or password change no longer stops the other accounts. A breaker that opened in 0.2.0 or earlier still stops every account until the reset key changes. After a password change the message says `The password of this account was changed earlier in this execution`.
- **Sign Steps** signs with a Site Login whose username and password are empty, as they are on an approval item when they are expressions on the account items. Run Steps and Import Steps still need both.
- **The desktop runner asks the apps to close before it stops them.** When a run ends, it sends each launched app a close request (like the close button, with no typing, clicking or answering), waits up to 3 seconds in total, then stops what is still running as before. `run.end` now answers at once and the cleanup goes on after it. The log says how each app ended.
- **The import form opens with n8n's sign-in, and records who approved.** **RPA: 5 Import a bot** uses the Form Trigger's n8n User Auth, for n8n users who may run the workflow. The person who imports a bot approves it on the form, and **Sign steps** records the n8n user who submitted the review page. That user must be on **Sign steps → Approver Allowlist**: nobody signed in, or a user not on the list, signs nothing. Tried on n8n 2.45.3. Set `approval` to `by email` in the template's **Settings** for a second person. Template 5's **Approve steps** node ships switched off. Template 3's **Settings** now holds `approver`.
- **Basic Auth on the import form is the option** for approvers with no n8n account: set **Authentication** to Basic Auth on **Import a bot**, or run the setup command with `--form-login basic`. **Sign steps** then records the address on the allowlist, as before. With Basic Auth, the form's pages after the first are not behind the password: anyone who has a page's address can open and submit it (tried on n8n 2.45.3).
- **Sign Steps' Approver**: **Approved By** (the default, as before) or **Who Signed In to n8n on the Approval Form**, which reads the n8n user on the form page named in **Approval Form Page**, never a form field.
- **Sign Steps' Approved By** may be empty when the **Approver Allowlist** holds exactly one address.
- **Windows Server installs are unattended by default**: a first install for a new bot user with no sign-in mode is an `-Unattended` install, where it was refused before.
- **The Windows package installs no browser by default.** To have the browser on the Windows machine, add `-WithBrowser`: it comes in a second zip, `rpa-browser-windows-x64.zip`, which `Get-Rpa.ps1 -WithBrowser` gets for you, also later, into the package folder of a version unpacked already. An upgrade keeps the browser an install has, and `-NoBrowser` removes it.
- **One-Time Code Workflow** is n8n's workflow picker, and it must be set directly: an expression is now refused. Workflows saved with a typed ID keep working.
- **Desktop approval texts.** Evidence lines end `mark each step that saves, posts or submits as a write`, and Sign Steps writes `Signed as writes: none` when none was marked. A desktop Repaired steps item made before this change is refused: import it again.
- **Messages.** A step list that does not parse reads `invalid steps: …` (was `invalid script: …`). A blocked request names its method, host and path and where to allow it. A failed desktop step starts with its number and intent. Guidance texts are shorter.
- A recording keeps the Name you typed (no `-1`). A UiPath project keeps `-1`, `-2`.
- A generated workflow's browser **Run steps** has AI Repair off, also for UiPath projects. Its note says how to turn self-repair on.
- After `login_failed`, a corrected username, password or TOTP Secret gets one try without a new **Login Breaker Reset Key**.
- **Max Seconds** may be up to 600 (was 300), and a browser step's `timeoutMs` up to 300000.
- n8n waits up to 60 seconds for a desktop runner, and tries once more when the connection drops during its TLS handshake.
- `RpaPolicy.exe apply` takes the change file from where it is: it copies it into `C:\ProgramData\RPA Runner\policy-changes\` first. No need to copy it by hand.
- The README and the guides are rewritten around three ways in. The reference moved to `docs/reference/`.
- **RPA Recorder**: a value becomes a variable on the page after **Finish** only (**Make variable…** left the bar, and **Back** before saving returns to that page), the top line says `Almost done` on that page and `Saved` after saving, and the bar logs its stages and buttons to `%LOCALAPPDATA%\RPA Recorder\bar.log`.

### Removed

- **The template `RPA: 1 Create tables`.** Templates 2, 3 and 5 create the Data Tables when they are missing, and `deploy/scripts/configure-n8n.mjs` no longer imports it.

### Fixed

- **RPA Recorder**: a file saved through a Save dialog under the name it offers now comes back to n8n, as a typed name does. Before, the run saved it in the bot user's Documents folder and returned no file.
- An installer run in the seconds after an unattended install, while the bot user's session waits to be signed out and no run holds the runner, says so and how long it stays, instead of "a run in progress will fail".
- `Get-Rpa.ps1 -Zip` and `rpa policy apply` read a relative path from PowerShell's current folder, not from `C:\Windows\system32`.
- The recorder's bar keeps six rows of steps in Finished and Saved, and its step buttons fit one row at 360 wide.
- A desktop locator that matches several elements fails after 3 seconds instead of at the step's timeout, and says what to add.
- A WinForms list row is found by its name, not its position.
- Sign Steps signs a declared `submit` on the start site without a Site Login, as Run Steps runs it.
- **RPA: 5 Import a bot** asks about the file it downloads for a UiPath project too. A UiPath browser bot that downloads a file can now be approved: before, its export stayed a click and nothing could be signed.
- A workflow generated by an import that had **Allow Private Network** on has it on in its browser **Run steps** too, so its first run on a site on your own network no longer fails with a private-network refusal.
- A desktop step document that types a variable into a password field treats it as a secret, as a recording does: the generated workflow gets no empty plain variable for it, and the review page no longer ticks the key pressed in that field as a write.

### Security

- **RPA: 5 Import a bot** refuses an address that carries values (anything after `?`) before anything is read or imported: n8n fills the fields of every page of a form from that address, the review page's decision and write ticks too.
- A secret variable or a secret fill's value is masked in screenshots, and a screenshot or PDF of a page that shows one is refused.
- A sign-in judges a login form by its own action, and a refusal names the address to list under **Pages Where the Password May Be Typed**.
- `policy-changes\` is created for administrators only and refused when it is a link or someone else owns it.
- The secret variables credential is not bound to the signed steps: share it only with people who may approve imports ([Security](docs/reference/security.md#secret-variables)).
- The review page words each browser step from the step itself (its action, target and value) and shows the author's description beside it when it says something else.
- The approval email for desktop steps words each step as the review page does, from the step itself. Sign Steps refuses when the step sentences shown for approval differ from the steps it signs.
- **May Be Typed Into** on the RPA Secret Variables credential, optional: the apps (`ErpDemo.exe`) and site hosts (`erp.example.com`) its values may be typed into, one per line. Filled, a desktop run of an app not listed is refused before the app starts, and a browser step is refused before it types one of the values on a page or frame whose host is not listed (`policy_violation`). Empty, nothing changes.

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
