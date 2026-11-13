# Your first Windows desktop bot

This guide installs RPA on a Windows machine, sets n8n up for it with one command, records a bot in a Windows app,
approves it, and runs it from n8n with nobody signed in to Windows. It uses **ERP Demo**, a small sample app that comes
with the package. Plan for about 30 minutes.

> **Not released yet.** The Windows package and the n8n node version it needs (0.2.0) have not been published as a
> release. Until they are, build the package as [`desktop/README.md`](../../desktop/README.md#building-and-testing)
> says and run n8n from this repository's compose stack (step 1 of the [browser bot guide](browser-bot.md)).

## What you need

- **n8n** with the RPA node, version 0.2.0 or later. The quickest way is the compose stack in this repository:
  `printf 'BROWSER_TOKEN=%s\nN8N_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env`, then
  `docker compose up --build -d`. Open http://localhost:5678 and create the owner account. When n8n offers its own
  Assistant, choose **Set up later in Settings**.
- **A Windows Server 2019 or later machine** (a virtual machine is fine) with an administrator account. n8n must reach
  it on TCP port 8765 (the runner). Note n8n's address as the Windows machine sees it.
- The app your bot drives, installed for all users under `C:\Program Files`. ERP Demo already is.

Two words first. The **bot user** is the Windows account the bots work as (`rpa-runner`). A **Connection Line** is one
line of text with all n8n needs to reach the Windows machine: its address, a token and its certificate's fingerprint.

## 1. Install RPA on Windows

On the Windows machine, open **Windows PowerShell** as administrator (Start, type `Windows PowerShell`, right-click it,
**Run as administrator**). Download the installer script and run it, with your n8n's address after `-AllowFrom`:

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
Invoke-WebRequest -UseBasicParsing https://github.com/jb-n8n/n8n-nodes-rpa/releases/download/desktop-v<version>/Get-Rpa.ps1 -OutFile Get-Rpa.ps1
Set-ExecutionPolicy -Scope Process Bypass -Force
.\Get-Rpa.ps1 -AllowFrom <n8n address>
```

The installer lists what it will change and asks you to type `YES`. On Windows Server it sets up the **unattended**
mode: a Windows service signs the bot user in when n8n connects and signs it out afterwards, so nobody needs to stay
signed in. It prints `RPA is installed.` and a summary.

In the same PowerShell, print the Connection Line with its token, and keep the window open for step 2:
`& "C:\Program Files\RPA Runner\rpa.cmd" connection -ShowTokens`. The line starts `rpa-runner://`. Its address is the
one this machine has towards the n8n address you gave `-AllowFrom`, and the command says which. If n8n reaches the
machine by another name or address (a NAT, a tunnel), run the command again with `-Address <that name or address>`.

## 2. Set up n8n with one command

One command makes the **import form**, where you upload a bot, read its steps and approve them, and connects the
Windows machine. In n8n, make an API key: **Settings → n8n API → Create API key**, with an expiry. Under **Scopes**,
choose **Custom** and tick `workflow:create`, `workflow:read`, `workflow:update`, `workflow:delete`, `workflow:list`,
`workflow:activate`, `credential:create`, `credential:read`, `credential:update`, `credential:list` and `user:read`.

With the compose stack, run the command inside the n8n container, in the repository folder. Nothing to install:

```bash
docker compose exec n8n /opt/n8n-rpa/node_modules/.bin/n8n-nodes-rpa setup
```

For another n8n, run `npx n8n-nodes-rpa setup --url <n8n address>` (Node.js 22 or later). Until 0.2.0 is on npm, run
`pnpm install`, `pnpm --filter n8n-nodes-rpa build`, then `node packages/n8n-nodes-rpa/dist/setup.mjs setup` instead.

Paste the API key when it asks `n8n API key (not shown):`. Answer `y` to `Connect a Windows machine now?`, and paste
the `rpa-runner://` line at `Paste the line that starts with rpa-runner:// (not shown):`. The terminal shows nothing
while you paste. Close the PowerShell window on Windows afterwards: the line holds a token.

The command creates the **RPA Desktop Runner** credential with the line, an **RPA Step Signing** key, and the workflow
**RPA: 5 Import a bot** with both on its node **Import steps**, and publishes it. **Signing** marks steps as approved:
the bot runs only steps whose signature matches. You are the approver (`--approver` names another). Then n8n tests
the connection: the line that starts `tested` says `Connected to the desktop runner`, or why it could not. A new line
goes into the credential's **Connection Line** in n8n. The command ends with:

```text
The import form is ready.
  Address:    http://localhost:5678/form/<id>
  Sign-in:    the form opens with your n8n sign-in. Who approves is recorded as the n8n user who approved.
```

If you made an RPA Desktop Runner credential in n8n already, answer `n` instead: the command picks it when your project
has only that one, and names it. With several, add `--desktop-runner "<its name>"`. It never reads a credential's
values. The signing key stays in n8n, which does not show it again: the command's note says how to keep a copy. A lost
key means approving every bot again ([sign it again](move-a-bot.md#change-an-approved-bot-or-sign-it-again)). The
command's last line is about the API key: revoke it when you are done (**Settings → n8n API**, **⋯**, **Revoke**).
Run the command again at any time: it reuses only what your own project holds, asks first in a shared project, and
leaves a workflow there already as it is. `--form-login basic` serves approvers with no n8n account. To set the form
up by hand, import `packages/n8n-nodes-rpa/templates/5-import-a-bot.json` ([Templates](../reference/templates.md#set-it-up-by-hand)).

Open the form's address once, in your browser, and sign in to n8n. The first time, n8n asks whether the form may use
your n8n login: choose **Allow access**. Someone who may not run the form's workflow sees n8n's own page
`Authorization unavailable` instead.

## 3. Record the bot

1. On the Windows machine, sign in to **your own administrator session** (not as the bot user). Open **RPA Recorder**
   from the Start menu. A narrow bar opens at the top right of the screen and says `Ready`.
2. Choose **Start an app…**, then **Browse…** and pick `C:\Program Files\RPA Runner\erp-demo\v1\ErpDemo.exe`. Choose
   **Start recording**. The bar says `Recording ErpDemo.exe`.
3. Do the work once, as the bot should do it: sign in as `clerk` with the password `demo1234`, choose `1000` in
   **Company code**, click **Search**, then **File → Export...** and **Save**. Each step shows on the bar as a
   sentence. The recorder does not read the password box: that step types a **secret**, which n8n supplies later.
4. To return a value to n8n, point at it in the app (for example the result count) and press **F9**. In the
   **Read a value** window, keep or change the **Output name**, then choose **Add read step**.
5. Choose **Finish**. The bar asks `Which of these change from run to run?`. Tick the company code, keep the suggested
   name, and choose **Continue**.
6. Choose **Save**. The bar saves the recording in `Documents\RPA recordings` and lists two things left to do.
7. Next to **1. Allow ErpDemo.exe on this machine**, choose **Allow this app…**. Windows asks for administrator rights,
   and the policy tool shows what it will allow and asks: type `y` and Enter. The **policy** is the list of apps the
   bot may start, kept on this machine.
8. Next to **2. Import the recording in n8n**, choose **Open the import form**. The first time, it asks for the form's
   address: the one step 2 printed, with n8n's address as this machine sees it in place of `localhost`. Sign in to n8n
   in the browser that opens, and choose **Allow access** if n8n asks. The browser may offer to save the password. The
   recorder put the file's path on the clipboard: click **Bot file**, paste it in the window that opens, and Enter.

If this machine cannot reach n8n, choose **Show the file** instead, copy the `.rpa-recording.json` file to the computer
you use n8n from, and open the form there. [Record a bot](record-a-bot.md) explains every stage of the bar.

## 4. Import and approve

1. On the form (step 2 set it up, with its options), with the recording in **Bot file**, type `erp-line-items` in
   **Name for the steps**, and click **Submit**.
2. The next page, **Review and approve**, lists the steps by number. The lighter, grey steps are the ones the import
   added (a wait for each window, and one for the file the bot returns). Under **Which of these steps save, send or
   submit?**, keep **Click Save** ticked, and untick a step that does not save or send. Choose **Approve and sign**,
   then **Submit**.

   <img src="../images/import-review-page.png" alt="The Review and approve page for the ERP Demo recording: the numbered steps, the tick boxes and the decision" width="360">

3. The last page says `Approved and signed: erp-line-items v1 is now the version that runs under that name.` The
   browser downloads `erp-line-items.workflow.json`, the workflow that runs the bot. The signed row records your n8n
   address as **approvedBy**. Someone not on **Sign steps → Approver Allowlist** cannot approve: the last page says
   `Sign Steps refused` and nothing is signed.

## 5. Run it

1. In n8n, create a workflow, **⋯ → Import → From File**, and pick `erp-line-items.workflow.json`, in the
   **Downloads** folder of the computer you approved on.
2. The RPA node is named after your recording (here **ErpDemo recording**). Its **RPA Desktop Runner** and **RPA Step
   Signing** credentials are already picked: the setup command put them on the import form, and the form passes them
   on. Its **Runs On** is **A Windows desktop app**, so the node shows only the three slots a desktop bot uses.
3. The third slot is yours: the password. On that node, create an **RPA Secret Variables** credential with one
   variable, the name the node's note gives (such as `password`) and the value `demo1234`. As the gold note says, put
   `ErpDemo.exe` in its **May Be Typed Into** to keep the password to this app. **Options → Variables** already holds
   the company code you ticked, starting with the value you recorded.
4. Run the workflow (the **Execute** button at the bottom of the canvas). On the Windows machine nobody needs to be
   signed in: the service signs the bot user in, ERP Demo opens, works and closes, and the bot user is signed out
   again. The output holds the values you read with F9 under `values`, and the exported file in the **Binary** tab.

The first run after a quiet time waits while Windows signs the bot user in, about 5 to 20 seconds. If it fails with
`runner_unavailable`, run it again, then see the [Windows guide](../install/windows.md#11-when-something-fails).

Each run writes one row to the `playwright_runs` Data Table (**Log run**). A failed run writes its error code there
(**Log failed run**) and then stops at **Stop and Error**, so it shows as failed under **Executions**. To run the bot
on a schedule, open **On a schedule**, set the time, turn the node on, and **Publish** the workflow. To be told when a
scheduled run fails, choose an Error Workflow in the workflow's settings.

## Next

- Your own app: install it for all users, record it the same way, and allow it with **Allow this app…**. To protect
  its Save and Post buttons, an administrator lists them in the policy ([Windows guide](../install/windows.md#8-allow-your-own-app)).
- Change a value per run: map **Options → Variables** from an earlier node, such as a spreadsheet row.
- Who may hold the secret variables, and how approval works: [Security](../reference/security.md).
