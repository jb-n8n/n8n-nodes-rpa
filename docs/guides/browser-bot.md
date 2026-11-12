# Your first browser bot

This guide starts n8n with the RPA node and a browser on your computer, takes a first screenshot, then builds a bot
that signs in to a sample site with a password and a one-time code, reads data, and keeps working when the site
changes. It takes about 20 minutes. You need Docker with Compose, `openssl`, and a copy of this repository.

The sample site is the **sandbox**: a small site in this repository that changes its layout when you ask it to. To
move a bot you already have instead, see [Move a bot](move-a-bot.md).

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
- Mailpit, an inbox for approval emails, at http://localhost:8025

Open http://localhost:5678 and create the owner account. If the page does not show the setup form yet, n8n is still
starting: reload after a minute. When n8n offers its own Assistant, choose **Set up later in Settings**.

**Where else the browser can run.** The compose stack is the quickest start. For your own n8n, install the node
from **Settings → Community nodes → Install** (package `n8n-nodes-rpa`) and point the RPA Browser credential at one of
these:

| Browser | When | How |
|---|---|---|
| The compose stack's browser | Trying it out | This guide |
| The `rpa-browser` image | One server next to n8n | [Operator guide](../reference/operator.md#where-the-browser-runs) |
| Kubernetes or Amazon ECS | Many runs, n8n in queue mode | [Kubernetes](../deploy/kubernetes.md), [Amazon ECS](../deploy/aws-ecs.md) |
| A Windows machine | Bots that also drive Windows apps | [Windows guide](../install/windows.md) |
| A hosted browser such as Browserless | No browser to run yourself | [Operator guide](../reference/operator.md#where-the-browser-runs) |

## 2. Connect n8n to the browser

A **credential** is where n8n keeps an address and its secret. In n8n's left sidebar, choose
**+ → New credential → RPA Browser**, and fill in:

- **Mode**: Browser Server
- **Endpoint URL**: `ws://browser:3000/`
- **Token**: the value after `BROWSER_TOKEN=` in `.env` (print it with `grep BROWSER_TOKEN .env`)
- **Private Network Endpoint**: on. The browser is on the stack's own network, which is a private address.

Click **Save**. The window says `Connection tested successfully`.

## 3. Take a first screenshot

Create a workflow, then **⋯ → Import → From File** and pick `packages/n8n-nodes-rpa/templates/hello-world.json`. Pick your
RPA Browser credential on both RPA nodes, and click **Execute workflow**.

- **Screenshot example.com** returns `title`, `status: 200` and a PNG (open the **Binary** tab).
- **Extract the sandbox table** returns three items, the first `{ Code: "SKU-1001", Product: "Widget", Price: "$10.00", Stock: "12", ... }`.
  The sandbox is on your own network, so that node has **Options → Allow Private Network** on. Leave it off for public
  sites.

If the run fails, read the message:

| You see | What to do |
|---|---|
| `browser_unavailable: Could not connect to the browser server at ws://browser:3000/. Is it running? ...` | Start the browser: `docker compose up -d browser`. |
| `browser_unavailable: The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.` | Copy the token from `.env` into the credential again. |
| `policy_violation: Blocked: sandbox:8080 resolves to a private network address. ...` | Turn **Options → Allow Private Network** on for the sandbox. |

**n8n outside the stack** (n8n on your machine): start the browser and the sandbox with
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d browser sandbox`, and use `ws://127.0.0.1:3000/`
as the Endpoint URL with the same token. The sandbox's name does not resolve on your machine: point the Extract node at
`http://<ip>:8080/public/table`, with the address that
`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(docker compose ps -q sandbox)` prints.

## 4. Add the sign-in and the other credentials

A **Site Login** is the credential for one site: its username, password and one-time code secret, and the pages the
bot may open. The bot types the password only on the pages listed there. The steps do not contain it, and the bot
masks it in its logs and in what it sends to an AI model. Create these credentials. The values are the sandbox's sample values, not real
secrets.

- **RPA Site Login**:
  - Login Page URL `http://sandbox:8080/acme/login`, Username `summit-ops`, Password `demo-password`, TOTP Secret `JBSWY3DPEHPK3PXP`
  - Sites the Browser May Open `sandbox:8080`
  - Pages Where the Password May Be Typed `sandbox:8080/acme/login` and `sandbox:8080/acme/mfa` (one per line)
  - Forms It May Submit `POST sandbox:8080/acme/reports/export`
  - Requests That Only Read `POST sandbox:8080/sap*/bc/gui/sap/its/webgui` and `POST sandbox:8080/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch` (one per line)
- **RPA Step Signing**: a key of 32 or more random characters. Let your password manager generate one, or run
  `openssl rand -hex 32`. **Signing** is how a person's approval is attached to steps: the bot runs only steps whose
  signature matches this key.
- **Anthropic** (or another chat model n8n supports): your API key. The data feed's chat model builds the bot's first
  steps and repairs them when the site changes.
- **SMTP**: Host `mailpit`, Port `1025`, SSL/TLS off, no user or password.

## 5. Import the two workflows

1. Import `packages/n8n-nodes-rpa/templates/3-approve-steps.json` (**RPA: 3 Approve steps**). Follow its green
   **Set once** note: the SMTP credential on the four email nodes, RPA Step Signing and RPA Site Login on **Sign steps**,
   and one approver address, such as `approver@example.com`, in **Settings → approver** and in **Sign steps → Approver
   Allowlist**. Click **Publish**.
2. Import `packages/n8n-nodes-rpa/templates/2-data-feed.json` (**RPA: 2 Data feed**). Follow its **Set once** note:
   RPA Browser, RPA Site Login and RPA Step Signing on **Run steps**, your model credential on **Chat model**, the SMTP
   credential on **Alert on failure**, and **RPA: 3 Approve steps** in **Approve steps**. In **Run steps**, open
   **Options** and turn on **Allow Private Network** (the sandbox is on your own network).

## 6. Build, approve and run the bot

1. In the data feed, click **Execute workflow**. There are no steps yet, so the chat model explores the sandbox for a
   minute or two, signs in, finds the data the **Goal** describes, and writes steps. A fresh browser then runs those
   steps again without the model to prove them.
2. Open Mailpit (http://localhost:8025). The first email shows what the steps do, the sites they open, and the proof.
   The second asks for your decision: click **Approve**. The steps are signed and saved in the `playwright_steps` Data
   Table as version 1.
3. Execute the data feed again. The output shows `lane: "script"`, `version: 1` and `llmCalls: 0`: the bot ran the
   approved steps without the model. Every scheduled run takes this path.
4. Change the site: open http://localhost:8080/admin (user `admin`, password `change-me`) and click **Shuffle**. Execute
   the feed again. The run repairs itself, sends version 2 for approval, and after you approve it, the next run uses it.

To run the bot every 6 hours, **Publish** the data feed. Replace **Send data to destination** with where the data
should go, such as a spreadsheet or a database node.

## Next

- Your own site: copy the data feed, then change `name` in **Settings**, the Site Login, the **Goal** and the
  **ID Pattern** on **Run steps** ([Templates](../reference/templates.md#rpa-2-data-feed)).
- Record a site instead of having the model explore it: [Move a bot](move-a-bot.md).
- What each operation and step does: [Operations](../reference/operations.md), [Steps](../reference/steps.md).
- When a run fails: [Errors](../reference/errors.md).
