# Your first browser bot

This guide starts n8n with the RPA node, a browser and a sample site on your computer. Then it gives n8n a first bot:
one that signs in to the sample site, runs a report and returns it as a CSV file. You read its steps and approve them
on a form, and n8n runs them. The first bot needs no AI model and no email server. It takes about 15 minutes. You need
Docker with Compose, `openssl`, and a copy of this repository.

The sample site is the **sandbox**: a small site in this repository that changes its layout when you ask it to. Steps
1 to 5 are Part 1. [Part 2](#part-2-let-it-repair-itself) adds an AI chat model, so that a bot repairs itself when the
site changes. To move a bot you already have instead, see [Move a bot](move-a-bot.md).

## 1. Start n8n and the browser

In the repository folder, write the two keys the stack needs, then start it (the first build takes a few minutes):

```bash
printf 'BROWSER_TOKEN=%s\nN8N_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up --build -d
```

`BROWSER_TOKEN` is the password n8n uses to reach the browser. `N8N_ENCRYPTION_KEY` is the key n8n encrypts its
credentials with. Keep `.env`: without the same key, n8n cannot read the credentials it saved. A stack started before
`N8N_ENCRYPTION_KEY` existed has its key in the `n8n_data` volume, and n8n then refuses to start with a new one
(`Mismatching encryption keys`). Print the old key with
`docker run --rm -v n8n-rpa_n8n_data:/data:ro --entrypoint cat n8n-rpa/n8n:local /data/config` and put its
`encryptionKey` into `.env`, or start fresh with `docker compose down -v`, which deletes the stack's workflows and
credentials.

The stack runs:
- n8n with the RPA node installed, at http://localhost:5678
- the browser, behind a token check, at `ws://browser:3000/` inside the stack
- the sandbox site at http://localhost:8080
- Mailpit, an inbox for approval emails, at http://localhost:8025 (Part 2 uses it)

Open http://localhost:5678 and create the owner account. If the page does not show the setup form yet, n8n is still
starting: reload after a minute. When n8n offers its own Assistant, choose **Set up later in Settings**.

## 2. Add the sample site's login

A **Site Login** is the credential for one site: its username, password and one-time code secret, and the pages the
bot may open. The bot types the password only on the pages listed there. The steps do not contain it, and the bot
masks it in its logs. In n8n's left sidebar, choose **+ → New credential → RPA Site Login**, and fill in these
fields. The values are the sandbox's sample values, not real secrets.

- Login Page URL `http://sandbox:8080/acme/login`
- Username `summit-ops`, Password `demo-password`, TOTP Secret `JBSWY3DPEHPK3PXP`
- Pages Where the Password May Be Typed `sandbox:8080/acme/login` and `sandbox:8080/acme/mfa` (one per line)
- Requests That Only Read `POST sandbox:8080/sap*/bc/gui/sap/its/webgui`. The sample site's SAP pages post a form to
  show every screen. A run may not post anything else unless the Site Login lists it.

Click **Save**. n8n names it **RPA Site Login account** and says `Connection tested successfully`. The test checks the
fields, not the password: a wrong password shows on the first run.

## 3. Set up the import form with one command

The **import form** is an n8n form where you upload a bot, read its steps and approve them. One command sets it up,
with the Site Login of step 2. It runs inside the n8n container, where the package is installed already, and works
through n8n's own command line: it needs no API key.

1. In the repository folder, run the setup command. The first part of the line hands it the browser token from `.env`:

   ```bash
   RPA_BROWSER_TOKEN="$(sed -n 's/^BROWSER_TOKEN=//p' .env)" docker compose exec -e RPA_BROWSER_TOKEN n8n /opt/n8n-rpa/node_modules/.bin/n8n-nodes-rpa setup --browser-url ws://browser:3000/ --site-login "RPA Site Login account" --allow-private-network
   ```

   `--site-login` picks the Site Login of step 2 by its name. `--allow-private-network` lets the import open the
   sandbox, which is on your own network: the bot opens private addresses only with this on. Leave it out for a site on
   the internet.
2. Answer `n` when it asks `Connect a Windows machine now?`.

Its first lines say which way it took and why: `Setting up n8n for RPA through n8n's own command line: no API key is
needed.`, and the project it works in, your own (the n8n owner's personal project). Before it changes anything, it
checks that n8n's command line works on the database of the n8n that runs in the container. The command creates two
**credentials** (a credential is where n8n keeps an address or a key, with its secret): **RPA Browser**, the
browser's address and token, and **RPA Step Signing**, a key that marks steps as approved. The bot runs only steps
whose signature matches that key. The command also creates the workflow **RPA: 5 Import a bot**, with the Site Login
on its nodes **Import steps** and **Sign steps** and **Allow Private Network** on, and publishes it, with you (the
n8n owner's address) as its approver. It never reads the Site Login's values. It waits until the form answers, which
takes a few seconds, and then prints:

```text
The import form is ready.
  Address:    http://localhost:5678/form/rpa-import
  Sign-in:    the form opens with your n8n sign-in. Who approves is recorded as the n8n user who approved.
  Private network: on. Imports may open sites on this computer or your own network, and the workflow the form hands over has it on too.
```

Keep the address. It ends in `/form/rpa-import`, or in a long id when another form in your n8n has that address
already (the command says so). Run the command again at any time: it reuses what is there and changes nothing. If
**RPA: 5 Import a bot** differs from this version's template, for example after an upgrade, it lists what differs and
asks `Update this form to this version? (y/N)`. `y` updates it in place and keeps its address, approvers and
credentials. Anything else changed by hand in it is lost, and the question names what. The signing key stays in n8n,
and n8n does not show it again. The `Signing key:` line says how to keep a copy: you need one only to move signed bots
to another n8n or for a lost n8n, so most people skip it. The command's other options are in step 2 of the
[desktop bot guide](desktop-bot.md#2-set-up-n8n-with-one-command), with the way for an n8n where you cannot run a
command (an API key).

## 4. Import the sample bot and approve it

The sample bot is the file `docs/samples/sandbox-line-items.steps.json` in this repository: a **step document**, the
steps written as JSON. It signs in, opens the sandbox's SAP report screen, runs the line item report for company code
1000 and September 2026, and exports it as a CSV file.

1. Open the form's address in the browser where you are signed in to n8n. The first time, n8n asks whether the form
   may run with your n8n login: choose **Allow access**.
2. In **Bot file**, choose `docs/samples/sandbox-line-items.steps.json`. Leave **Source (optional)** as it is. In
   **Name for the steps**, type `sandbox-line-items`. Click **Submit**.
3. The import runs the steps once and then again in a fresh browser, to prove them. This takes about half a minute.
   The next page lists the steps, says where the bot signs in, and shows the proof: `downloaded
   "LINEITEMS_1000_2026-09-01_2026-09-30.csv"`. The page builds each step's sentence from the step itself. A
   step's own description stands beside it in grey, as `(the author calls it: …)`, and in red when it names another
   action or site, or a value the step does not hold: read the red ones twice. The sample shows none. Under **Decision**, choose **Approve and sign**, then **Submit**.
4. The last page says `Approved and signed: sandbox-line-items version 1 is now the version that runs under that name.` Your
   browser downloads `sandbox-line-items.workflow.json`, the workflow that runs the bot.

If the last page says `Nothing to approve`, it names the problem:

| You see | What to do |
|---|---|
| `browser_unavailable: Could not connect to the browser server at ws://browser:3000/. ...` | Start the browser: `docker compose up -d browser`. |
| `browser_unavailable: The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.` | Copy the value after `BROWSER_TOKEN=` in `.env` into the RPA Browser credential's **Token**. |
| `policy_violation: Blocked: sandbox:8080 resolves to a private network address. ...` | Turn on **Options → Allow Private Network** on **Import steps** of **RPA: 5 Import a bot** and **Publish** it again, or run step 3 with `--allow-private-network` before the workflow exists. |

## 5. Run it

1. In n8n, create a workflow, choose **⋯ → Import → From File**, and pick the downloaded
   `sandbox-line-items.workflow.json`.
2. The RPA node is named **sandbox-line-items**. Its **RPA Browser**, **RPA Site Login** and **RPA Step Signing** are
   already picked: the import form passes on the ones it used. Check them. The fourth slot, **RPA Secret Variables**,
   stays empty for this bot. **Signature** and **Approved By**, which the import sets, are on the node's **Settings**
   tab. **Options → Allow Private Network** is on, because the import had it on.
3. Click **Execute workflow**. The run signs in, runs the report and exports it in a few seconds. Open the RPA node:
   its output holds `LINEITEMS_1000_2026-09-01_2026-09-30.csv`, with a **View** and a **Download** button.

Each run writes one row to `playwright_runs`, a table in n8n's Data Tables (**Log run**). A failed run writes its
error code there (**Log failed run**) and then stops at **Stop and Error**, so it shows as failed under **Executions**.
After a failed run, open the RPA node: the failed item on its error output has `details.guidance`, which says what
to do. **Stop and Error** and the run log's row show it too.
To run the bot on a schedule, open **On a schedule**, set the time, turn the node on, and **Publish** the workflow.

**When the site changes.** To see it, open http://localhost:8080/admin (user `admin`, password `change-me`) and set
**Report screen** to **Renamed labels**: the sandbox renames Line Item Report to G/L Line Items, Execute to Run and
Export to Download spreadsheet. Run the bot again. It fails `drift_detected` at the first control it cannot find,
and the message says what the page shows instead:

```
Click Line Item Report: No element found for Role and Name button "Line Item Report" on
http://sandbox:8080/sap(…)/bc/gui/sap/its/webgui after 30 s. The page shows these links and buttons: "G/L Line Items",
"Enter". The page no longer has that control. To go on, change the bot on the import form, or let self-repair fix it
if it is set up (AI Repair on the RPA node).
```

There are two ways on:
- **Change the bot on the import form.** Open the form, leave **Bot file** empty, type `sandbox-line-items`, choose
  **Change the steps as JSON**, and paste the steps with the name the message listed (`"name": "G/L Line Items"` in
  place of `"name": "Line Item Report"`). A control's name is changed as JSON: **Change values** changes only what the
  steps type, choose or open. The import runs the changed steps once. When a control is still not there, its page
  names what it shows instead, and the steps after it that act on the same page are checked too, without acting:
  one replay names every renamed field of a form. The sandbox's three labels are on three pages (each click opens
  the next), so each replay names the one on the page it reached and says to change the step's control name to one
  the page shows; change it and choose **Review** again. A step's description is your own text and is not rewritten:
  `Click Line Item Report` stays as it is until you change its `intent` in the same paste. The review page shows it
  beside what the step does (grey, or red when it quotes a value the step does not hold); what runs is the step.
- **Let it repair itself**, with a chat model: [Part 2](#part-2-let-it-repair-itself).

[Errors](../reference/errors.md#a-control-that-is-not-there) says what the list holds. The bot you approved now
expects the renamed labels, so leave **Report screen** on **Renamed labels** while you use it. To try it again, set
**Report screen** back to **Baseline**: the bot fails the same way, and the message lists the old names to change
back to.

**A bot that reads rows.** `docs/samples/sandbox-rows.steps.json` signs in and reads the sample site's notices. Import
it as in step 4, with the name `sandbox-rows`. Run its workflow as in step 5.
The RPA node returns one item with a `rows` list: one entry per notice, with its `id`, `Bulletin`, `Date`, `Type`,
`Models` and `Summary` (the title and text). For one item per row, add n8n's **Split Out** node after it, with
**Fields To Split Out** `rows`. A bot that reads rows is a step document whose `extract` or `extractTable` steps each have an
`idPattern`, the shape of the ID every row has ([Steps](../reference/steps.md#id-pattern)). The import checks the rows
with it, and the workflow it hands over does too.

**Your own site.** Record it with Chrome's Recorder (DevTools → Recorder, then Export as JSON) and upload the export on
the same form, with a Site Login for that site on **Import steps** and **Sign steps**. Turn **Allow Private Network**
off for a public site. A recording that downloads a file needs the file's name or columns on the page **The file it
downloads**, which the form shows for every upload but a step document or an RPA recording. A recording made on the sample site in your own browser holds `localhost:8080`: change it to `sandbox:8080` in the file
before you upload it, because the bot's browser runs inside the stack, where the sample site is named `sandbox`.
[Move a bot](move-a-bot.md) covers recordings, Playwright code, UiPath projects and step documents.

**Where else the browser can run.** For your own n8n, install the node from **Settings → Community nodes → Install**
(package `n8n-nodes-rpa`) and give the setup command the address of one of these with `--browser-url`:

| Browser | When | How |
|---|---|---|
| The compose stack's browser | Trying it out | This guide |
| The `rpa-browser` image | One server next to n8n | [Operator guide](../reference/operator.md#where-the-browser-runs) |
| Kubernetes or Amazon ECS | Many runs, n8n in queue mode | [Kubernetes](../deploy/kubernetes.md), [Amazon ECS](../deploy/aws-ecs.md) |
| A Windows machine | Bots that also drive Windows apps | [Windows guide](../install/windows.md) |
| A hosted browser such as Browserless | No browser to run yourself | [Operator guide](../reference/operator.md#where-the-browser-runs) |

To check the browser on its own, import `packages/n8n-nodes-rpa/templates/hello-world.json`, pick the RPA Browser on
both RPA nodes and click **Execute workflow**: **Screenshot example.com** returns a PNG, and **Extract the sandbox
table** returns three items, the first `{ Code: "SKU-1001", ... }`. The sample bot needs the compose stack's n8n: the
name `sandbox` in its addresses exists only inside the stack. For an n8n outside the stack,
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d browser sandbox` publishes the browser at
`ws://127.0.0.1:3000/`. The setup command turns on **Private Network Endpoint** in the RPA Browser credential for a
`ws://` address like this one.

## Part 2: Let it repair itself

A site changes its layout, and a recorded bot breaks. With an AI chat model, a bot can repair itself: the model finds
the new way through the site, a fresh browser proves the repaired steps, and a person approves them by email before
they run. This part builds a second bot from a goal written in plain words, the self-healing data feed, and then
changes the sandbox. It uses what Part 1 made: the RPA Browser, the Site Login and the signing key.

## 6. Add a chat model and an email server

Create these credentials:
- **Anthropic** (or another chat model n8n supports): your API key. The model writes the bot's first steps and
  repairs them when the site changes. It sees the pages, never the Site Login's password.
- **SMTP**: Host `mailpit`, Port `1025`, SSL/TLS off, no user or password. Mailpit catches the approval emails.

## 7. Import the two workflows

1. Import `packages/n8n-nodes-rpa/templates/3-approve-steps.json` (**RPA: 3 Approve steps**). Follow its green
   **Set once** note: the SMTP credential on the four email nodes, RPA Step Signing and RPA Site Login on **Sign steps**,
   and one approver address, such as `approver@example.com`, in **Settings → approver** and in **Sign steps → Approver
   Allowlist**. Click **Publish**.
2. Import `packages/n8n-nodes-rpa/templates/2-data-feed.json` (**RPA: 2 Data feed**). Follow its **Set once** note:
   RPA Browser, RPA Site Login and RPA Step Signing on **Run steps**, your model credential on **Chat model**, the SMTP
   credential on **Alert on failure**, and **RPA: 3 Approve steps** in **Approve steps**. In **Run steps**, open
   **Options** and turn on **Allow Private Network**.

## 8. Build, approve and repair

1. In the data feed, click **Execute workflow**. There are no steps yet, so the chat model explores the sandbox for a
   minute or two, signs in, finds the bulletins the **Goal** describes, and writes steps. A fresh browser then runs
   those steps again without the model to prove them.
2. Open Mailpit (http://localhost:8025). The first email shows what the steps do, the sites they open, and the proof.
   The second asks for your decision: click **Approve**. The steps are signed and saved in the `playwright_steps` Data
   Table as version 1.
3. Execute the data feed again. The output shows `lane: "script"`, `version: 1` and `llmCalls: 0`: the bot ran the
   approved steps without the model. Every scheduled run takes this path.
4. Change the site: open http://localhost:8080/admin (user `admin`, password `change-me`) and click **Shuffle**. Execute
   the feed again. The run repairs itself, sends version 2 for approval, and after you approve it, the next run uses it.

To run the feed every 6 hours, **Publish** it. Replace **Send data to destination** with where the data should go, such
as a spreadsheet or a database node. To let the first bot repair itself too, its RPA node's note lists the three
changes.

## Next

- Your own site in the data feed: copy it, then change `name` in **Settings**, the Site Login, the **Goal** and the
  **ID Pattern** on **Run steps** ([Templates](../reference/templates.md#rpa-2-data-feed)).
- What each operation and step does: [Operations](../reference/operations.md), [Steps](../reference/steps.md).
- When a run fails: [Errors](../reference/errors.md).
