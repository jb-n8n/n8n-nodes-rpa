# Changelog

All notable changes to `n8n-nodes-rpa`, the `rpa-browser` image and the Windows package. Versions follow
[Semantic Versioning](https://semver.org/); until 1.0, a minor version may change behavior. The node is released with
`v<version>` tags, the image with `browser-v<version>` tags, the Windows package with `desktop-v<version>` tags.

## Unreleased

- RPA Desktop Runner and RPA Browser credentials: a **Connection Line** field. Paste the one line the Windows installer prints at its end for the runner (`rpa-runner://<address>:<port>/rpa/v1#token=<token>&fingerprint=<64 hex digits>`) or for the browser (`rpa-browser://<address>:<port>/#token=…&fingerprint=…`); `Show-RpaConnection.ps1 -ShowTokens` prints them again. When the line is filled, the node takes the address, the token and the certificate fingerprint from it and does not use the separate fields (Runner URL, Token and Certificate Fingerprint; Endpoint URL, Token and Certificate Fingerprint in Browser Server mode); when it is empty, everything works as before, and the separate fields are no longer required on their own. The line holds the token: it is a password-type field that takes no expression, and no message repeats it. A line of the wrong kind, a missing part, a port outside 1 to 65535, a fingerprint that is not 64 hex digits (pairs joined by colons are accepted, as in the fingerprint field) or the installer's hidden token (`token=<hidden…>`, printed without `-ShowTokens`) is a configuration error that says what is wrong and what to do. The certificate fingerprint check itself is unchanged. The credentials' Test button works with the line alone.
- A new credential, **RPA Secret Variables** (`rpaSecretVariablesApi`): name and value pairs, each value a password-type field, attached to Run Steps. Run Steps adds them to the run variables as secret variables, for browser and desktop runs alike. A secret variable's value is masked from the start of the run, whether or not a step uses it: in the Data and error items, the step log, messages, traces, the text of failure and step screenshots, and what the chat model sees (page text and the variables in its prompt). Only signed steps type one: in the browser a fill with `secret: true` (as before), on the desktop a fill whose value is exactly `{{var.name}}`; unsigned desktop steps that would type one fail `policy_violation` (`Unsigned steps cannot type a secret variable. …`). Any other use of the value, such as a plain fill, a locator, a select option, a URL, text around the template or a `when` condition on it, is refused with `an input value contains a credential secret`. A value shorter than 4 characters is refused (a value that short cannot be masked without also hiding ordinary text: put it in Options → Variables if it is not secret), as is a name given both there and in Options → Variables; these messages name the variable, never its value. A value that is also a Site Login secret is masked but never typed by a secret fill. The credential's Test button checks the names and values and lists the names. A run that stops on a variable nobody supplied still fails with `missing input "<name>"`, now followed by `(a secret goes in an RPA Secret Variables credential, any other value in Options → Variables)`.
- With a secret variable or a value a browser secret fill types (also from Options → Variables), a screenshot step now masks the form fields and the text of those values, and a screenshot or PDF of a page that shows one is refused (`the page shows a credential`), as it already was with a Site Login.
- Options → **One-Time Code Workflow** (Run Steps and Import Steps) is now n8n's workflow picker: pick the workflow from the list, or give its ID. A workflow saved with a typed ID keeps working. It must be set directly: an expression is now refused (`One-Time Code Workflow must be set directly, not with an expression.`), so item data never chooses which workflow the node runs.
- Windows package: the RPA recorder, `RpaRecorder.exe`, in the package's `recorder\` folder (the installer refuses a package without it). It watches a person work in a Windows app and saves a recording file for Import Steps (source **RPA Recording**) and a policy change file for `RpaPolicy.exe apply`; a field it recognises as a password box (by its password flag, or a name or id that reads like one) is not read, a value marked secret afterwards is removed from the list and the file, and Import Steps refuses a recording that still carries a value in such a field. Import Steps leaves out a recorded key that drives the Windows shell (such as Alt+Tab) and a choice of an empty item, each with a report line, and imports the rest. The Windows install guide has a new section 12, Recording a flow. Tried on WinForms and Win32 apps, not on WPF, WebView2 or apps that draw their own controls. Import Steps no longer shows Start URL, AI Repair, Goal and ID Pattern for the source RPA Recording, where they did nothing.
- A run may last up to 600 seconds (Max Seconds, was 300), and a browser step's `timeoutMs` may be 100 to 300000 (was 120000). A longer run holds its browser session and its Site Login lock for as long as it runs. A Windows run's Max Seconds also rises to 600, while a Windows step keeps its 120000 limit.
- A browser step's `when` may now also be `{ hidden: <locator> }` (run only when the element does not show) or a run variable compared with literal text, `{ var, equals }` or `{ var, notEquals }`; write the opposite condition on the next step in place of an else. A variable condition is refused on `signIn`, `submit`, `download`, a `paginate` that holds a `submit` or `download`, the click that opens a write window, and a variable that a secret `fill` types. Step lists signed before keep their signature and run as before; a list that uses the new forms is refused by 0.2.0.
- Two new browser steps and a click with keys held: `press` sends one key chord (`{ key, target? }`: Enter, Tab, Escape, Backspace, Delete, arrows, PageUp, PageDown, Home, End, F1 to F12, alone or after Ctrl, Alt and Shift, or Ctrl+A), `hover` moves the mouse over an element, and `modifiers` beside a `click` (`["Ctrl"]`, `["Shift"]`, `["Alt"]`) holds keys during it. A key that types a character, a paste and `{{var.name}}` in `key` are refused, and so is a `press` on a password field. `press` is not a declared write: an Enter that would post a form is refused like a click on its button, and an Enter that sends a search by GET passes. Step lists signed before keep their signature and run as before; a list that uses the new steps is refused by 0.2.0.
- Import Steps: a hover in Playwright code or a UiPath project (Hover) becomes a `hover` step, and a browser click with Ctrl, Shift or Alt held (UiPath KeyModifiers, or Playwright `click({ modifiers })` with `Control` or `ControlOrMeta` for Ctrl) becomes a `click` with `modifiers`. A UiPath browser click with the right or middle button, or with another key held, is reported as not translated; it used to import as a plain click. In Playwright code such a click is reported with its own reason in place of the general click-options note. The Chrome Recorder's hovers are still dropped, and Enter is imported as before.
- A `signIn` step can set a new password when the site forces one: `changePassword: { detect, current?, new, submit, value }`. When `detect` shows after the sign-in and its code, the step types the Site Login password into `current` (optional, for a form that asks only for the new password), the run variable named in `value` (exactly one `{{var.name}}`) into each `new` field, and submits; the output then says `passwordChanged: true`, also when a later step fails. A new password the site sends back, or does not confirm in time, fails the run with the new error code `password_change_failed`, which does not open the login breaker. After a change, later items and nodes with the same Site Login in that execution try no login and fail `locked_out` with their own message and `passwordChanged: true`. The change page must be listed under Pages Where the Password May Be Typed, the variable is masked like a secret fill's and no condition may test it, and only signed steps may use it. The node does not make up, store or save the new password: the workflow supplies and stores it. Step lists signed before keep their signature and run as before; a list that uses `changePassword` is refused by 0.2.0.
- A sign-in refused because an address is not a listed login page now names that address (host and path, no query) and the setting to add it to, the Site Login's **Pages Where the Password May Be Typed**: the page that is not listed, the page a field is on, the address a field's form posts to (which the address bar never shows), or the address a Next, Sign in or `via` button posts to. Before, the message said only "not a declared login page". Only an http or https address is named, with session segments masked and a long one shortened; any other target (such as `javascript:`) is called "an address that is not a web address (http or https)". A login form is judged by its own action, also when a page nests it in a button (a button's `formaction` around the form no longer decides), and an action that does not resolve is refused as one that does not post to a web address. A login form that holds a field named `action` no longer hides where the form posts (such a form was always refused before), and a field named `elements` no longer hides a password field from the check on a `via` button. The field's description now says that the list also needs each address a sign-in form posts to.
- A sign-in that could not get its one-time code now says why. When n8n will not run the One-Time Code Workflow because it is not published, the message says so and where to click Publish (n8n's own words follow in brackets), and the error's description says to run that workflow by itself until it returns a code, then publish it. When the steps type a code and the Site Login has no TOTP Secret, the message ends `detected:mfa_totp: the site asked for a one-time code and the Site Login has no TOTP Secret`, and the description says to add the seed or take the code from a workflow. Both stay `auth_blocked`; the general `auth_blocked` description no longer says only that a person has to sign in. The README and the One-Time Code Workflow field say to publish that workflow first.
- Import Steps: `selectOption([...])` with a list of option texts in Playwright code becomes a `select` with an array value (a multi-select: exactly those options), where before the step was reported as not translated and left out of the draft. A list that names options as `{ value }`, `{ label }` or `{ index }` objects, an empty list, or more than 50 options is still reported as not translated, each with its own reason. A Site Login secret in any of the options removes the step, as for a single option. The Chrome Recorder records one value per change, so its import is unchanged.
- Import Steps can take the sign-in's one-time code from a workflow, as Run Steps can: it now has the **One-Time Code Workflow** and **Code Timeout (Seconds)** options. With a workflow set, a recorded code becomes a sign-in whose `totp` has `"source": "workflow"`, and the import's run and its replay each ask that workflow for a code, so a site whose code comes from an authenticator app read by another workflow can be imported, approved and signed without a TOTP Secret in the Site Login. Each code is masked like every secret, in the outputs, the report and the traces. Without a workflow and without a TOTP Secret, such an import fails `auth_blocked` and its description says to add one of the two. A UiPath import's generated workflow sets the same workflow (and Code Timeout when it is not 120) on its Run steps nodes. When one step list of an item fails on its code, the item's other step lists are reported as not tried, with no further sign-in.
- Messages and field descriptions say what to do next: the login, drift, policy and locked-out guidance names the Login Breaker Reset Key steps and what each case covers (browser or desktop), a sign-in that the site sent back reads `detected:login_failed: the site sent the sign-in page back`, the runner and browser credentials name the `Show-RpaConnection.ps1` lines to copy, and the Windows installer and `Show-RpaConnection.ps1` say when to restart and what a program that is not listening yet needs. The Windows guide and the README gain a tunnel example, the web view app policy example, the clipboard and already-open-app notes, and the output field notes.
- Import Steps takes a step document: **Source** → **Step Document (JSON)**, as text or a file of at most 5 MiB, with the steps as Run Steps takes them (a step document, a bare array of steps, or a desktop step set). This is how steps you wrote get approved and signed: before, only steps from an import or an AI repair could be, and hand-written steps had to run unsigned. The document is read as data by the step parsers, and one that does not parse is refused with the parser's message before anything runs. Browser steps are run once and replayed without writes, as every import is, and come out on Repaired Steps for approval with the safety flags computed from the steps. Browser steps that submit a form, download through a form, type a secret or change a password go to approval as written, marked not replayed (next entry). Desktop steps need no RPA Browser credential and go to approval without a replay, with their candidate writes; a `write` the document marks is left for the approver to list in Write Steps, and the report says the document marked it. The steps keep their `{{var.name}}` values (the import's run takes them from Options → Variables), are named by the import's Name as version 1, and a `signature` or `approvedBy` beside them is not imported, which the report says. A document without `startUrl` whose first step is not an absolute `goto` starts at Start URL or, when that is empty, at the Site Login's start address, as in Run Steps. A copied row of the steps table (its `steps` as text) is refused with a hint to paste the value of its steps column. Expected File is not used for a step document: the report notes it without counting it as a step not translated, and it does not refuse a CDP browser. Template 5 offers **Step document** on its form, and its Set once note says that a document with `{{var.name}}` values needs them under Options → Variables.
- Hand-written browser steps that submit a form (`submit`), download through a form (`download` with `via`, also inside `paginate`), type a secret (`fill` with `secret: true`) or change a password (`signIn` with `changePassword`) can now be approved and signed: import them with Import Steps → **Step Document (JSON)**. Before, such a list had no way to approval (imports refused it, AI repair never writes one, and Sign Steps signs only Repaired steps items), so it could run only unsigned, and a secret fill or a password change not at all. The import does not run such a document, not even its steps before the first write: it checks it as Sign Steps will (the parser, and the steps against the policy Sign Steps uses with the same credentials, so a target Sign Steps would refuse is refused at import with that reason) and puts it on Repaired Steps marked not replayed, with empty evidence, no screenshots, the evidence line `Not replayed: these browser steps were never run by the import, because they submit a form, download through a form, type a secret or change a password. Check every step, each form's target and each download before you approve.`, and safety flags that name every form submission, the download, every host, and each run variable a secret fill types or a password change sets, by name (never a value). Such a document needs no RPA Browser credential; on Data it is `adopted: false`, `forApproval: true`. Sign Steps accepts the line only on a first version with empty evidence whose steps have at least one of the four, with every step in its change list, in order, and the flags recomputed; a `download` there needs no file evidence. A first version with one of the four that carries a "Proven in a fresh browser" line is refused. At run time Run Steps still applies the Site Login's Forms It May Submit and Pages Where the Password May Be Typed, and matches each declared target against the request the page sends. The import no longer answers such a document with `script_untrusted: … Sign them with Sign Steps`. Template 3's emails no longer say "as reported by the run" for an item that was not replayed, and template 5's form says how many browser step lists wait for approval not replayed. Other sources still refuse a draft that writes; the README names this route there. Items made before this change sign as before.
- Sign Steps judges a declared `submit` or `download` through a form as Run Steps does with the same credentials. Without a Site Login it now signs a declared target on the start site or a site the steps' `goto`s open (Run Steps allows a declared target on a site it may open); before, it refused every submit when no Site Login was attached. With a Site Login nothing changes: only the forms under its Forms It May Submit.
- The approval shows the steps an import left out. Every Repaired steps item from Import Steps (browser, not replayed and desktop) carries `leftOut`, one line per step of the source that the import did not translate, or dropped when its absence changes what the bot does, as its report words them and masked as the report is, and `leftOutList`, the lines as shown. Template 3's review email, approval email and desktop approval form show them in red under **Left out by the import (the source does these, the steps do not):**, before the evidence; with none, nothing is shown. The digest covers `leftOut` when it is there, and Sign Steps refuses an item whose `leftOut` or `leftOutList` was removed or edited after the email was made; an item without it, such as one waiting for approval from before this release, signs as before. The step document's note that a signature was not imported is now of kind `converted`, not `dropped`. A report item for a dropped step whose absence changes nothing the steps do (a viewport change, a fixed or load wait, a scroll, a focus click, a selector the step has others for, a check between the parts of a sign-in, saving a download, logging and comments) carries `notNeeded: true` and is not listed as left out; the report keeps it, and the import form's counts do not change. The desktop approval form now says what Approve and Reject cause and shows the hash and the review digest under that sentence, as the browser approval email does, and no longer points at the previous email for the change list it prints itself.
- After `login_failed`, correcting the username or password in the RPA Site Login gives one new try without a new **Login Breaker Reset Key**: when the site rejects that login too, the breaker holds again, now for it; otherwise the breaker is cleared. The same username, password and TOTP Secret stay `locked_out`; a change of any of the three counts as a changed login and gets one try (the fingerprint is keyed with the TOTP Secret, so adding, replacing or removing it changes the fingerprint). An `account_locked` breaker, a breaker that opened in 0.2.0 or earlier, and a breaker tripped earlier in the same execution behave as before, and the reset key works as before. To tell the logins apart, a `login_failed` breaker now keeps a fingerprint of the rejected login (an scrypt hash of the username and password with a random salt, keyed with the TOTP Secret when the Site Login has one), in workflow static data or in Redis; it holds no username or password, and the README says what a reader of either could do with it. The `login_failed` and `locked_out` guidance and the reset key's description say which case needs what.
- Windows runner: a desktop locator that matches more than one visible element on every look for 3 seconds now fails `drift_detected` (`not_unique`) then, where before it waited out the step's timeout; two matches that become one within those 3 seconds (a window still drawing) still resolve. A step whose timeout is shorter keeps it, and a locator that matches nothing, or a disabled element, waits the whole timeout as before. The `not_unique` message now says what to add to the locator (the window, a parent with an `automationId`, or a condition such as `name`), a disabled element's says to target an enabled element inside it or use key steps, and a window that belongs to a copy of an allowed app that the run did not start (one left open, or one that took the launch) says so and to close that copy on the runner machine. The node shows the runner's text as before; this needs the updated Windows package.
- Windows package: `Install-Rpa.ps1 -Unattended [-IdleSeconds 15]` runs the desktop runner and the browser with nobody signed in, on Windows Server 2019 or later (refused on Windows 10 and 11, where it was not tested, and with `-AutoSignIn`). A new Windows service, the RPA Supervisor (`runner\RpaSupervisor.exe`, as SYSTEM), listens on the runner's and the browser's port; when n8n connects it signs the bot user in through a Remote Desktop connection from the machine to itself and passes the connection through unchanged, and it signs the bot user out after the idle time. The installer puts the bot user into Remote Desktop Users, turns Remote Desktop on with the registry value alone when it is off (it turns on no firewall rule for Remote Desktop), stores the bot user's password in the LSA secret `L$RpaRunnerBotPassword`, registers the service, points the two firewall rules at it and signs the bot user in once; `install.json` records `mode`, `idleSeconds`, `runnerInnerPort`, `browserInnerPort` and `listenAddresses`. The runner and the browser then listen on `127.0.0.1` at their port + 10000. `Show-RpaConnection.ps1` shows the mode, whether the service runs, the bot user's sessions and the supervisor's last failure. An upgrade keeps unattended mode and its idle time; `Uninstall-Rpa.ps1`, and an install with `-Unattended:$false`, put back what it changed. The supervisor logs the address of each connection, which the runner behind it sees as 127.0.0.1. An install with automatic sign-in for the same bot user moves to `-Unattended` without a new password: the installer keeps the password stored for automatic sign-in (tried first), stores it for the supervisor, turns automatic sign-in off, signs the bot user out, and puts automatic sign-in back if the move fails. The way back, `-Unattended:$false -AutoSignIn`, keeps the password in the same way: it sets automatic sign-in up with the password the supervisor has before it removes the supervisor. A new password set by an administrator would make what the bot user's programs protect with it (an authenticator application's codes, for example) unreadable. The n8n credentials stay the same. An install without `-Unattended` works as before; its `install.json` gains `"mode": "signedIn"`.
- n8n waits up to 60 seconds (was 10) for a desktop runner to answer its connection, and for a Browser Server endpoint with a certificate fingerprint to finish its TLS handshake, because a machine installed with `-Unattended` signs the bot user in first, which took 5 to 16 seconds when measured. An endpoint without a fingerprint keeps its 10 seconds, and the message for an unanswered runner now names 60 s.
- Engine: a desktop recording is an import source (`recording`). A recording file (`rpa-recording/1`, at most 5 MiB and 400 events) becomes one desktop draft through the builder the UiPath desktop import uses, with a workflow of one desktop node. A recording with an unknown key, an `index` in a locator, a `{{$...}}` template other than a Save dialog's `{{$exportDir}}`, a program named by a path, a fill marked secret that holds a typed value, a typed value in a field not marked secret whose name, id or label says password, PIN or secret, more than 200 steps, or a value of the RPA Site Login is refused with the reason. An automation id that looks generated is left out of its locator (and a step with nothing else to find its element by is left out), and a step that finds its element by a row position is reported.
- Import Steps takes a recording of a Windows app: **Source** → **RPA Recording**, always a file (the `.rpa-recording.json` the RPA recorder saves), with no RPA Browser credential needed. Its desktop step list `<name>-1` goes to approval not replayed, with the evidence line `Not replayed: desktop steps imported from a recording are reviewed as written (there is no desktop proof yet). Check every step, and list in Write Steps the steps that save, post or submit.` (Sign Steps accepts it; the UiPath and step document lines are unchanged), and binary `workflow` is an n8n workflow named `<recording name> (imported from a recording)` with its Get active steps and Run steps on the RPA Desktop Runner. Template **RPA: 5 Import a bot** offers **RPA recording** on its form.
- A desktop `doubleClick` step: `{ "intent": "Open the order", "doubleClick": <locator> }`, a double click on the element (the runner already performed it), with the options of a `click` and its `write` mark. The write rules judge it as a click: a candidate write when its control or intent reads like save or post, declared in Write Steps like a click, and refused by the desktop runner on a declared write control without `write: true`. A recording's click with `"double": true` and a UiPath desktop Double Click (or a Click whose ClickType is double) become `doubleClick`, where a UiPath desktop double click became a single click before; a browser double click is unchanged. Step lists signed before keep their signature and run as before; a step list that uses `doubleClick` is refused by 0.2.0.
- A WinForms list view names its rows by their position (`ListViewItem-0`): the recorder and the importer no longer take such an id for a stable one, so a recorded row is found by its name.
- **Template 5 changed**: **RPA: 5 Import a bot** ships without its **Chat model** node and with **AI Repair** off on **Import steps**, so the form can be published without a model credential (a recording, a step document's desktop steps and a UiPath desktop sequence never use a model). Its **Set once** sticky says how to add one: turn on AI Repair, then connect a chat model to the Model input; it repairs an imported browser step that no longer finds its element. The form's last page counts each kind of step list in the singular or the plural and leaves out the replay sentence when no browser step list was replayed, and the form says that a recording's steps are named `<name>-1`. The sticky and the README's set-up say to publish **RPA: 3 Approve steps** first: n8n publishes the form only after it.
- The browser's connection message (`browser_unavailable`) and the `runner_unavailable` guidance name the case of a machine installed with `-Unattended`, where nobody needs to be signed in: check that the address is reachable, then run `Show-RpaConnection.ps1` and read `supervisor.log` on that machine.
- Windows guide: a flow is recorded in an administrator's own session (as the bot user only when the app keeps per-user settings the run depends on); an `-Unattended` install for a new bot user takes `-UserPassword` when a person will ever sign in as it; the package sizes are those of the package with the recorder. The README says how to change desktop steps by hand: import the `steps` of the active row as a step document.

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
