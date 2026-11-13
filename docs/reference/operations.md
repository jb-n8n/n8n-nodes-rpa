# Operations reference

The **RPA** node has nine operations. The six quick ones take a URL and one or two fields, open a public page and need
no login. The three advanced ones run, sign and import step lists.

| Operation | What it does | Credentials |
|---|---|---|
| **Screenshot** | Take a screenshot of a page | RPA Browser |
| **Get Page** | Get the text, HTML or title of a page | RPA Browser |
| **Save as PDF** | Save a page as PDF | RPA Browser |
| **Extract Data** | Extract a table or list from a page | RPA Browser |
| **Fill and Submit Form** | Fill in and submit a form | RPA Browser |
| **Download File** | Download a file from a page | RPA Browser |
| **Run Steps** | Run a list of browser or desktop steps | RPA Browser or RPA Desktop Runner, and optionally RPA Site Login, RPA Step Signing, RPA Secret Variables, RPA Redis |
| **Sign Steps** | Sign a repaired step list | RPA Step Signing, and the RPA Site Login the steps use |
| **Import Steps** | Import steps from a recording, code or a UiPath bot | RPA Browser when browser steps are replayed, RPA Site Login when the bot signs in. RPA Step Signing and RPA Desktop Runner are never read: they are only passed on to the workflow file |

Each input item is one run in a fresh browser context. Nothing (cookies, storage, the open page) carries over between
items, nodes or executions. Failures and their codes are in [Errors](errors.md).

## What every quick operation has

- **URL** (required): `http` or `https`. Only this site is visited. Add others under **Options → Also Allow These
  Sites**. A URL that still contains `{{` after n8n resolved its expressions is refused: `URL must not contain {{ }} templates`.
- **Options**:

| Option | Default | What it does |
|---|---|---|
| **Wait Until** | Load | Load, DOM Content Loaded or Network Idle. Network Idle can hang on pages that keep polling. |
| **Wait for Element** | none | An element waited for before acting. |
| **Timeout (Seconds)** | 30 | Per step. |
| **Max Seconds** | 180 | The whole run, at most 600. |
| **Viewport** | 1280 x 800 | Width 320 to 3840, height 240 to 2160. |
| **Also Allow These Sites** | empty | Other hosts the page may open or load files from, separated by commas. No wildcards. |
| **Allow Private Network** | off | Allow addresses on your own network for the allowed sites. Set it directly: an expression is refused. |
| **Debug Trace** | On Failure | Attach a scrubbed browser trace as binary `trace`: On Failure, Always or Never. |
| **Max Items** | 100 | More input items than this fail before any run starts. |

- **Output**: `{ url, title, status, ...operation fields, steps, blockedRequests }`. `status` is the page's HTTP status.
  A 401, 403 or 429 succeeds and reports its `status`. A 404 or 410 fails `not_found`, a server error `site_down`.
  `steps` is the step list the operation ran, ready to paste into Run Steps. `blockedRequests` lists writes that were
  blocked.
- **Binary files**: Screenshot and Save as PDF put their file in the field named by **Options → Put Output in Field**,
  and name the file after it: `screenshot.png`, `pdf.pdf`. The field cannot be `trace`:
  `Put Output in Field must not be "trace": the debug trace uses that field.`

### Screenshot

**Capture**: Full Page (default), Viewport or One Element (then an **Element** locator, see
[Locators](steps.md#locators)). Output: a PNG in binary `screenshot` (`screenshot.png`).

### Get Page

**Return**: Text (default), HTML, or Title and URL Only. Output: `text` or `html`, and `truncated: true` when the page
was larger than 5 MB.

### Save as PDF

**Paper**: A4 (default) or Letter. Options: **Print Background**. Output: a PDF in binary `pdf` (`pdf.pdf`). It needs
a headless browser: with a browser that shows a window, it fails `incomplete` with `Save as PDF needs headless Chromium`.

### Extract Data

**Shape**: Table or List of Items.
- **Table**: a **Table** locator that matches exactly one table. Headers come from `thead th`, else the first row.
- **List of Items**: an **Item** locator that matches every item, and **Fields** (name, locator, **Attribute**: Text,
  `href`, `src`, `title`, `alt` or `aria-label`). Without Fields, each row is the item's text in `text`.

Options: **Output** (One Item per Row, or All Rows in One Item), **Next Page** and **Max Pages** (10), **ID Pattern
(Regex)** ([ID Pattern](steps.md#id-pattern)), **Stated Total Pattern (Regex)**, **Required Fields**, **Text That Means
No Results (Regex)**. Zero rows is `incomplete`, unless Text That Means No Results matches the page.

**Stated Total Pattern** is the only count check, and it runs only when you set it: a regular expression whose first
group is the total the page states. When it matches and the row count differs, the run fails `incomplete`. `confirmed`
is `true` only when a Stated Total Pattern is set and the page's total matched the row count. Otherwise `confirmed` is
`false` and the rows still come through.

### Fill and Submit Form

**Fields** (a locator and a value each) and **Submit Button**. Output: `text` (the page after the submit), `submitted`
and `writes` (method, host, path of every request sent).
- **Text fields only.** For selects and checkboxes, use Run Steps (`select`, `check`). A password field is refused:
  `Fill and Submit Form cannot fill password fields. For sites behind a login, use Run Steps with a Site Login.`
- Writes are allowed only during the submit click: at most 3 POST requests, each to the URL's site or an allowed site.
- **Check `submitted`.** A click that sent no POST is still a success, with `submitted: false` and `writes: []`.
- **Typed values can show up in outputs.** The trace keeps the values typed into the fields, and the page text after
  the submit may echo what you sent. Set **Options → Debug Trace** to Never for sensitive form data.
- A submit is not idempotent. **Retry On Fail** or a re-run sends it again.
- Its `steps` output does not run unchanged in Run Steps: the values are `{{var.f0}}`, `{{var.f1}}` placeholders that
  need **Options → Variables**, and Run Steps has no write window for the click. Replace the click with a `submit`
  step that declares the form's host, path and method.

### Download File

**Download Link or Button** (a locator). Clicking it must start a GET download. Options: **Allowed File Types** (CSV,
Plain Text, PDF and XLSX by default, also JSON, ZIP, PNG, JPEG and DOCX, checked by the file's contents), **Max File
Size** (MB, 50, at most 200). Output: `fileName`, `mimeType`, `bytes` and the file in binary `file`. The output's
`status` is `null`, because the last thing the page loaded is the file itself. A download that needs a POST is a Run
Steps job with a declared `submit`.

## Run Steps

Runs a list of browser or desktop steps. [Steps](steps.md) lists every step.

| Field | What it is |
|---|---|
| **Runs On** | Which credentials the node asks for: **Browser and desktop apps** (the default, every slot), **A browser** or **A Windows desktop app**. It does not decide where the steps run. The steps do. See [Runs On](#runs-on). |
| **Steps (JSON)** | A step document or a bare array of steps. Usually mapped from a Data Table row: `{{ $json.steps }}`. Empty means a first run, which needs AI Repair. |
| **Start URL** | Browser steps only. Required without a Site Login, and it sets the allowed site. With a Site Login it must be on the credential's sites. |
| **Require Signed Steps** | On by default. **Signature** and **Approved By** must be present and verify, or the run fails `script_untrusted` before anything opens. Turn it off only for steps you typed here. |
| **Signature**, **Approved By** | From the signed row, mapped from the same item as the steps. |
| **AI Repair** | Off by default. On adds **Goal**, a **Model** input and a second output, **Repaired Steps** ([AI Repair](steps.md#ai-repair)). |
| **Expected File (First Version)** | With AI Repair: the checks for a download that AI builds for the first time. |
| **Options** | **Name**, **Expected Version**, **Variables**, **ID Pattern (Regex)**, **Stated Total Pattern (Regex)**, **Required Fields**, **Text That Means No Results (Regex)**, **Allow Unsigned Writes**, **Deliver Unconfirmed Rows**, **Max Agent Actions** (40), **Max LLM Tokens** (200,000), **One-Time Code Workflow**, **Code Timeout (Seconds)** (120), **Login Breaker Reset Key**, and the quick operations' Timeout, Max Seconds, Viewport, Also Allow These Sites, Allow Private Network, Debug Trace and Max Items. |

Credentials: **RPA Browser** for browser steps, **RPA Desktop Runner** for desktop steps, **RPA Site Login** (optional,
with it every allowed site comes from the credential), **RPA Step Signing** (when Require Signed Steps is on or a
Signature is set), **RPA Secret Variables** (optional: its Variables, and May Be Typed Into to limit the apps and
sites its values go to, see [Security](security.md#secret-variables)), and
**RPA Redis** (optional, needed in queue mode with a Site Login).

The error output is output 1, or output 2 when AI Repair is on.

### Runs On

Run Steps and Import Steps have **Runs On**. It only chooses which credential slots the node shows. The steps
themselves decide where they run: desktop steps run on the desktop runner and browser steps in a browser, whatever it
says. Type it. An expression shows every slot.

| Runs On | Run Steps shows | Import Steps shows |
|---|---|---|
| **Browser and desktop apps** (default) | RPA Browser, RPA Site Login, RPA Step Signing, RPA Redis, RPA Desktop Runner, RPA Secret Variables | RPA Browser, RPA Site Login, RPA Redis, and the two slots only passed on: RPA Step Signing, RPA Desktop Runner |
| **A browser** | RPA Browser, RPA Site Login, RPA Step Signing, RPA Redis, RPA Secret Variables | RPA Browser, RPA Site Login, RPA Redis, RPA Step Signing (only passed on) |
| **A Windows desktop app** | RPA Step Signing, RPA Desktop Runner, RPA Secret Variables | RPA Step Signing and RPA Desktop Runner (only passed on) |

A node saved before Runs On existed has the default and keeps every credential it has. n8n removes a credential whose
slot is hidden, so choosing **A browser** or **A Windows desktop app** removes the other kind's credentials from the
node. When steps need a credential whose slot Runs On hides, the run fails with the usual message and one more
sentence, for example `Its slot shows when Runs On is A Windows desktop app or Browser and desktop apps.` The workflow
an import makes sets Runs On on each **Run steps**: **A browser** for browser steps, **A Windows desktop app** for
desktop steps. Sign Steps and the quick operations have no Runs On.

## Sign Steps

Signs a **Repaired steps** item once a person approved it (**Approved** on), or records a rejection (**Approved** off).
No browser opens. Template **RPA: 5 Import a bot** and template **RPA: 3 Approve steps** use it for you.

- **Approver Allowlist**: the addresses that may approve. Type it, not as an expression.
- **Approved By**: who decided. It must be on the allowlist. Leave it empty when the allowlist holds exactly one
  address: that address is recorded.
- **Write Steps** (desktop steps only): the numbers of the steps that save, post or submit (`16`, or `7, 9`). Sign
  Steps marks exactly those steps `"write": true` and says so in `writeLine`: `Signed as writes: step 16 (Click Save)`,
  or `Signed as writes: none`.
- It recomputes the hosts, forms, downloads and pop-up handlers of browser steps from the steps, and refuses an item
  whose steps, flags, change list or left-out lines changed after they were shown. A refusal reads
  `Sign Steps refused: <reasons>`.

Steps you wrote yourself get a Repaired steps item, and so approval and a signature, through [Import Steps](#import-steps)
with **Source** **Step Document (JSON)**.

## Import Steps

Turns a recording, code or a UiPath bot into steps for approval. It reads one file per input item, builds a draft step
list, and puts what passed on the **Repaired Steps** output, the item Sign Steps takes. Nothing it imports runs on a
schedule until a person approves it. Template **RPA: 5 Import a bot** puts a form in front of it
([Move a bot](../guides/move-a-bot.md)).

**Fields**
- **Runs On**: as in Run Steps ([Runs On](#runs-on)). **A Windows desktop app** hides RPA Browser, RPA Site Login and
  RPA Redis, **A browser** hides RPA Desktop Runner. A hidden slot is not passed on to the workflow file.
- **Source**: **Work It Out From the File** (by the file name: `.rpa-recording.json`, `.zip` or `.xaml`, `.js` or
  `.ts`, else by the JSON's shape), **Chrome Recorder (JSON)**, **Playwright Code (JavaScript or TypeScript)**,
  **UiPath Project (ZIP or XAML)**, **Step Document (JSON)** or **RPA Recording**.
- **Input From**: **Binary File** (**Input Binary Field**, default `data`) or **Text** (**Recording or Code**, pasted).
  A UiPath project and an RPA recording come as a file. A file over 20 MiB is not read:
  `The file is larger than 20 MiB, so it was not read.`
- **Name** (required): the steps' name. A UiPath project gives one step list per sequence, named `<name>-1`,
  `<name>-2`. Every other source gives one list under the Name itself. A Name starting with `=` is refused.
- **Start URL**, **AI Repair**, **Goal**, **ID Pattern (Regex)** and **Expected File (First Version)** apply to browser
  steps. The Expected File's checks go onto the click that exports.
- **Options**: **Variables**, **One-Time Code Workflow** and **Code Timeout (Seconds)** (120), as in Run Steps, and
  the quick operations' options.

**What is never imported.** A value typed into a password, PIN, secret or code field, or a value equal to the Site
Login's username or password, is never imported. A field counts as one when its type, label, name, ID or locator says
so, in English or another common language. A field that says nothing of the kind is not recognized. The sign-in
becomes one `signIn` step that types the credential's values (with `next` for a two-page sign-in). Without a Site
Login it is removed and the report says so. A UiPath TOTP activity becomes no step: the Site Login's TOTP Secret, or
the One-Time Code Workflow, gives the code. A "Stay signed in?" answer right after the sign-in becomes a `when` step.

**Imports do not write.** Imported steps that `submit` a form or download through a form post are refused before the
browser opens. Every session sends no form submissions or writes (**Requests That Only Read** still pass), and no rows
or files from these runs are delivered. Browser steps run once and are then replayed in a fresh browser, so allow about
twice **Max Seconds** per step list. On a site with an authenticator code, the import needs the Site Login's
**TOTP Secret** or **Options → One-Time Code Workflow**. One input item imports at most 10 step lists.

**Step documents.** Steps you wrote, as Run Steps takes them (at most 5 MiB), read as data: nothing in them is
evaluated. A document that does not parse is refused with the parser's message, for example
`Nothing was imported: the step document is not valid steps: steps[0] has unknown key "colour"`. The steps keep their
`{{var.name}}` values (the import's run takes them from Options → Variables) and are named by the import's Name as
version 1. A `signature` and `approvedBy` beside the steps are not imported. Browser steps are run and replayed like
any import. Browser steps that submit a form, download through a form, type a secret or change a password are not run:
they go to approval as written, marked
`Not replayed: these browser steps were never run by the import, because they submit a form, download through a form, type a secret or change a password. Check every step, each form's target and each download before you approve.`
Desktop steps go to approval without a replay, and a `write` mark in the document is removed for the approver to
decide. A variable a desktop step types into a password, PIN or secret field is a secret variable, as in a recording:
the generated workflow leaves it to **RPA Secret Variables**, and the review page asks about a key pressed in that
field unticked. Once approved, an import becomes the version that runs under its name, also when a higher version was active.

**UiPath variables.** A variable that desktop steps type or choose starts with the value the project gives it, in the
generated workflow and on the review page: the argument's default, or what the invoking workflow passes in (a plain
value, or a variable's default). Never for a variable that is secret anywhere in the project, whatever the letter
case, a name that reads like a password, PIN, secret or token, a value of the RPA Site Login, or a value the import
removed as a secret elsewhere: the report says so, without the value. A value set by an
expression is left empty. Start values are not part of the signed steps.

**Recordings.** A file the RPA recorder saved (`.rpa-recording.json`, format `rpa-recording/1`, at most 5 MiB and
400 events, 200 steps) becomes one desktop step list under the Name. A variable the person made keeps its recorded
value as its start value in the generated workflow, except a secret. The import refuses a recording with a key the
format does not have, a value left in a field marked secret or named like a password, or a value of the RPA Site
Login. A step found by a row position (`Vendor Row 1`) is reported, because a later run acts on whatever is in that row.

**Outputs**
- **Repaired Steps**: one item per step list that passed the replay or goes to approval as written. Steps the import
  could not translate, or dropped in a way that changes what the bot does, are on each item as `leftOut`, and the
  review page and emails show them.
- **Data**: `{ report, drafts: [{ name, steps, adopted, code?, reason?, traceRef? }], workflowName? }`. The report lists
  every step that was not translated, dropped, converted or removed as a secret. Steps that cannot be proved (no ID
  Pattern, no file check) come out here with `adopted: false` and the reason, never on Repaired Steps. Binary
  `workflow` (`<name>.workflow.json`) is an n8n workflow that runs the steps: **Get active steps** → **Run steps**, a
  manual trigger and a switched-off **On a schedule**. For a UiPath project it also holds the rest of the bot (If,
  For Each, Excel, HTTP, email and delays as n8n nodes, with notes on what was not translated). Its browser **Run
  steps** keep the import's **Max Seconds**, **Also Allow These Sites** and **One-Time Code Workflow**. They have
  **Allow Private Network** on only when the import had it on, typed as a plain value, and their note says so.
  Every run writes the run log: **Create run log table** makes `playwright_runs` when it is missing, **Log run** writes
  one row per successful run, and the error output goes to **Log failed run** (the row has the error code) and then
  **Stop and Error**, so a failed run shows as failed. One **Log run** and one **Log failed run** serve every
  **Run steps**. To be told of a failure, choose an Error Workflow in the workflow's settings.
  Each **Run steps** has the import's RPA credentials picked, by name and id, never a value: a browser one gets the
  RPA Browser, the RPA Site Login and the RPA Step Signing, a desktop one the RPA Desktop Runner and the RPA Step
  Signing. Each also has **Runs On** set to its kind, so a desktop one shows three slots. The last two come from the slots marked "only passed on to the workflow file", which the import never
  reads. A slot left empty is left to pick. Imported into another n8n, or once a picked credential is deleted, n8n
  takes the only credential of that type with the same name, and otherwise asks for one on the node.
- **Error output** (output 2): a configuration problem, nothing imported, or every step list failed. A failed step
  list's trace and screenshot are binary `trace` and `screenshot`.

Import messages, word for word:
- `The recording signs in: attach an RPA Site Login so the import can sign in without the typed password.`
- `Imported steps that submit a form or post to download cannot be adopted: repair and import never write.`
- `These steps read no rows and download no file, so there is nothing to prove: the draft is returned for review but cannot be signed.`
- `Only JavaScript or TypeScript Playwright code can be imported; record with --target javascript.`
- `Nothing in this file could be turned into steps.`
- `The imported steps ran, but replaying them in a fresh browser did not pass the proof, so there is nothing to sign`, followed by the reason.
