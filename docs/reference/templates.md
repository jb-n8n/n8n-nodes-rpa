# Templates reference

The package ships workflow templates in `packages/n8n-nodes-rpa/templates/` (also in the npm package's `templates/`
folder). Import one with **⋯ → Import → From File** in a new workflow. In some n8n versions the **⋯** menu says
**Import from File**. Each has a green **Set once** note that lists what to pick, in order.

| File | Workflow | What it does |
|---|---|---|
| `hello-world.json` | `RPA: Hello world` | A first screenshot and a table from the sandbox site ([Browser bot guide](../guides/browser-bot.md)) |
| `0-connection-check.json` | `RPA: 0 Connection check` | One screenshot of the URL in **Site to check**: shows the browser reaches your site before anyone writes steps |
| `2-data-feed.json` | `RPA: 2 Data feed` | Runs every 6 hours: the newest approved steps, a run log, your destination, an alert. A chat model builds the first version from a Goal and repairs the steps when the site changes |
| `3-approve-steps.json` | `RPA: 3 Approve steps` | Approval by email: emails the evidence, waits for a person's answer, signs the steps |
| `5-import-a-bot.json` | `RPA: 5 Import a bot` | A form: upload a bot, review and approve it on the next page, download the workflow that runs it ([Move a bot](../guides/move-a-bot.md)) |

Templates 2, 3 and 5, and the workflow the import form hands over, create the two Data Tables when they are missing,
first, before anything reads or writes them.

## RPA: 5 Import a bot

- **Settings**: `approval` is `on this form` (the default) or `by email`. `showDetails` (false) puts each step list's
  safety flags, evidence and change list on the review page.
- **Import a bot** asks for the **Bot file**, **Source (optional)** and **Name for the steps**. For every upload but an
  RPA recording and a step document it asks on a second page, **The file it downloads**, for a file name pattern and
  required columns. Leave both empty when the bot downloads nothing in a browser. A step document's download steps
  carry their own checks, so it is not asked: **Read the upload** reads the file's text (a file of at most 5 MB that is
  not a ZIP, XAML, code or a recording) and **Asks about a download?** looks for the step document's shape.
- **Bot file** may be left empty to change an approved bot or sign it again. **Approved bots** reads the rows of
  `playwright_steps` (the `active` ones are the approved bots), and **Change or sign again** shows the newest active steps of the name typed, to read
  and copy, a required choice, **Sign the approved steps again, unchanged**, **Change values** or **Change the steps
  as JSON**, and one box that is empty to start with. **Change values** is offered when the steps hold 1 to 40 values
  that a text field can hold; otherwise the page says why it is not. **Choice fits the box?** lets through only sign
  again or change values with the box empty or holding the approved steps unchanged (compared as JSON), or change as
  JSON with text in it; any other answer goes back through **Page answered?** to **Change or sign again**, which then
  says at its top what to correct and keeps the choice and the pasted text. A page not answered in time ends on
  **Choice and box differ**, and nothing is imported or signed.
- **Change values** (after **Change values?**) is the values page. **The bot to change** lists, in step order, the
  text a step types and the option it chooses (browser and desktop) and the address a browser step opens, each with
  its step's number and the review page's words (`4. Type into To: typed value`). Each gets a text field holding the
  approved value. A value with `{{` (a variable, or the desktop export folder), one a field cannot hold as it is (`<`,
  `>`, a line break, a space at an end) and several options are shown as text, without a field. **Values to steps**
  puts only the changed values into the approved steps, each at the place it was listed, as text; a step's own
  description gets the new value wherever it quotes the old one, and nothing else changes. A value with `{{` is
  refused (steps read it as a variable, and they have no way to say "literal"): **Values taken?** then ends on **Value
  not taken**, which says why, and nothing is imported or signed; so does the values page not answered in time. With
  no value changed, the steps are the row's own, as for sign again. The field names (`value_4`) can be filled from an
  address only through the first page's, which **Plain address?** refuses.
- **Compared with the approved version** takes the steps to review: signed again, the active row's steps as **The bot
  to change** read them from the table (they never pass through the browser); values changed, the approved steps with
  the new values (no value changed: the row's own steps, and the line adds `No value was changed on the values page:
  approving signs these steps again as they are.`); changed as JSON, the text in the box. It also gives the review
  page its first line: unchanged,
  or which steps differ and how. The two step lists are lined up first, so a step taken out or put in moves no later
  step: steps removed by their old number and description (`removed: step 17 ("Click Vendor Row 1")`), steps added
  by their new number (`added: step 19`), a step moved (`moved: step 3 is now step 8`), and for each changed step,
  at most three, its number (`step 16 (now step 15)` when it moved up) and its changed values, old → new
  (`step 6: typed value "2026-09-15" → "2026-09-30"`, in the review page's words: typed value, chosen option, address,
  description, control name, field label, visible text, selector), each on one line and cut at 60 characters, `several fields` for a
  step with more than three, then the other steps by number. When the part that differs is too long to line up
  (more than 250,000 pairs of steps), the steps are compared in place, step n with step n, and the line says so. **Review** sends those steps to **Import steps** as a step document, then to the same review
  page and **Sign steps**. Text that is not a step document ends on **Import failed**, which says the old version keeps
  running.
  The steps get the next version: **Import steps → Options → Version** is one more than the highest version any row
  of that name has, active, rejected or superseded, read by **The bot to change** (never from the box). A rejected
  attempt keeps its number and the next attempt takes a new one, and an answer is refused when another one of that name
  came first (see the review page below), so the table holds two rows of one name and version only when two answers
  came within a moment of each other (see below). The review page names the version that runs: `version 2, replacing version 1`, or after a rejected
  attempt `version 3, replacing version 1`. Signing the same steps again also gives the next version: it is a new
  approval. The workflow that runs the bot
  reads Expected Version from the active row, so it keeps running. Approved, the new row supersedes the old one. Rejected, the old one keeps running. This path gives no workflow file:
  the bot's workflow exists already. A name with no active row ends on **No approved bot**, which lists the approved
  names.
- Before **Change or sign again** shows any step, **Sign steps** checks the version that runs now (**Check Only**, as
  below) and **Change page next?** sends that check to **Fits this form?**. When its signature fits (or there is
  none, or no key to check it with), the change page follows. When it does not fit, **Approved on another form?**
  asks first, with no step on the page and no answer chosen: `This bot was approved on another import form: take me
  back` ends on **Change it on its own form** (nothing is shown, imported or signed; the About note of the bot's
  workflow names the import form that approved it, and this form cannot list the others), as does the page not
  answered in time; `I changed the signing key or the row was changed: show me the steps to read and sign again`
  goes on to the change page and to the review page with its warning. Only that answer goes on (**Sign it again
  here?**); the first page's address cannot fill it in (**Plain address?**).
- Two `active` rows of one name can be left by two approvals saved at the same moment. A run then uses the one of the
  highest version, and of two of one version the one saved first (n8n orders them by id). When **The bot to change**
  meets more than one, **Supersede older active rows** marks every other one (of that version or lower) `superseded`
  before the change page, and the change page says so.
- Before the review page, **Sign steps** runs with **Check Only** on (on the change path it has already run so once,
  before the change page): it signs nothing. It gives the name of the
  RPA Site Login it signs for, and after **Change or sign again** it checks the approved version's signature with its
  own signing key and Site Login, as a run checks it. **Checked?** and **Change page next?** send that to the review page. The page's opening
  lines name the Site Login (desktop steps are signed for the app they start, without one). When the approved version
  does not fit, a warning at the top says so: it was signed for another Site Login than this form's (browser steps),
  or with another signing key, or its row was changed after it was approved. The page cannot tell which, so it says to
  read every step before approving: approving signs the steps shown with this form's key, which is the way back after
  a new signing key. For browser steps it first says: if the bot was approved on the import form of another Site
  Login, change it on that form, because approved here it would run only with this form's Site Login. Its
  first sentence stands again directly above the **Decision**. The page does not refuse. The comparison line then
  never calls that version approved and never says unchanged: `<name>: these are the steps of the stored version 4,
  whose signature does not fit this form (the warning says what that can mean).`, or `changed from the stored
  version 4, whose signature does not fit this form: …`, on the change path and for an upload alike.
- **Review and approve** shows each step list: what it opens, whether it signs in, forms it submits, files it returns,
  what the replay proved, the steps it left out, and the numbered steps. For desktop steps it asks "Which of these steps
  save, send or submit?". A new bot's ticks start from the rule (every candidate but a key pressed in a secret
  field); a bot changed, signed again or uploaded again under its name starts from its approved version's own marks,
  ticked boxes and typed numbers alike, only when **Sign steps**' check says that version's signature fits this form,
  and the page says so. When it does not fit or could not be checked, the stored row's marks are not shown (it may have
  been edited in the table): the rule, an empty numbers box, and a sentence saying why. A step that differs from the
  approved one always falls back to the rule, a value changed on the values page included; when that moves its tick
  or number, the page names the step (`Step 6 changed since the approved version, so whether it may save or send
  starts from the rule: check it.`). The
  **Decision** is **Approve and sign** or **Reject**. A page left unanswered for an hour
  signs nothing. Once it is answered, **Versions now** reads the steps table again and **Still the next version?**
  checks that no row of a name on the page has that version or a higher one: another review page of the same bot,
  open at the same time, may have been answered first. Then nothing is signed or rejected, and **Approved meanwhile**
  says that another version was approved or rejected meanwhile and to start again. The check runs a moment before
  **Save signed steps** writes, not in one step with it (n8n has no transaction across nodes): two answers sent within
  that moment, well under a second, can still both be saved. A reader of `playwright_steps` then sees two rows of that
  name and version, the one saved last `active` and the other `superseded` (**Supersede older versions** takes only
  rows saved before its own), and both last pages said their version runs.
- The last page says `Approved and signed: <name> version <version> is now the version that runs under that name.`,
  or `Rejected: <name> version <version>. Nothing was signed.` An import of a new name is version 1. A file uploaded
  under a name used before gets the number after the highest any row of that name has (**Running versions** and
  **What it replaces** read the rows of that name, and of the step lists named after it, `<name>-1`, `<name>-2`). Under
  the name of an approved bot it replaces what runs: the review page says `version 5, replacing version 4`, the
  part of each step list that has a running version says how it differs from that version (**Compared with the
  running version**, the change path's comparison, for each list: `<name>: changed from the approved version 4: step
  6: typed value "2026-09-15" → "2026-09-30".`, or `unchanged`, or that it could not be compared; a new list says nothing; which desktop steps are writes is
  chosen again on the review page, so that mark is not compared, and the line says so), and
  the last page `Approved and signed: <name> version 5 is now the version that runs, replacing version 4.` or
  `Rejected: <name> version 5. Nothing was signed. Version 4 keeps running.` After a change or a re-sign it says
  `Signed again: <name> version N, unchanged.`, `Changed: <name> version N is now the version that runs, replacing
  version M.`, or `Nothing changed: <name> version M keeps running.` When Sign steps signed a step list, it
  also downloads the workflow that runs the bot. After an approval (not on the change page), a step list that types a
  secret adds what to copy into an RPA Secret Variables credential: each variable's name as the steps use it, and May
  Be Typed Into (the app's file name for desktop steps, the start site's host for browser steps). The page never asks
  for the value. The workflow file's notes carry the same block. When nothing was signed (rejected, or Sign steps
  refused), it neither gives the file nor says it does.
- In another n8n, or once a credential the workflow file picks is deleted, n8n picks the only credential of the same
  name if there is one: otherwise pick it on the node again.
- **Add the login page** shows when the sign-in stopped at an address the Site Login does not list. Add it under
  **Pages Where the Password May Be Typed**, then choose **Import again**.
- **Import a bot** opens with n8n's sign-in (**Authentication**: n8n User Auth, with **Require Workflow Execute
  Permission** on): only n8n users who may run this workflow can start an import. Each page of the form gives the n8n
  user who submitted it, and **Sign steps** takes the one who submitted **Review and approve** as the approver
  (**Approver**: who signed in to n8n on the approval form). That person must be on the **Approver Allowlist**.
- For approvers with no n8n account, set **Authentication** to **Basic Auth** and pick a Basic Auth credential. **Sign
  steps** then takes **Approved By**: empty, it records the one address on the allowlist. With Basic Auth, the pages
  after the first are not behind the password: anyone who has a page's address can open and submit it.
- Keep **Authentication** on: an anonymous form could start logins with the attached Site Login and approve steps.
  The form's page stays open until the import ends. Behind a reverse proxy, set its read timeout above twice
  **Max Seconds** (for nginx, `proxy_read_timeout`). Do not submit the form again after a timeout: the first import
  still finishes, and its result is in **Executions**.

### Set it up by hand

`npx n8n-nodes-rpa setup` does this in one command ([desktop bot guide](../guides/desktop-bot.md#2-set-up-n8n-with-one-command)).
By hand:

1. Import `packages/n8n-nodes-rpa/templates/5-import-a-bot.json` and follow its green **Set once** note.
2. **Import a bot** opens with your n8n sign-in: nothing to pick. For approvers with no n8n account, set its
   **Authentication** to **Basic Auth** and create a Basic Auth credential with a user name and password of your choice.
3. On **Sign steps**, create an **RPA Step Signing** credential with a key of 32 or more random characters, for
   example from `openssl rand -hex 32`. Keep a copy where you keep recovery secrets.
4. In **Sign steps → Approver Allowlist**, replace `approver@example.com` with the n8n address of each person who may
   approve. With Basic Auth, type your own address once: it is recorded as the approver.
5. Browser bots only: pick **RPA Browser** on **Import steps**, and the same **RPA Site Login** on **Import steps** and
   **Sign steps** when the bot signs in.
6. On **Import steps**, pick the same **RPA Step Signing**, and your **RPA Desktop Runner** for desktop bots, in the
   two slots marked "only passed on to the workflow file". The import never reads them. The workflow it hands over then
   has them picked. Left empty, you pick them on that workflow's **Run steps**.
7. Click **Publish**. The form's address is the production URL on **Import a bot**.

## RPA: 2 Data feed

The self-healing data feed reads data from a site that has no API (sign-in, second factor, filters) on a schedule.
When the signed steps stop matching, the chat model repairs the run on the same browser session, a fresh browser
proves the repaired steps with no model, and **RPA: 3 Approve steps** asks a person. The next run uses the new steps
with no model call.

- **Settings** holds `name`, the step list's name. Every Data Table filter and the Run Steps **Name** option use it.
- **Get active steps**: the newest `active` row of that name. **Run steps** runs it with **Require Signed Steps** on,
  **Expected Version** from the row, the Site Login, **ID Pattern** `N26-\d{4}` and **Stated Total Pattern**
  `Showing \d+-\d+ of (\d+)` (the sandbox's "Showing <first>-<last> of <total>" line). Change both for your site.
- **AI Repair** is on only when no unexpired `pending` row exists, so a waiting approval is not repaired again.
- **The first run.** With no active row, the model builds version 1 from the **Goal**, and the only output is the
  Repaired steps item, which goes to approval. Nothing reads the site's data until version 1 is approved. Each such run
  signs in and spends model tokens.
- **Outputs**: Data goes to **Log run** and **Send data to destination** (a placeholder: replace it). Repaired Steps
  goes to **Approve steps**. The error output goes to **Alert on failure** and **Log failed run**.
- **A new site**: copy the feed and change `name`, the Site Login, the **Goal** and the **ID Pattern**. With another
  Site Login, copy workflow 3 too and pick the new Site Login on its **Sign steps**.

## RPA: 3 Approve steps

Called by the data feed, or by template 5 with `approval` set to `by email`. It writes a `pending` row that expires
after `approvalTimeoutHours` (72), then:
- **Browser steps**: a review email with the safety flags first, in red, then the steps the import left out, the steps
  as the review page words them (a description that says something else in grey, in red when it names another action or site), the evidence, the change list and the
  before and after screenshots. Then an approval email with the same steps (⚠ before such a description), **Approve**
  and **Reject**. The steps show when the item carries them (an import's step lists do): Sign Steps builds them again
  and refuses to sign when they differ.
  The emails show every value as text, with look-alikes for `<`, `>` and `&`, and an invisible space in each address so that mail programs do not link it. The safety flags are the full list: every host, form submission, download and pop-up handler the steps have.
  The change list compares the steps themselves, not their intents, so a step that clicks another element is listed
  even when its intent reads the same. For an import, where every entry is a step added, the emails leave it out: it
  would repeat the steps. For a repair, each entry names its step by number, with the sentence built from the step and
  the description marked as above. Sign Steps builds that list again and refuses to sign when it differs.
- **Desktop steps**: one email, `Approve desktop steps v<version> for <name>?`, with the numbered steps and a
  **Review and decide** button, to a form with **Decision** and the candidate writes as tick boxes, none ticked to start.
- Approve: **Sign steps** signs, the row becomes `active`, older `active` rows of the name become `superseded`, and
  **Email signed steps** confirms. Reject or a refused signature: `rejected`. No answer in time: `expired`.
- Rejected Repaired steps can come back unchanged if the next repair produces the same steps. They reuse their row.
- Approval links need a real desktop browser: n8n ignores clicks from link scanners. Mailpit keeps no mail across a
  restart of the compose stack. If an approval email is lost, wait for `expiresAt`, or delete the `pending` row.

## Data Tables

`playwright_steps` holds the step lists. Rows are added, and only their status changes.

| Column | Type | Meaning |
|---|---|---|
| `name` | string | The step list's name |
| `version` | number | Its version. Run Steps checks it as Expected Version |
| `steps` | string | The steps as JSON (empty for a rejected row) |
| `hash` | string | SHA-256 of the steps: ties the approval to what was shown |
| `signature` | string | The HMAC with the Step Signing key |
| `approvedBy` | string | Who decided: the n8n user who approved on the form, or the address on the Approver Allowlist |
| `approvedAt` | string | When (ISO 8601) |
| `status` | string | `pending`, `active`, `superseded`, `rejected` or `expired` |
| `expiresAt` | string | When a `pending` row stops blocking a new repair |

`playwright_runs` gets one row per run of the data feed, and of every workflow the import form hands over. A table
made now has its columns in this order, the ones a person reads first.

| Column | Type | Meaning |
|---|---|---|
| `name` | string | The step list's name |
| `code` | string | Error code, empty on success |
| `message` | string | What failed, as Run Steps' error item says it (masked as the node masks it), cut to 1,000 characters. Empty on success |
| `guidance` | string | What to do about it: the same text as the node error's description. Empty on success |
| `file` | string | The name of the file the run returned, empty when none |
| `account` | string | The user name of the RPA Site Login on the RPA node, empty without one: the account the run signs in as, and whose failed logins stop its runs (`locked_out`). Filled also when the run stopped before the site or before a sign-in, so a failed run of one of many accounts says which. Never the password |
| `lane` | string | `script` (signed steps) or `agent` (a repair or a first run) |
| `version` | number | The version used, 0 (the data feed) or empty when none |
| `hash` | string | Hash of those steps: the same as the `hash` of their row in `playwright_steps` |
| `confirmed` | boolean | The row count matched the total the page states |
| `rowCount` | number | Rows returned |
| `durationMs` | number | Run time |
| `llmTokens` | number | Model tokens used |
| `executionId` | string | The n8n execution |

In the workflow the import form hands over, a value that was not counted is left empty: `confirmed` and `rowCount`
when the steps read no rows (for example a run that returns a file), and `lane`, `durationMs` and `llmTokens` for a run
refused before it started (`locked_out`, `busy`).

The workflow the import form hands over writes the columns the table has. A `playwright_runs` made by an earlier
version keeps its columns, and a run never fails on it: the newer columns are left out of its rows. To have them, add
them to the table in n8n (**Data tables** → `playwright_runs` → add a column, with the name and type above), or delete
the table and its rows: the next run makes it again. Rows are written by column name, so a table made in the earlier
order (`name`, `lane`, `version`, …) gets its rows as before. The data feed writes only the ten columns every table
has: `name`, `lane`, `version`, `hash`, `confirmed`, `rowCount`, `durationMs`, `llmTokens`, `code`, `executionId`.
