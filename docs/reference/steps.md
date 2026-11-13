# Steps reference

**Run Steps** runs a list of steps: browser steps for a website, or desktop steps for a Windows app. An import, an AI
repair or a person writes them, and **Sign Steps** signs them once a person approved them. This page lists every step
and its fields. [Operations](operations.md#run-steps) lists the fields of the Run Steps node itself.

There is no free-form JavaScript step: JavaScript cannot be signed or held to the list of allowed sites.

**Contents:** [Step document](#step-document) · [Browser steps](#browser-steps) · [Locators](#locators) ·
[ID Pattern](#id-pattern) · [Conditions](#conditions) · [Sign-in](#sign-in) · [File checks](#file-checks) ·
[Variables](#variables) · [AI Repair](#ai-repair) · [Output](#output) · [Desktop steps](#desktop-steps) ·
[Step schema](#step-schema)

## Step document

A step document is `{ name?, version?, startUrl?, steps: [...] }`, or a bare array of steps.

```json
{
  "name": "pricing-plans",
  "steps": [
    { "intent": "Open the pricing page", "goto": "https://example.com/pricing" },
    { "intent": "Accept cookies", "click": { "role": "button", "name": "Accept all" }, "optional": true },
    { "intent": "Read the plans table", "extractTable": { "table": { "css": "table.plans" }, "idPattern": "[A-Z]{2}\\d{3}" } }
  ]
}
```

Every step has an `intent` (plain words, shown in logs and errors) and one verb. Optional fields on every step:
`optional`, `when` (see [Conditions](#conditions)), `expect: { url?, heading?, visible? }`, `checkpoint`, and
`timeoutMs` (100 to 300000 milliseconds for a browser step). A top-level `interrupts` list (`{ target, click }`)
dismisses pop-ups whenever they appear.

## Browser steps

| Verb | Shape |
|---|---|
| `goto` | `"https://..."`, or `{ "goto": "https://...", "waitUntil": "load" }` with `load`, `domcontentloaded` or `networkidle` |
| `click`, `check` | a locator. `check` is `{ field, checked? }`. A `click` may hold keys with `modifiers` beside it, a list of `Ctrl`, `Shift` and `Alt`, each once: `{ "click": { "text": "Beta" }, "modifiers": ["Ctrl"] }`. A Ctrl+click or Shift+click that opens a new tab is not followed. On a browser that runs on macOS, Ctrl+click is a context click, so use these on the Linux browser image or a Windows browser |
| `press` | `{ key, target? }` presses one key on `target`, or on the element that has the focus: Enter, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, PageUp, PageDown, Home, End or F1 to F12, alone or after Ctrl, Alt and Shift in that order (`Shift+Tab`, `Ctrl+Enter`), or `Ctrl+A`. No key that types a character and no `{{var.name}}` in `key`: type text with `fill`. Refused on a password field. An Enter that would post a form is refused like a click on its button. An Enter that sends a search by GET passes |
| `hover` | a locator. Moves the mouse over it, for a menu that opens on hover |
| `fill`, `select` | `{ field: <locator>, value }`. `value` may be `{{var.name}}`. `fill` also takes `secret: true` (see **Typing a secret into a password field**). For `select` on a multi-select, `value` may be an array of strings, `["north", "{{var.region}}"]`: exactly those options end up selected and the others are cleared (a single string still selects one option). The array holds at most 50 values, of at most 4096 characters over all values together |
| `clickAll` | `{ target, max }` clicks every match, at most `max` |
| `waitFor` | `{ target?, state?, hasText?, minCount?, response? }` |
| `paginate` | `{ next, until: "absent" or "disabled", max, each: [steps] }` |
| `extract` | `{ scope, item?, fields?, idPattern?, textMode? }` rows from a page or a list |
| `extractTable` | `{ table, idPattern? }` rows from one table |
| `screenshot` | `{ capture: "full" / "viewport" / "element", element? }` |
| `pdf` | `{ paper?, background? }` |
| `read` | `{ what: "text" / "html" / "title" / "url" }` |
| `download` | `{ trigger, via?, maxBytes?, mime?, check? }`. `check` is `{ name?, minBytes?, columns?, minRows? }` (see [File checks](#file-checks)) |
| `submit` | `{ path, host?, method?, button }` a declared write: the only write target allowed, and only while this step runs |
| `signIn` | `{ username, next?, password, submit, totp?, changePassword? }` needs a Site Login. `totp` is `{ field, submit, source?, via?, check? }`. `changePassword` is `{ detect, current?, new, submit, value }` (see **When a site forces a new password**) |
| `popup` | `{ trigger }` clicks a link that opens a new tab and continues in it |
| `detect` | `{ name, checks, require? }` waits for one of several elements |

Run Steps runs unsigned steps only with **Require Signed Steps** off. **Unsigned steps** may not contain `signIn`, `submit` or `download` with `via` unless **Allow Unsigned Writes** is on.
With it on, whoever can set the steps drives the Site Login. On a login page that copies typed values into the page,
they can read its password out through step outcomes. Turn it on only when everyone who can set the steps is trusted
with that credential. A `signIn` with `changePassword` and a `fill` with `secret` need signed steps in every case. To
have steps you wrote approved and signed, import them with Import Steps → **Step Document (JSON)**
([Operations](operations.md#import-steps)): steps that submit a form, download through a form, type a secret or change
a password go to approval there as written, marked not replayed.

## Locators

A locator is an object: `{ "text": "Sign in" }`, `{ "label": "Email address" }`, `{ "role": "button", "name": "Submit" }`,
`{ "testId": "submit-button" }` or `{ "css": "table.results" }`, with optional `exact`, `within`, `frame` and
`fallbacks` (other locators tried in order). In the node's fields, **Find By** picks the kind:

| Find By | Matches | Example |
|---|---|---|
| **Visible Text** (default) | An element by the text it shows | `Sign in` |
| **Form Label** | A form field by its label | `Email address` |
| **Role and Name** | An element by role (button, link, textbox, checkbox, radio, combobox, heading, row, cell, tab, menuitem) and accessible name | `button` + `Submit` |
| **Test ID** | The `data-testid` attribute | `submit-button` |
| **CSS Selector** (advanced) | A CSS selector | `table.results` |

- Visible Text, Form Label and Name match case-insensitive parts of the text. **Exact Match** (`exact: true`) makes
  the match exact and case-sensitive. Test ID and CSS match exactly as written.
- Give short button and link names **Exact Match**. A name like `Export` also matches `Export layout`, so the step
  breaks the day the page adds such a control.
- A locator must match **exactly one** element, or the step fails `drift_detected` and says how many it found. Only
  Extract Data's **Item** may match many.
- To find a locator, open the page in your browser, right-click the element and choose **Inspect**. The Accessibility
  pane shows its role and name. **Copy → Copy selector** gives a CSS selector.
- **Variables in locators.** `{{var.name}}` works in the **Name** of a Role and Name locator and in a Visible Text
  locator, also in `within` and `fallbacks`, and in a desktop condition's `name`. The signed steps keep the template
  text, so the signature does not change. Anywhere else in a locator it is refused when the steps are read
  (`{{var.*}} is never rendered here`). A step that writes or signs in takes no variable in any of its locators, so a
  run variable does not steer a write. A variable whose value holds a credential secret is refused.

**Typing a secret into a password field.** `fill` and `select` do not type into a password input, except a `fill`
with `secret: true`, for a secret such as an export password on a page that is not a sign-in:

```json
{ "intent": "Type the export password", "fill": { "field": { "label": "Export password" }, "value": "{{var.exportPassword}}", "secret": true } }
```

The value must be exactly one `{{var.name}}`. The run masks it in logs, messages, errors, outputs and traces. Only
signed steps may use it, and AI repair does not write or move one. Supply the value from an
[RPA Secret Variables](security.md#secret-variables) credential.

## ID Pattern

**ID Pattern (Regex)** is a regular expression that matches the ID every record has. When it is set, only rows whose
ID matches are kept, and duplicates are removed by ID. AI repair needs it. Not sure what to write? Paste one real ID
into regex101.com and describe its shape: digits `\d`, letters `[A-Z]`, repeats `{4}`.

| Your IDs look like | Pattern |
|---|---|
| `INV-2024-00123` | `INV-\d{4}-\d{5}` |
| `AB123456` | `[A-Z]{2}\d{6}` |
| `10482` (any number) | `\d+` |
| anything non-empty | `.+` |

In a step document, an `extract` or `extractTable` step's own `idPattern` decides which rows it keeps. Import Steps
without an **ID Pattern (Regex)** checks the rows with the one the steps state, when every step that reads rows has one
(different ones count as alternatives). The workflow the import hands over has the same **ID Pattern** on its **Run
steps**.

An invalid pattern is a configuration error: `ID Pattern is not a valid regular expression: <parser message>. Example: INV-\d{4}.`
Pattern options are capped at 500 characters. The count check is a separate option, **Stated Total Pattern (Regex)**.

## Conditions

`when` runs a step only when its condition holds. Otherwise the step is skipped, the log notes `condition not met`,
and the run goes on. It takes exactly one of `{ "visible": <locator> }`, `{ "hidden": <locator> }`,
`{ "var": "<name>", "equals": "<text>" }` or `{ "var": "<name>", "notEquals": "<text>" }`. An element condition looks
once, without waiting: put a `waitFor` before it while the page loads. A variable that is not set fails the step with
`missing input "<name>"`. There is no else: write the opposite condition on the next step.

```json
{
  "steps": [
    { "intent": "Open the reports page", "goto": "https://example.com/reports" },
    { "intent": "Pick the full report", "when": { "var": "report", "equals": "full" }, "click": { "role": "radio", "name": "Full" } },
    { "intent": "Pick the summary otherwise", "when": { "var": "report", "notEquals": "full" }, "click": { "role": "radio", "name": "Summary" } }
  ]
}
```

A variable condition is refused on `signIn`, `submit` and `download` steps, on a `paginate` that holds a `submit` or a
`download`, and on the click that opens a write window. No condition may test a variable that a secret `fill` types
or that `signIn.changePassword` sets. Desktop steps take `when: { "visible": <locator> }` only.

## Sign-in

`signIn` types the RPA Site Login's username and password on a page listed under **Pages Where the Password May Be
Typed**, and its TOTP code when the step has `totp`.

**Two-page sign-in.** For a site that asks for the username on one page and the password on the next, `signIn.next`
is the button between them. The step types the username, clicks `next`, and types the password only when the password
field shows on a listed login page. So a rejected username stops the run before the password is typed: `login_failed`
when the site sends the username page back. An inline error on the same page times out as drift, and AI repair is not
attempted once the username was typed. A "Stay signed in?" prompt after it is an ordinary `click` step with `when`.

```json
{ "intent": "Sign in", "signIn": { "username": { "label": "Email" }, "next": { "role": "button", "name": "Next" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Sign in" } } }
```

**After the submit.** `signIn` checks the site's answer itself. When the site sends the password page back, the step
fails `login_failed` (`account_locked` when the page says the account is locked), and the login breaker opens: later
runs stop with `locked_out` and try no login (see [Errors](errors.md)). For a site that shows its error in place,
put a `detect` step right after the sign-in, with checks named `logged_in` and `login_failed`:

```json
{ "intent": "Check the sign-in", "detect": { "name": "afterLogin", "checks": { "logged_in": { "role": "button", "name": "Sign out" }, "login_failed": { "text": "Invalid username or password" } }, "require": "logged_in" } }
```

**Pages before the code.** `totp.via` lists 1 to 5 buttons to click after the password, such as "Use a verification
code" or "Send me the code". `totp.check` lists 1 to 5 checkboxes to tick before the code is submitted, such as
"Trust this browser". A `via` button that posts a form must post to a listed login page.

```json
{ "intent": "Sign in", "signIn": { "username": { "label": "Email" }, "next": { "role": "button", "name": "Next" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Sign in" },
  "totp": { "field": { "label": "Code" }, "submit": { "role": "button", "name": "Verify" },
    "via": [{ "role": "button", "name": "Use a verification code" }, { "role": "button", "name": "Send me the code" }], "check": [{ "label": "Trust this browser" }] } } }
```

**Code from a workflow.** By default the code is made from the Site Login's **TOTP Secret** (`"source": "seed"`). When
the code comes from somewhere else, such as an email or a desktop authenticator app, set `"source": "workflow"` in
`totp` and pick that workflow in **Options → One-Time Code Workflow**. Publish that workflow first: the node starts it
by its ID, and n8n 2.x refuses one that is not published ("Workflow is not active and cannot be executed"). The run
then fails `auth_blocked`. That workflow starts with an **Execute Workflow Trigger**, receives one item
`{ requestedAt }` once the code field shows, and must return exactly one item whose `code` is 6 to 10 digits. The run
waits up to **Code Timeout (Seconds)** (120). The code is masked like every secret and never appears in the output,
logs or errors. If the site rejects the code, the run runs the workflow once more. Steps with `"source": "workflow"`
and no One-Time Code Workflow are a configuration error. The code is in that workflow's own output: in its settings,
turn off saving successful executions.

**When a site forces a new password.** `signIn.changePassword` sets a new password in the same step. When `detect`
shows after the sign-in and its code, the step types the Site Login password into `current` (leave it out for a form
that asks only for the new one), the run variable named in `value` into each `new` field, and clicks `submit`.

```json
{ "intent": "Sign in", "signIn": { "username": { "label": "Email" }, "password": { "label": "Password", "exact": true }, "submit": { "role": "button", "name": "Sign in" },
  "changePassword": { "detect": { "role": "heading", "name": "Change your password" }, "current": { "label": "Current password" },
    "new": [{ "label": "New password", "exact": true }, { "label": "Confirm new password" }], "submit": { "role": "button", "name": "Change password" }, "value": "{{var.newPassword}}" } } }
```

- The output then says `passwordChanged: true`, also on the error item when a later step fails. Set the node's
  **Settings → On Error** to **Continue (using error output)** so that your workflow sees it.
- When the site sends its change page back, or does not confirm in time, the run fails `password_change_failed`. The
  login breaker stays closed.
- The change page must be listed under **Pages Where the Password May Be Typed**. Only signed steps may use
  `changePassword`. The value is masked like a secret fill.
- After a change, later items and nodes with the same Site Login and username in that execution try no login and fail
  `locked_out`.
- The node does not make up, store or save the new password. Your workflow supplies it, and stores it where the Site
  Login reads it once the output says `passwordChanged`. Keep the old value until a run has signed in with the new one.

## File checks

A `download` step can declare what the file must be. The checks are part of the signed steps, so removing or loosening
one breaks the signature. Every run enforces them.

- `check.name`: a regular expression the file name must match.
- `check.minBytes`: the smallest the file may be.
- `check.columns`: header columns the file must have, in any order, case-insensitive.
- `check.minRows`: the fewest data rows after the header.
- `mime` and `maxBytes` limit the file type and size.

Columns and rows are read from CSV, plain text (tab-delimited included) and XLSX (the sheet stored as
`xl/worksheets/sheet1.xml`, usually the first). The header is the first of the first 10 non-empty lines that holds
every required column, so a title line above the header is fine. A file that fails a check is drift: the message
starts `download check failed:`, and AI repair takes over when it is on. There is no date-range check on a file.

## Variables

`{{var.name}}` in a step is replaced with a value from **Options → Variables**, or from an
[RPA Secret Variables](security.md#secret-variables) credential for a secret. These are not n8n expressions. A value
from Options → Variables is not masked unless a secret `fill` or a `changePassword` types it (in desktop steps, every
value of 4 characters or more typed from a variable is masked). With AI repair on, the values that are not masked go to
the chat model's provider. A variable nobody supplied fails the run with `missing input "<name>"`.

## AI Repair

AI repair works on two kinds of browser steps: data feeds (steps that read rows with `extract`) and file downloads
(steps that download one checked file). When a step no longer matches the page, a connected chat model takes over the
same browser session, a fresh browser with no model and no writes proves the repaired steps, and the result goes to
the **Repaired Steps** output. Nothing repaired runs until Sign Steps signs it.

- A data feed needs an **ID Pattern** and an `extract` step, or empty steps (a first run, which also needs
  **Options → Name**). A file download needs exactly one `download` step outside `paginate`, no `extract`, and a check
  that names the file or its columns. The refusals are configuration errors:
  - `AI repair needs an ID Pattern and an extract step.`
  - `AI repair of a download needs exactly one download step, outside paginate, and no extract step.`
  - `AI repair of a download needs a check on the download step that names the file or its columns (check.name or check.columns).`
  - `AI repair works only on steps that extract rows or download one file: remove screenshot, PDF, read and table steps, or turn AI Repair off`
  - `A first run needs either an ID Pattern (to read rows) or an Expected File with a file name pattern or required columns (to download a file), not both.`
- **Expected File (First Version)** seeds the checks of the download step when AI builds the first version of a
  download: File Type, File Name Pattern, Minimum Size, Required Columns and Minimum Rows.
- `submit` and `download.via` stay refused: a repair does not write, and repair is also refused after a write was sent
  in the run. For an export that posts to read (SAP is the usual one), list the endpoint under the Site Login's
  **Requests That Only Read**: the export is then a plain `download`, which repair can heal.
- There is at most one repair per workflow execution, shared by every Run Steps node in it. A sub-workflow call is its
  own execution, with its own repair. A later drift fails `drift_detected` with `AI repair already ran in this execution`.
- With no chat model connected, a changed page fails `drift_detected`: `AI repair is on but no chat model is connected. Connect one to the Model input.`
- Rows read during a repair reach Data only when the proof passed, or with **Deliver Unconfirmed Rows** on. Otherwise
  the output says `the repaired steps did not pass the proof, so the rows were not delivered (turn on Options → Deliver Unconfirmed Rows to receive them)`.
- A file downloaded during a repair reaches Data only when the proof passed. **Deliver Unconfirmed Rows** never
  releases a file: `the repaired steps did not pass the proof, so the downloaded file was not delivered`.
- A repair may not change the file checks of the download step. The proven file is in the item's evidence, and Sign
  Steps refuses an item whose file evidence does not fit its steps (`the Repaired steps item has file evidence that does not match its steps`).
- The model sees a masked snapshot of the page, including what text fields and drop-downs hold (not password or
  credential-looking fields, and nothing on a login page), and the run's variable names and values that are not
  secret. That data goes to the chat model's provider.

**Known limits.**
- AI-built and AI-repaired steps extract IDs only. Rows from those steps carry `id` and no other fields. When you need record content, write the extract step yourself (Extract Data or Run Steps fields). Repair then refuses to rewrite field extraction.
- AI repair of a download proves one checked file. It does not read the file beyond its checks.

## Output

Data: `{ url, title, status, name, version, hash, lane, confirmed, llmCalls, durationMs, llmTokens, log, rows?, files?, blockedRequests?, submitted?, passwordChanged?, account? }`,
plus binaries named `<verb>_<step index>` (for example `screenshot_3`, `file_5`). Desktop runs add `values` (what
`read` steps returned). `account` is the user name the RPA Site Login signed in with, when one is used: with many
accounts, it says which account the item is (never the password or a code). `lane` is `script` for signed steps and
`agent` for a repair. `confirmed` is `true` only when
**Stated Total Pattern** matched the row count. Take a file in the next node through `files[0].binaryProperty`, not a
fixed name, because the index changes when a step is added. A run never reports success when a required step failed
or was skipped.

## Desktop steps

Desktop steps say `"surface": "desktop"` and name the app instead of a start URL. They need the
**RPA Desktop Runner** credential and node version 0.2.0 or later. The runner is installed by the
[Windows package](../install/windows.md).

```jsonc
{
  "surface": "desktop",
  "name": "erp-demo",
  "app": { "exe": "ErpDemo.exe" },
  "steps": [
    { "intent": "Wait for the sign-in window", "waitFor": { "target": { "uia": { "window": { "title": "ERP Demo - Sign in" }, "path": [{ "controlType": "Edit", "automationId": "txtUser" }] } } } },
    { "intent": "Type the user name", "fill": { "field": { "uia": { "window": { "title": "ERP Demo - Sign in" }, "path": [{ "controlType": "Edit", "automationId": "txtUser" }] } }, "value": "{{var.username}}" } }
  ]
}
```

| Verb | Shape |
|---|---|
| `click`, `doubleClick` | a locator |
| `fill` | `{ field, value }`. `{{$exportDir}}` in a value types the run's export folder, for a Save As dialog |
| `select` | `{ field, option }` |
| `check` | `{ field, checked? }` |
| `waitFor` | `{ target, state? }` with `visible` or `hidden` |
| `read` | `{ target, as }` returns the element's text in Data `values`, or `{ "clipboard": true, "as": "code" }` returns the clipboard's text right after a Copy click (see below) |
| `key` | `{ key, target? }` one chord: `Ctrl`, `Alt`, `Shift` in that order, then the key, as in `Ctrl+S`. Windows-key chords, `Ctrl+Escape`, `Ctrl+Shift+Escape`, `Alt+Tab` and `Alt+Escape` are refused |
| `expectFile` | `{ pattern, check? }` the file the app saved into the run's export folder, returned like a download |

- **Locators** are UI Automation paths: `{ "uia": { "window": { "title": "Save As" }, "path": [{ "controlType": "Button", "automationId": "1" }] } }`,
  with `fallbacks` as in the browser. To find one, point a UI Automation inspector (Accessibility Insights for Windows,
  or `inspect.exe` from the Windows SDK) at the control. It shows the window title and the control's type,
  `AutomationId` and `Name`.
- A locator that matches more than one visible element for 3 seconds fails `drift_detected`, and the message says what
  to add (the window, a parent with an `automationId`, or a `name`). A locator that matches nothing waits the step's
  whole timeout. A disabled control cannot take a click or a fill: target an enabled element inside it, or use keys.
- **Writes.** A step that changes data in the app is a write: `"write": true` on `click`, `doubleClick`, `fill`,
  `select`, `check` or `key`. The approver marks writes when approving (see [Security](security.md#desktop-runs)). The
  runner refuses a declared write control or gated key without it. Unsigned steps with a write need
  **Allow Unsigned Writes**.
- **Clipboard read** needs `clipboardRead` in the runner's policy and the run's window in front. It returns only the
  run's own fresh copy, at most 1000 characters, made by the app the run started within 10 seconds of the read. Put it
  right after the Copy click. The value is masked everywhere but `values`.
- **Files.** The runner policy's `maxFileBytes` (20 MiB by default, at most 36 MiB) limits an `expectFile`. A larger
  file fails `policy_violation`.
- **One run at a time.** A runner takes one run. A second run waits up to 45 seconds, then fails `busy`. Close any copy
  of the app left open on the machine: a step that finds its window in a copy the run did not start fails
  `policy_violation`.
- `timeoutMs` on a desktop step is 100 to 120000.
- **Not there yet** for desktop steps: AI repair, a replay before approval, an RPA Site Login, row checks, pop-up
  handlers (`interrupts`), loops, right-click, scroll, drag and hover, `when` on hidden elements or variables, a
  screenshot step, putting a file on the machine, and more than one app per run.

## Step schema

`packages/engine/schema/steps.schema.json` is a JSON Schema (draft-07) of the browser step document, for autocomplete
and checks in an editor. The published package carries a copy at `dist/schema/steps.schema.json`
(https://unpkg.com/n8n-nodes-rpa/dist/schema/steps.schema.json). Map it in the editor settings, not with a `$schema`
key, because Run Steps refuses keys it does not know. In VS Code, `json.schemas` in `.vscode/settings.json`:

```jsonc
"json.schemas": [{ "fileMatch": ["*.steps.json"], "url": "./packages/engine/schema/steps.schema.json" }]
```

The schema checks what Run Steps checks, except seven rules it cannot express: that a regular expression compiles,
that `detect.require` names one of the checks, that a document without `startUrl` begins with an absolute `goto`, that
`startUrl` parses as a URL (and the schema is stricter than Run Steps in one case: it refuses `http:host` without the
two slashes), lengths counted in UTF-16 units, that no value uses a `{{$...}}` template, and that no `when` tests a
variable that a secret `fill` types or that `signIn.changePassword` sets. A desktop step set does not validate against
it.
