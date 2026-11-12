# n8n-nodes-rpa: RPA for n8n

RPA is an n8n community node that drives a browser and Windows desktop apps the way a person would: it signs in,
clicks, types, reads values and tables, and downloads files. Together with n8n it can do the work of a UiPath or Power
Automate Desktop bot, including one that drives a Windows app, and you can move your existing bots over yourself. By
default a bot runs only steps that a person reviewed and approved.

> **Status:** early. Version 0.1.0 (browser bots) is on npm. Windows desktop bots, the recorder and approval on the
> import form are in the next release, which is not published yet. Self-hosted n8n only. A personal open-source project
> (MIT), not an official n8n product. See [Project status](#project-status).

## What it replaces

| What your bot does today | How you do it here |
|---|---|
| Signs in to a website, with a one-time code | A **Site Login** credential and a `signIn` step: the password stays in n8n's credential store |
| Clicks, types and reads on a website | Browser steps, recorded with Chrome's Recorder or written as a step list |
| Clicks, types and reads in a Windows app | Desktop steps, recorded with the RPA Recorder on the Windows machine |
| Exports a report and saves the file | A `download` step (browser) or `expectFile` step (desktop) that returns the file to n8n, with checks on its name and columns |
| Runs on a schedule on a robot machine | An n8n Schedule Trigger. On Windows Server, nobody needs to be signed in |
| Excel, email, HTTP calls, loops and decisions | n8n's own nodes around the steps |
| Breaks when the screen changes | Browser steps can repair themselves with an AI chat model. A person approves every repair |

## Three ways in

### A browser bot

1. Start n8n, a browser and a sample site with `docker compose up` from this repository.
2. Connect n8n to the browser with an **RPA Browser** credential and take a first screenshot.
3. Add an **RPA Site Login** for the sample site and import the data feed template.
4. Run it: a chat model writes the first steps, you approve them in an email, and the next runs need no model.

Guide: [Your first browser bot](docs/guides/browser-bot.md).

### A Windows desktop bot

1. On Windows Server, run `.\Get-Rpa.ps1 -AllowFrom <n8n address>` in an administrator PowerShell.
2. Paste the **Connection Line** it gives you into an **RPA Desktop Runner** credential in n8n.
3. Record the work with the **RPA Recorder**, and allow the app with one button.
4. Upload the recording on the **Import a bot** form, review the steps and approve them.
5. Import the workflow the form gives you and run it.

Guide: [Your first Windows desktop bot](docs/guides/desktop-bot.md).

### Move a bot you already have

1. Set up the **Import a bot** form with one command: `npx n8n-nodes-rpa setup`.
2. Upload a UiPath project, a Chrome Recorder export, Playwright code, an RPA recording, or steps you wrote.
3. Review what the import made, and what it left out, on the next page. Approve it.
4. Import the workflow it gives you and run it.

Power Automate Desktop has no importer: the guide maps its actions to n8n nodes and steps.
Guide: [Move a bot](docs/guides/move-a-bot.md).

## How approval works

An import or an AI repair makes a draft. Nothing in it runs until a person approves it. By default, the person who
imports a bot reviews every step on the import form and chooses **Approve and sign**. The steps are then signed with
the **RPA Step Signing** key, and the bot runs only steps whose signature matches. A team that wants a second person to
decide turns on approval by email in the form's settings. Details: [Security](docs/reference/security.md#signing-and-approval).

## Where the browser runs

The node does not ship a browser. The **RPA Browser** credential points at one:

| Browser | When |
|---|---|
| The compose stack in this repository (`ws://browser:3000/`) | Trying it out ([browser bot guide](docs/guides/browser-bot.md)) |
| The browser the Windows package adds with `-WithBrowser` | Bots on that Windows machine ([Windows guide](docs/install/windows.md)) |
| The `rpa-browser` image, on Kubernetes or Amazon ECS | Production ([Kubernetes](docs/deploy/kubernetes.md), [Amazon ECS](docs/deploy/aws-ecs.md)) |
| A hosted browser such as Browserless | No browser to run yourself |

If n8n cannot connect, start the compose stack's browser with `docker compose up -d browser`, or on a Windows machine
run `rpa status` there. Every option, the token gate, TLS and version matching:
[Operator guide](docs/reference/operator.md#where-the-browser-runs).

## Where things live

| Page | What it covers |
|---|---|
| [Your first browser bot](docs/guides/browser-bot.md) | From nothing to a browser bot that repairs itself |
| [Your first Windows desktop bot](docs/guides/desktop-bot.md) | Install, connect, record, approve and run |
| [Record a bot](docs/guides/record-a-bot.md) | The RPA Recorder, stage by stage |
| [Move a bot](docs/guides/move-a-bot.md) | UiPath, recordings, Playwright code, step documents, Power Automate Desktop |
| [Windows guide](docs/install/windows.md) | For the administrator: install, sign-in modes, the `rpa` command, allowing apps, upgrades, failures |
| [Operations](docs/reference/operations.md) | Each node operation and its fields |
| [Steps](docs/reference/steps.md) | Every browser and desktop step, locators, conditions, sign-in |
| [Templates](docs/reference/templates.md) | The workflow templates and the Data Tables |
| [Errors](docs/reference/errors.md) | Error codes and messages, and what to do |
| [Security](docs/reference/security.md) | What a run may do, signing, approval, secrets, accepted risks |
| [Operator guide](docs/reference/operator.md) | Installing the node, the browser service, queue mode |
| [Deploying the browser](docs/deploy/kubernetes.md) | Kubernetes and EKS, and [Amazon ECS](docs/deploy/aws-ecs.md) |
| [Licensing note](docs/install/licensing.md) | What Microsoft's terms say about unattended automation on Windows |
| [Third-party licences](THIRD-PARTY-NOTICES.md) | The software by others in the two Windows zips, the browser image and the npm package, with its licences (each zip carries its own part and the licence texts) |
| [Changelog](CHANGELOG.md), [Security policy](SECURITY.md) | What changed, and how to report a vulnerability |

## Project status

What exists:
- The node with nine operations and six credentials, and four workflow templates plus a hello-world.
- The Windows package: the desktop runner, the browser, the RPA Recorder, the policy tool and a one-command installer.
- End-to-end runs on a real n8n and a real Windows Server 2022: a recorded desktop bot from install to a scheduled run,
  a browser bot through the import form, and the self-healing data feed against the sample site.
- A security review of the browser engine, the node and the compose stack ([report](docs/security-review.md)). The
  desktop runner, the recorder, the Windows installer and the import form came later and are not in it.

Known limits:
- **Self-hosted n8n only.** n8n Cloud runs only verified community nodes, and a node that drives a browser cannot be
  verified.
- **Not released yet:** the Windows package and node version 0.2.0. The Windows package is not code-signed.
- **Windows:** tested on Windows Server 2022 (CI also installs it on Windows Server 2025). Windows 10 and 11 were not
  tested. The recorder was tried on WinForms and Win32 apps only.
- **n8n connects in to the Windows machine.** The machine never dials out to n8n, so n8n must reach it on the runner's port. Where it cannot, a private network or tunnel between them is needed, and the product does not provide one ([Windows guide](docs/install/windows.md#who-can-reach-the-ports)).
- **Desktop steps** have no AI repair, no replay before approval, no loops and no right-click, scroll or drag
  ([Steps](docs/reference/steps.md#desktop-steps)).
- **AI-built and AI-repaired steps** read record IDs only, and AI repair does not write.
- **No equivalent** for SAP GUI for Windows, Citrix, image or text recognition on the screen, or Java apps.

## Development

You need Node.js 22.12 or later, pnpm 10.32.1, Docker with Compose, and a local Chromium for the engine tests
(`npx playwright@1.63.0 install chromium`).

```bash
pnpm install
pnpm -r build
pnpm test
```

The repository holds the engine (`packages/engine`), the node (`packages/n8n-nodes-rpa`), the sample site
(`sandbox/portal`), the browser image (`images/browser`), the deployment files (`deploy/`) and the Windows package
(`desktop/`). [CONTRIBUTING.md](CONTRIBUTING.md) has the rest: every suite, the layout and the rules for changes.
