# Onboarding rehearsal: the realistic SAP look-alike

> **Walked on 2026-10-21** against n8n 2.41.0 (`n8nio/n8n:2.41.0` with the node baked in, node package 0.1.0), the stack's browser server (Playwright 1.63) and OpenUI5 1.148.10. Steps 1 to 3 and 8 of the checklist were run end to end; steps 4 to 7 were not (see [Walkthrough record](#walkthrough-record)).

This runbook is for rehearsing a first day of automating an SAP system. The sandbox has a realistic SAP mode, which provides:
- an SAP system logon, or instead single sign-on through an identity provider with a TOTP code, on one page or identity-first (email, then password) ([section 6](#6-sso-and-mfa))
- a classic SAP GUI for HTML with Easy Access, a selection screen, an ALV list and the "Select Spreadsheet" XLSX export
- a Fiori list report built on SAP's real open-source UI5 library, reading through a strict read-only OData V2 service

It is a look-alike built from public documentation, not SAP. [What this look-alike can't tell you](#5-what-this-look-alike-cant-tell-you) lists what to check on the first real system.

## 1. Start

Start the stack as in the README's **Hello world in 10 minutes** (`.env` with `BROWSER_TOKEN` and `N8N_ENCRYPTION_KEY`, then `docker compose up --build -d`). Then switch the sandbox to realistic mode:

```bash
SANDBOX_SAP=realistic docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build sandbox
```

- **Which files carry the switch.** `SANDBOX_SAP` is read by `docker-compose.dev.yml`. A later `docker compose up -d` without that file recreates the sandbox in light mode. To keep realistic mode across restarts, add two lines to `.env`: `SANDBOX_SAP=realistic` and `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml`. Compose reads `.env` for the `${SANDBOX_SAP}` value, but only the dev file uses it, so the second line makes a plain `docker compose up -d` pass that file. With those lines in `.env`, running without the variable no longer returns to light mode. To go back, delete the `SANDBOX_SAP` line (and the `COMPOSE_FILE` line if you no longer want the dev file) and run `docker compose up -d --build sandbox`. Without `.env` lines, run the command above without the variable.
- **Internet access.** The Fiori app loads OpenUI5 1.148.10 from the sandbox's own path, `/sap/public/bc/ui5_ui5/resources/`. The sandbox fetches each file once from `https://sdk.openui5.org/1.148.10/resources/` and caches it in the `sandbox_state` volume (`/data/ui5`, about 10 MB after one full Fiori run). So the first Fiori load needs internet access from the sandbox container, and later loads come from the cache. Offline, a file that is not cached yet answers 502 `OpenUI5 could not be loaded from sdk.openui5.org (<reason>)`. `docker compose down -v` deletes the cache with the volume.
- **Check.** Open http://localhost:8080/sap/bc/ui2/flp. The SAP logon ("SAP NetWeaver", "System RPA, Client 100") renders in place at that URL. Log on with the values below and the launchpad shows the **Manage Line Items** tile. To check the UI5 path without a browser, run `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/sap/public/bc/ui5_ui5/resources/sap-ui-core.js`, which should print `200`. (`curl -sI` also works: the proxy answers HEAD like GET, without the body.)
- The classic GUI is at http://localhost:8080/sap/bc/gui/sap/its/webgui. It shows the same logon, then **SAP Easy Access**.

## 2. RPA Site Login values

Create an **RPA Site Login** credential:

| Field | Value |
|---|---|
| Login Page URL | `http://sandbox:8080/sap/bc/gui/sap/its/webgui` |
| Username | `RPA_BOT` |
| Password | `sap-demo-password` |
| TOTP Secret | empty (no second factor) |
| Sites the Browser May Open | `sandbox:8080` |
| Pages Where the Password May Be Typed | `sandbox:8080/sap/bc/gui/sap/its/webgui` and `sandbox:8080/sap/bc/ui2/flp`, one per line |
| Requests That Only Read | `POST sandbox:8080/sap*/bc/gui/sap/its/webgui` and `POST sandbox:8080/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch`, one per line |
| Sites It May Load Files From, Sites Allowed in Embedded Frames, Forms It May Submit | empty |

- **Client and language.** The logon page prefills Client `100` and Language `EN`, so the steps only fill User and Password.
- **Why `sap*`.** After the logon, the classic GUI moves to a per-session path, `/sap(<context>)/bc/gui/sap/its/webgui`, and posts every screen there. `*` matches the `(<context>)` part. The Fiori app reads through `$batch` POSTs on one OData service, so that entry names the service exactly.
- **Wrong passwords lock the user.** Five wrong passwords lock `RPA_BOT` (`User is locked. Please notify the person responsible`). **Reset to baseline** on http://localhost:8080/admin (user `admin`, password `change-me`) unlocks it. So does restarting the sandbox.
- **The caveat for real SAP** (README, **Sites that post to read (such as SAP)**). On a real system these same endpoints also carry saves. The web GUI posts Save and Post to the same `…/its/webgui` URL, and Fiori saves through `$batch` change sets. Listing them leaves no write protection for them. Your bot user must have display-only authorizations in SAP.

## 3. The onboarding checklist

Every step uses the **RPA Browser** credential from Hello world. The sandbox is on your own network, so each RPA node needs **Options → Allow Private Network** on.

### 3.1 Connection check

Add an RPA node with Operation **Screenshot**, URL `http://sandbox:8080/sap/bc/gui/sap/its/webgui` and **Options → Allow Private Network** on. You get `status: 200`, `title: "Logon"` and a PNG of the SAP logon in binary `screenshot`. On your SAP system, this one screenshot of its logon from the deployed browser proves the network path, the egress rules and certificate trust before anyone writes steps.

### 3.2 Hello world

Import `packages/n8n-nodes-rpa/templates/hello-world.json` and run it, as in the README. It proves the browser can reach a public site and the sandbox.

### 3.3 First automation, hand-written: the classic GUI XLSX export

Add an RPA node:
- **Operation:** Run Steps
- **Credentials:** RPA Browser and the RPA Site Login from section 2
- **Start URL:** empty, because the document's `startUrl` is used
- **Require Signed Steps:** off
- **Options:** **Allow Unsigned Writes** on (unsigned steps may contain `signIn` only with it) and **Allow Private Network** on

> **Sandbox only: never use these two settings on your SAP system.** Require Signed Steps off and Allow Unsigned Writes on drop the signature check that protects your credentials. An unsigned step document, typed or edited by anyone who can change the workflow, can then sign in, so it can type the RPA Site Login's password into any page the credential allows. Against this look-alike, with its synthetic `RPA_BOT` password, that risk is acceptable. On your SAP system, runs must use signed steps. Sign Steps signs only **Repaired steps** items, which AI build and repair (3.4 to 3.5) and **Import Steps** (section 4) produce; a hand-written document becomes signable by AI build, or by recording it again and importing it with **Import Steps**.

Paste this into **Steps (JSON)**:

```json
{
  "name": "sap-line-items-export",
  "startUrl": "http://sandbox:8080/sap/bc/gui/sap/its/webgui",
  "steps": [
    { "intent": "Log on", "signIn": { "username": { "label": "User" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Log On" } } },
    { "intent": "Open Line Item Report", "click": { "role": "button", "name": "Line Item Report" } },
    { "intent": "Company code", "fill": { "field": { "label": "Company Code" }, "value": "1000" } },
    { "intent": "From", "fill": { "field": { "label": "From" }, "value": "01.09.2026" } },
    { "intent": "To", "fill": { "field": { "label": "To" }, "value": "30.09.2026" } },
    { "intent": "Execute", "click": { "role": "button", "name": "Execute (F8)" } },
    { "intent": "Spreadsheet", "click": { "role": "button", "name": "Spreadsheet... (Ctrl+Shift+F7)" } },
    { "intent": "Continue", "download": { "trigger": { "role": "button", "name": "Continue (Enter)" } } }
  ]
}
```

- **Dates** are typed as `DD.MM.YYYY` text, SAP's default user format. The fields are not date pickers.
- **Result.** `lane: "script"`, `llmCalls: 0`, `title: "Line Item Report: Company Code 1000, 01.09.2026 - 30.09.2026"`, and `files: [{ fileName: "export.XLSX", ... }]`. The file is in binary `file_7`, named after the download step's index. It holds the header `Document No.`, `Posting Date`, `Company Code`, `Amount`, `Currency` and 8 rows, documents `1900000201` to `1900000208`.
- **Without Allow Unsigned Writes** the run fails `script_untrusted` before the browser opens.
- **This export runs unsigned by design in this rehearsal.** Sign Steps signs only a **Repaired steps** item, so a hand-written download has no signed form until it goes through AI build with an Expected File (3.4) or **Import Steps** (section 4). Either way, what passes a fresh-browser replay comes out as a Repaired steps item for approval.

The same flow on the other report-screen releases (set them on `/admin` under **Report screen**). Each was run on the walkthrough day:

| Release | What changes in the steps |
|---|---|
| Renamed labels | The tile is `G/L Line Items`, Execute is `Run (F8)`, and the toolbar button is `Export to Spreadsheet`. |
| Export in a menu | Replace the Spreadsheet click with three: `{ "role": "menuitem", "name": "List" }`, `{ "role": "menuitem", "name": "Export" }`, then `{ "role": "menuitem", "name": "Spreadsheet..." }`. |
| Export through a dialog | The popup preselects "Unconverted". Before Continue, add `{ "intent": "Choose XLSX", "check": { "field": { "label": "Excel (in Office 2007 XLSX Format)" } } }`. |
| "Export layout" button | An extra `Layout...` button downloads `layout.XLSX`. The steps above don't match it, so nothing changes. |

### 3.4 First automation from a plain-English goal (AI build) (not walked)

Use the data feed templates as in the README's **The self-healing data feed**:
- Pick the SAP Site Login on **Run steps** and **Sign steps**.
- Write a Goal such as "Open Line Item Report, run company code 1000 for 01.09.2026 to 30.09.2026, and read the document numbers in the list".
- Set **ID Pattern** `19\d{8}`, and clear **Stated Total Pattern**, because the ALV states no "Showing … of N" total.

AI build and repair make two kinds of steps (README, **AI Repair rules**): data feeds that read IDs, whose rows carry `id` only (README, **Known limits**), and downloads of one checked file. To build the XLSX export instead of the ID feed, clear **ID Pattern** on **Run steps**, set **Expected File (First Version)** with **Required Columns** `Document No., Posting Date, Company Code, Amount, Currency`, and write a Goal such as "Export the Line Item Report for company code 1000, 01.09.2026 to 30.09.2026, as a spreadsheet". Match on the columns rather than the file name (section 5). The agent builds the steps, a fresh browser downloads the file again and checks it, and the Repaired steps item carries the file evidence for approval. The export's Continue posts to the web GUI, which the Site Login's **Requests That Only Read** covers, so the step is a plain `download` with a `trigger`, which repair can heal. A `download` with `via` (a declared form post) could not be repaired.

### 3.5 Approve and sign (not walked)

As in the README: the review email in Mailpit (http://localhost:8025), then **Approve**. The approval workflow signs the steps and writes an `active` row to `playwright_steps`. In the approval evidence, check that the read-only entries the proof run used are listed on the Site Login. The classic-GUI ID feed uses only the `…/its/webgui` entry from section 2; the evidence lists only the entries a run used. Sign Steps refuses an entry that isn't on the Site Login.

### 3.6 A scheduled run (not walked)

Execute the data feed again: `lane: "script"`, `version: 1`, `llmCalls: 0`. Then activate it: it runs every six hours.

### 3.7 Shuffle the report screen and watch a repair (not walked)

On http://localhost:8080/admin, click **Shuffle report screen**. It picks Renamed labels, Export in a menu or Export through a dialog, sometimes with the "Export layout" button. Then execute the data feed:
- **Renamed labels** breaks the ID feed (the tile and the Execute button change names). The run heals, a fresh browser proves the repair, and version 2 goes for approval.
- **The other two** change only the export, so the ID feed keeps running unchanged.
- **The hand-written export** from 3.3 fails `drift_detected` at the first step that no longer matches. For Renamed labels that is "Open Line Item Report". It isn't repaired, because 3.3 runs without AI Repair and its download step has no `check`. Repair of a download needs a chat model and a check on the download step that names the file or its columns (`check.name` or `check.columns`).
- **A download feed** built as in 3.4 with an Expected File, or imported and signed as in section 4, carries that check and heals the same way: the repair finds the new way to the same file, keeps the check, and a fresh browser proves the file before version 2 goes for approval. For Export through a dialog, the repair keeps the click that opened the format popup.

**Reset to baseline** puts the screen back. The Fiori app follows the same state.

### 3.8 Fiori: the same flow against `/sap/bc/ui2/flp`

Use the same node settings and Site Login as 3.3, with this document:

```json
{
  "name": "sap-fiori-line-items-export",
  "startUrl": "http://sandbox:8080/sap/bc/ui2/flp",
  "steps": [
    { "intent": "Log on", "signIn": { "username": { "label": "User" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Log On" } } },
    { "intent": "Open Manage Line Items", "click": { "role": "button", "name": "Manage Line Items" }, "timeoutMs": 60000 },
    { "intent": "Company code", "fill": { "field": { "label": "Company Code" }, "value": "1000" } },
    { "intent": "Posting date", "fill": { "field": { "label": "Posting Date" }, "value": "Sep 1, 2026 - Sep 30, 2026" } },
    { "intent": "Go", "click": { "role": "button", "name": "Go", "exact": true } },
    { "intent": "Wait for the rows", "waitFor": { "target": { "css": "tr.sapMListTblRow" }, "minCount": 1 }, "timeoutMs": 60000 },
    { "intent": "Export", "download": { "trigger": { "role": "button", "name": "Export to Spreadsheet" } } }
  ]
}
```

- **The tile is a button,** not a link: `{ "role": "button", "name": "Manage Line Items" }`. Its full accessible name is "Manage Line Items Accounting Navigation Tile".
- **`timeoutMs: 60000`** on the tile covers the first load, while the sandbox fetches UI5 from the internet. That first click took 4 s on the walkthrough day; later runs take under 1 s.
- **Posting Date** is one UI5 date range field. It takes the range as text in the app's English format.
- **Wait for the rows before Export.** This look-alike's export writes the rows the table has loaded, and the Export button is there before the read returns. The wait keeps the file from coming out with fewer rows here. SAPUI5's real spreadsheet export works differently (see section 5), so the wait is for this look-alike, not a rule for real SAP. `tr.sapMListTblRow` is UI5's class for a table row.
- **Sandbox only.** The unsigned-steps warning from 3.3 applies here too: never run this with Require Signed Steps off on your SAP system.
- **Result.** `files: [{ fileName: "LineItems.xlsx", ... }]` in binary `file_6`, with 8 rows.
- **Match on columns, not on the file name or format.** This file's columns read `Document` rather than the classic GUI's `Document No.`, and its dates are ISO (`2026-09-01`). Real SAP is the same: each front end and release has its own column labels, formats and file names.
- **What the app sends.** It reads through the `$batch` entry on the Site Login, and nothing else is posted.

The Fiori releases (each was run on the walkthrough day):

| Release | What changes in the steps |
|---|---|
| Renamed labels | The tile is `G/L Line Items`, Go is `Apply`, and the export button is `Download spreadsheet`. |
| Export in a menu | The export button sits behind UI5's real overflow button, which is labelled **Additional Options** (not "More"). Before the download, add `{ "intent": "Open the overflow", "click": { "role": "button", "name": "Additional Options" } }`. |
| Export through a dialog | "Export to Spreadsheet" opens an "Export As" dialog whose **Format** select starts empty. Click the select's visible element by CSS, `{ "css": "#exportFormat" }`, not by its combobox role: UI5's combobox element is a hidden helper, so a role click times out. Then click `{ "role": "option", "name": "Microsoft Excel Workbook (*.xlsx)" }`, then download through `{ "role": "button", "name": "Export", "exact": true }`. |
| "Export layout" button | An extra "Export layout" button downloads `layout.xlsx`. The steps above don't match it. |

## 4. Import a bot (not walked)

The importers are built: **Import Steps** reads a **Chrome Recorder** export (DevTools Recorder JSON), **Playwright code** (the Playwright recorder's output) or a **UiPath** project. It strips typed passwords into a `signIn` step, runs the draft once, replays it in a fresh browser without writes, and sends what passed through the same approve and sign flow as a repair. The template **RPA: 5 Import a bot** (`packages/n8n-nodes-rpa/templates/5-import-a-bot.json`) puts a form in front of it. This walkthrough uses the Chrome fixture the engine's tests import, `packages/engine/test/fixtures/import/chrome-sap-export.json`, recorded on the light sandbox: the `/acme/login` sign-in with a TOTP code, then the light web GUI's Line Item Report for company code 1000, September 2026, exported as CSV.

1. Run the sandbox in light mode (section 1 without `SANDBOX_SAP`). Make a copy of the fixture and replace `http://localhost:8080` with `http://sandbox:8080` in it, the address the browser service uses.
2. Create an **RPA Site Login** with the README's sandbox values (Login Page URL `http://sandbox:8080/acme/login`, Username `summit-ops`, Password `demo-password`, TOTP Secret `JBSWY3DPEHPK3PXP`, Sites the Browser May Open `sandbox:8080`, Pages Where the Password May Be Typed `sandbox:8080/acme/login` and `sandbox:8080/acme/mfa`) and the two **Requests That Only Read** entries from section 2.
3. Import workflows 1 and 3 as in the README's data feed set-up, with this Site Login on **Sign steps**. Import `5-import-a-bot.json`. On **Import a bot** pick or create a Basic Auth credential (the form asks for its user name and password; keep it on, or anyone with the URL could start logins with this Site Login). Pick the RPA Browser and this Site Login on **Import steps**, a chat model on **Chat model**, turn on **Options → Allow Private Network** on **Import steps**, and choose **RPA: 3 Approve steps** in **Approve steps**.
4. Click **Execute workflow**, sign in to the form with the Basic Auth user name and password, and fill it in: the copied file, Source **Chrome Recorder**, Name `sap-line-items-export`, file name pattern `^LINEITEMS_1000_`, required columns `Document, Posting Date, Company Code, Amount, Currency`.
5. Expect the last page to read `Imported: 9 steps; 1 not translated, 3 removed as secrets.` and `1 of 1 step lists passed the replay`. The not translated step is the recording's `waitForExpression`. The removed values are the typed username, password and code: the draft signs in with one `signIn` step instead. The export click becomes a `download` step with the file checks from the form.
6. Approve the review email in Mailpit. Workflow 3 signs version 1 and writes an `active` row to `playwright_steps`. Run it on a schedule with Run Steps as the data feed template does.

Without a Site Login the sign-in is removed and the report says `The recording signs in: attach an RPA Site Login so the import can sign in without the typed password.` For Playwright code, record with `npx playwright codegen` and the JavaScript or TypeScript target; for UiPath, upload the project folder as a .zip.

## 5. What this look-alike can't tell you

The look-alike was built from public documentation, SAP Community threads and the OpenUI5 source, not from a running SAP system. Nothing here proves what a real SAP system sends. Check every item below on your first real SAP system (a test client is enough) before you rely on the steps.

**The logon**
- Are the logon fields still named `sap-client`, `sap-user`, `sap-password` and `sap-language`, labelled Client, User, Password and Language, with a **Log On** button? The `signIn` step finds them by label.
- Is the logon rendered in place at the requested URL, as here, or does it redirect to a separate logon URL? That URL is what goes into Pages Where the Password May Be Typed.
- What do the error messages say? The look-alike's wording is made up: `Name or password is incorrect (repeat logon)`, `User is locked. Please notify the person responsible`, and `Client 100 is the only client`.
- Does single sign-on or an identity provider sit in front of SAP? If so, its pages go into Sites the Browser May Open and Pages Where the Password May Be Typed, and the bot needs a login that doesn't prompt interactively. [Section 6](#6-sso-and-mfa) rehearses this and lists what to check.

**The classic GUI's markup**
- **Element ids.** The look-alike generates them per response in the form `M0:46:<salt>::<row>:<col>`, so they change between logins and are never usable as locators. Check the real format.
- **`lsdata`.** Here it holds only the SAP GUI scripting id of the control, such as `wnd[0]/usr/ctxtS_BUKRS-LOW` or `wnd[0]/tbar[1]/btn[8]` (Execute). Real `lsdata` holds more. Check whether the scripting id is in it, because it is the most stable thing to locate by.
- **`ct` control-type codes.** Here they are `I` input, `B` button, `RB` radio and `ST` table. Check the real codes.
- **Labels.** Fields here have `<label for>`, so `{ "label": "Company Code" }` works. If real fields don't, use the `title` text or a CSS locator on the `lsdata` id.
- **Wording.** Check the real tooltips ("Execute (F8)", "Spreadsheet... (Ctrl+Shift+F7)", "Continue (Enter)") and the "Select Spreadsheet" popup's title, options and preselection on your release.

**Export file names**
- The classic GUI here saves `export.XLSX`, and the Fiori app saves `LineItems.xlsx`. Neither name comes from a primary SAP source. Match the file on its columns and rows, never on its name.
- The real launchpad and SAPUI5's spreadsheet export aren't part of OpenUI5, so the real Fiori shell, tile and export dialog look different from ours.
- **How the real Fiori export gets its rows.** Here the export writes the rows the table has loaded. SAPUI5's real spreadsheet export re-reads the data from the OData service itself, so it may return more rows than the table shows and may issue its own requests. Check which requests it sends, because they must be covered by Requests That Only Read.
- **How the real WebGUI delivers the XLSX.** Here the file is the response to the POST of the popup's Continue. A real system may answer with a follow-up GET or open a new window. That changes the download step and the read-only entries you need.
- **Amount type.** Real exports usually write Amount as a number. Here the column is text, so check the cell type if a later step does arithmetic on it.

**OData `$batch` traffic**
- The look-alike's OData service accepts exactly what OpenUI5 1.148 sent it in a real browser:
  - a multipart/mixed body with CRLF line ends
  - a `$count` part first, then a data part with `$skip`, `$top`, `$orderby` and `$filter`
  - lower-case percent escapes
  - midnight-UTC `datetime'…'` literals
- That traffic went to our mock, not to SAP Gateway. Check the real requests and responses in the browser's network tab.
- Real service paths can carry a version (`ZSRV;v=0002`), which must be written out in full in Requests That Only Read, and a `sap-client` query.

**Session URLs**
- Does a real logon post to a per-session `/sap(…)/` path? A login page under such a path can't be listed in Pages Where the Password May Be Typed, because that field matches the path exactly.
- Do session ids in the URL carry `%` codes other than `%3D`? A `*` in Requests That Only Read matches `%3D` and no other `%` code.
- Can a URL session id plus `~sec_sesstoken` resume a session without cookies? If so, a leaked URL is a session.

**Authorizations**
- Does the bot user have display-only authorizations? On real SAP, the endpoints listed in Requests That Only Read also carry saves, so SAP's own authorizations are the only write protection there (section 2).

## 6. SSO and MFA

Enterprise SAP usually sits behind an identity provider with multi-factor sign-in. The realistic look-alike can rehearse that: with `SANDBOX_SAP_LOGIN=sso`, the SAP logon is off and a sessionless SAP page redirects to the sandbox's own identity provider. Sign-in has three stages:
1. **Sign in** at `/idp/login` ("RPA Corp sign-in"): Email and Password, then **Sign in**.
2. **Enter code** at `/idp/mfa`: the 6-digit TOTP code, then **Verify**.
3. The identity provider returns a page that posts a signed assertion to SAP's assertion consumer service, `/sap/saml2/acs`, by itself (a **Continue** button without JavaScript). The ACS opens the SAP session as `RPA_BOT` and returns to the page that asked for the sign-in.

It isn't real SAML. The assertion is a signed token that is valid for 60 seconds and can be used once. The identity provider lives on the sandbox host under `/idp/`, because the sandbox has one host name. Its field names follow Microsoft Entra's sign-in page, unverified.

**Start.** Add the variable to the realistic-mode command from section 1:

```bash
SANDBOX_SAP=realistic SANDBOX_SAP_LOGIN=sso docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build sandbox
```

`SANDBOX_SAP_LOGIN` is read by `docker-compose.dev.yml` like `SANDBOX_SAP`, and keeping it across restarts works the same way: a `SANDBOX_SAP_LOGIN=sso` line in `.env`, in addition to section 1's `SANDBOX_SAP=realistic` and `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` lines. Without it, realistic mode uses the SAP logon. Light mode ignores it. **Check:** open http://localhost:8080/sap/bc/gui/sap/its/webgui and you land on "RPA Corp sign-in". Get the code from any authenticator app with the secret below.

**RPA Site Login values.** Create a second **RPA Site Login** credential:

| Field | Value |
|---|---|
| Login Page URL | `http://sandbox:8080/sap/bc/gui/sap/its/webgui` |
| Username | `rpa-bot@rpa.example` |
| Password | `idp-demo-password` |
| TOTP Secret | `JBSWY3DPEHPK3PXP` |
| Sites the Browser May Open | `sandbox:8080` |
| Pages Where the Password May Be Typed | `sandbox:8080/idp/login`, `sandbox:8080/idp/mfa` and `sandbox:8080/sap/saml2/acs`, one per line |
| Requests That Only Read | as in section 2: `POST sandbox:8080/sap*/bc/gui/sap/its/webgui` and `POST sandbox:8080/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch` |
| Sites It May Load Files From, Sites Allowed in Embedded Frames, Forms It May Submit | empty |

- **Why the ACS is a password page.** Nobody types a password there. But the assertion reaches it as a form POST, and the engine treats a POST as a write, which it allows only to a declared login page (or a request listed as read-only). Listing `/sap/saml2/acs` with the identity provider's pages lets that POST through without counting it as a write.
- **The sandbox reads `IDP_USER`, `IDP_PASSWORD` and `IDP_TOTP_SECRET`** to change these values. The dev compose file doesn't pass them, so add them to the sandbox's `environment` if you need to.
- **Wrong values.** A wrong email or password shows `Your account or password is incorrect.`, and a wrong code shows `You didn't enter the expected verification code. Please try again.` Five wrong codes end the sign-in, and you start again at Email. Nothing locks.

**Steps.** In the document from 3.3 (or 3.8), replace the **Log on** step with:

```json
{ "intent": "Sign in", "signIn": { "username": { "label": "Email" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Sign in" }, "totp": { "field": { "label": "Code" }, "submit": { "role": "button", "name": "Verify" } } } }
```

The rest of the document stays the same, and the result too. `packages/engine/test/e2e-sap-sso.test.ts` runs this flow against the classic GUI.

### 6.1 Identity-first sign-in (email, then password)

Microsoft Entra and many other identity providers ask for the email on one page and the password on the next. With `SANDBOX_SAP_LOGIN=sso2` the sandbox's identity provider does the same:
1. **Sign in** at `/idp/login`: Email only, then **Next**.
2. **Enter password** at `/idp/password`: the email again (read-only), then Password and **Sign in**.
3. **Enter code** at `/idp/mfa`: the TOTP code, then **Verify**, as in `sso`.
4. **Stay signed in?** with **No** and **Yes**. Both buttons post to `/idp/kmsi`. The page comes back as the answer to the code, so the address bar still shows `/idp/mfa`. With `IDP_KMSI=off` the identity provider skips this page. The dev compose file passes `IDP_KMSI` to the sandbox (default `on`), so put `IDP_KMSI=off` in front of the start command (or in `.env`) to try that.
5. The assertion POST to `/sap/saml2/acs`, as in `sso`.

**Start.** Run the command above with `SANDBOX_SAP_LOGIN=sso2` instead of `sso` (or put `SANDBOX_SAP_LOGIN=sso2` in `.env`). **Check:** open http://localhost:8080/sap/bc/gui/sap/its/webgui. "RPA Corp sign-in" shows only Email and **Next**.

**RPA Site Login values.** Use the values in the `sso` table above, with one change. **Pages Where the Password May Be Typed** lists both sign-in pages, plus the code page, the "Stay signed in?" answer and the ACS:

```
sandbox:8080/idp/login
sandbox:8080/idp/password
sandbox:8080/idp/mfa
sandbox:8080/idp/kmsi
sandbox:8080/sap/saml2/acs
```

- **Why both pages.** The username is a secret too, so the page where it is typed must be listed, like the password page. After **Next** the engine checks the new page. If that page is not listed, the run stops before the password is typed: a fatal `signin` violation that names the page.
- **Why `/idp/kmsi`.** The "Stay signed in?" answer is a form POST. A POST to a page that isn't listed counts as a write and fails the run, as with the ACS.
- **Background POSTs on Next.** The look-alike's **Next** is a plain form POST. Single-page-app identity providers may also POST the username in the background when Next is clicked (Microsoft Entra's `GetCredentialType` is one). Declare that path as a login page (or in **Requests That Only Read**), or the run fails `policy_violation`.
- **Wrong values.** An unknown email shows `We couldn't find an account with that username.` on the email page again. The step then fails with `login_failed` (the login breaker trips) and the password is never typed. A password field that doesn't show within 15 s fails as drift with `signIn: after Next the password field did not appear`. A wrong password shows `Your account or password is incorrect.` on the password page. Codes work as in `sso`.

**Steps.** Replace the **Log on** step with a `signIn` that has `next`, followed by a click on **No** that has a `when`:

```json
{ "intent": "Sign in", "signIn": { "username": { "label": "Email" }, "next": { "role": "button", "name": "Next" }, "password": { "label": "Password" }, "submit": { "role": "button", "name": "Sign in" }, "totp": { "field": { "label": "Code" }, "submit": { "role": "button", "name": "Verify" } } } }
```

```json
{ "intent": "Answer \"Stay signed in?\" with No", "when": { "visible": { "role": "heading", "name": "Stay signed in?" } }, "click": { "role": "button", "name": "No", "exact": true } }
```

- **How `next` works.** `signIn` types the email, clicks `next`, and waits up to 15 seconds (less if the step's timeout is shorter) for the password field. When the password field shows, the step checks that the new page is a listed login page, then types the password, clicks `submit` and enters the code. If the email page comes back without a password field, the email was rejected, and the run stops before the password is typed: `login_failed` when the site sends the username page back; an inline error on the same page times out as drift (and AI repair is not attempted once the username was typed). Without `next`, `signIn` expects both fields on one page, as in `sso`.
- **Why a `when`.** The prompt is optional: identity providers show it depending on the account and its policy. The click runs only when the heading is visible and is skipped otherwise. So the same steps work with `IDP_KMSI=off`, and on a tenant that never asks. A step with a `when` right after `signIn` is part of the sign-in block, which AI repair reuses from the approved steps.

The rest of the document stays the same. `packages/engine/test/e2e-sap-sso2.test.ts` runs this flow against the classic GUI, with and without the "Stay signed in?" page.

### 6.2 Check on the real system

- **The identity provider's fields.** What are the real identity provider's field names, labels and buttons? The look-alike's names (`loginfmt`, `passwd`, **Next**, **Sign in**, **Verify**, **No** and **Yes** on "Stay signed in?") follow Microsoft Entra's sign-in page, unverified. Record what your tenant shows. Also check whether it asks for the email and password on one page (`sso`) or two (`sso2`, with `next`), and whether "Stay signed in?" appears for the bot's account.
- **Every page in the sign-in.** On a two-page sign-in, list both the email page and the password page, by the exact paths the browser shows, plus every later page that receives a POST (code, "Stay signed in?", the ACS). Record the requests the browser sends when Next is clicked: a single-page-app identity provider may POST the username in the background (Microsoft Entra's `GetCredentialType`, for example), and that path must be declared as a login page (or in **Requests That Only Read**), or the run fails `policy_violation`. An identity provider can serve a page at a different path from the one the form posts to (the look-alike's "Stay signed in?" shows under `/idp/mfa` and posts to `/idp/kmsi`). List the path the form posts to.
- **A separate host.** A real identity provider has its own host, such as `login.microsoftonline.com`. List it under Sites the Browser May Open, and its sign-in and code pages (exact paths) under Pages Where the Password May Be Typed, with SAP's ACS path.
- **Push MFA can't be automated.** Push approval and number matching in an authenticator app need a person. The bot's account needs a TOTP method (an authenticator app's secret), or a sign-in policy that doesn't ask it for a second factor.
- **The assertion POST.** Check the ACS path on the target system (`/sap/saml2/sp/acs/<client>` is common) and whether the identity provider posts through more than one page.

## Walkthrough record

On 2026-10-21, on a stack built from this repository (n8n 2.41.0, node package 0.1.0, browser server Playwright 1.63, realistic sandbox, OpenUI5 1.148.10 fetched on first use). Everything below was driven through n8n's REST API.

- **1. Start:** the logon rendered at both URLs, the UI5 proxy answered 200, and the cache held 9.9 MB after the Fiori runs.
- **2. Logon:** a browser logon with the section 2 values reached SAP Easy Access and the launchpad tile. Client 100 and Language EN were prefilled.
- **3.1 Connection check:** status 200, title Logon, and a PNG.
- **3.2 Hello world:** example.com and the three sandbox rows.
- **3.3 Classic export:**
  - The document above returned `export.XLSX` with 8 rows on the script lane.
  - The Renamed labels, Export in a menu and Export through a dialog alternatives each returned `export.XLSX`.
  - With the "Export layout" button added, the baseline steps still returned `export.XLSX`.
  - With Allow Unsigned Writes off, the run failed `script_untrusted`.
  - With Renamed labels and the baseline steps, it failed `drift_detected` at "Open Line Item Report".
- **3.8 Fiori export:**
  - The document above, without the "Wait for the rows" step, returned `LineItems.xlsx` with 8 rows (binary `file_5`). The wait step was added after the walk and checked the same day through the engine's script lane against the same Fiori app: 8 rows.
  - The Renamed labels, Export in a menu (Additional Options) and Export through a dialog (`#exportFormat`) alternatives each returned `LineItems.xlsx`.
  - With the "Export layout" button added, the baseline steps still returned `LineItems.xlsx`.
- **Not walked:** 3.4 to 3.7, which need a chat model and the approval loop.
- **Values corrected:** the section 1 UI5 check. It first used `curl -sI` (a HEAD request), which the proxy answered 405 because it served GET only. The proxy now answers HEAD like GET and the check prints the status with `curl -s -o /dev/null -w '%{http_code}\n'`. Every other value in sections 1 to 3 worked as written.
- **Added after review:** the sandbox-only warning on unsigned steps in 3.3, the Fiori wait step, and a section 5 that stands on its own.
