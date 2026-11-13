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

Templates 2, 3 and 5 create the two Data Tables when they are missing.

## RPA: 5 Import a bot

- **Settings**: `approval` is `on this form` (the default) or `by email`. `showDetails` (false) puts each step list's
  safety flags, evidence and change list on the review page.
- **Import a bot** asks for the **Bot file**, **Source (optional)** and **Name for the steps**. For every upload but an
  RPA recording and a step document it asks on a second page, **The file it downloads**, for a file name pattern and
  required columns. Leave both empty when the bot downloads nothing in a browser. A step document's download steps
  carry their own checks, so it is not asked: **Read the upload** reads the file's text (a file of at most 5 MB that is
  not a ZIP, XAML, code or a recording) and **Asks about a download?** looks for the step document's shape.
- **Bot file** may be left empty to change an approved bot or sign it again. **Approved bots** reads the `active`
  rows of `playwright_steps`, and **Change or sign again** shows the newest active steps of the name typed, to read
  and copy, with one box that is empty to start with. **Compared with the approved version** takes the steps to
  review: with the box left empty, the active row's steps as **The bot to change** read them from the table (they never
  pass through the browser); with text in the box, that text. It also gives the review page its first line: unchanged,
  or which steps differ. **Review** sends those steps to **Import steps** as a step document, then to the same review
  page and **Sign steps**. Text that is not a step document ends on **Import failed**, which says the old version keeps
  running.
  The steps get the next version: **Import steps → Options → Version** is the approved version plus one, read by
  **The bot to change** from the active row (never from the box), so the review page says `version 2, replacing version
  1`. Signing the same steps again also gives the next version: it is a new approval. The workflow that runs the bot
  reads Expected Version from the active row, so it keeps running. Approved, the new row supersedes the old one. Rejected, the old one keeps running. This path gives no workflow file:
  the bot's workflow exists already. A name with no active row ends on **No approved bot**, which lists the approved
  names.
- Before the review page, **Sign steps** runs once with **Check Only** on: it signs nothing. It gives the name of the
  RPA Site Login it signs for, and after **Change or sign again** it checks the approved version's signature with its
  own signing key and Site Login, as a run checks it. **Checked?** sends that to the review page. The page's opening
  lines name the Site Login (desktop steps are signed for the app they start, without one). When the approved version
  does not fit, a warning says so above the decision: after a new signing key that is expected, but if the bot's
  workflow uses another Site Login, a version signed here will not run there. The page does not refuse.
- **Review and approve** shows each step list: what it opens, whether it signs in, forms it submits, files it returns,
  what the replay proved, the steps it left out, and the numbered steps. For desktop steps it asks "Which of these steps
  save, send or submit?". The **Decision** is **Approve and sign** or **Reject**. A page left unanswered for an hour
  signs nothing.
- The last page says `Approved and signed: <name> v<version> is now the version that runs under that name.`, or
  `Rejected: <name> v<version>. Nothing was signed.` An import is version 1. A file uploaded under the name of an
  approved bot is its next version (**Running versions** and **What it replaces** read what runs under that name, and
  the step lists named after it, `<name>-1`, `<name>-2`): the review page says `version 5, replacing version 4`, and
  the last page `Approved and signed: <name> version 5 is now the version that runs, replacing version 4.` or
  `Rejected: <name> v5. Nothing was signed. Version 4 keeps running.` After a change or a re-sign it says
  `Signed again: <name> version N, unchanged.`, `Changed: <name> version N is now the version that runs, replacing
  version M.`, or `Nothing changed: <name> version M keeps running.` When Sign steps signed a step list, it
  also downloads the workflow that runs the bot. When nothing was signed (rejected, or Sign steps refused), it neither
  gives the file nor says it does.
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
  The emails HTML-escape every value. The safety flags are the full list: every host, form submission, download and pop-up handler the steps have.
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

`playwright_runs` gets one row per run of the data feed, and of every workflow the import form hands over.

| Column | Type | Meaning |
|---|---|---|
| `name` | string | The step list's name |
| `lane` | string | `script` (signed steps) or `agent` (a repair or a first run) |
| `version` | number | The version used, 0 (the data feed) or empty when none |
| `hash` | string | Hash of those steps: the same as the `hash` of their row in `playwright_steps` |
| `confirmed` | boolean | The row count matched the total the page states |
| `rowCount` | number | Rows returned |
| `durationMs` | number | Run time |
| `llmTokens` | number | Model tokens used |
| `code` | string | Error code, empty on success |
| `executionId` | string | The n8n execution |
| `message` | string | What failed, as Run Steps' error item says it (masked as the node masks it), cut to 300 characters. Empty on success |
| `guidance` | string | What to do about it: the same text as the node error's description. Empty on success |
| `file` | string | The name of the file the run returned, empty when none |
| `account` | string | The user name the RPA Site Login signed in with, empty without one. Never the password |

In the workflow the import form hands over, a value that was not counted is left empty: `confirmed` and `rowCount`
when the steps read no rows (for example a run that returns a file), and `lane`, `durationMs` and `llmTokens` for a run
refused before it started (`locked_out`, `busy`).

The workflow the import form hands over writes the columns the table has. A `playwright_runs` made by an earlier
version keeps its columns, and a run never fails on it: the newer columns are left out of its rows. To have them, add
them to the table in n8n (**Data tables** → `playwright_runs` → add a column, with the name and type above), or delete
the table and its rows: the next run makes it again. The data feed writes only the first ten columns.
