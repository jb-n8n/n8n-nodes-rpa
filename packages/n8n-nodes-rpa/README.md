# n8n-nodes-rpa

RPA for self-hosted [n8n](https://n8n.io): a community node that drives a browser and Windows desktop apps the way a
person would. It signs in, clicks, types, reads values and tables, and downloads files. Together with n8n it can do
the work of a UiPath or Power Automate Desktop bot, and you can move existing bots over yourself. By default a bot runs
only steps that a person reviewed and approved.

A personal open-source project (MIT), not an official n8n product. Documentation:
**https://github.com/jb-n8n/n8n-nodes-rpa**

## Install

In a self-hosted n8n 2.41 or later: **Settings → Community nodes → Install**, package `n8n-nodes-rpa`. n8n must allow
the install of unverified community packages. n8n Cloud runs only verified community nodes, and a node that drives a
browser cannot be verified, so this package is for self-hosted n8n only. To install from the GitHub Release tarball,
or in queue mode, see the
[Operator guide](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/operator.md#install-the-node).

The node does not ship a browser. Point its **RPA Browser** credential at a browser server, such as the `rpa-browser`
image (`ghcr.io/jb-n8n/rpa-browser`), a hosted endpoint such as Browserless, or the browser the Windows package installs.

## Three ways in

- **A browser bot**: [Your first browser bot](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/guides/browser-bot.md)
- **A Windows desktop bot**: [Your first Windows desktop bot](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/guides/desktop-bot.md)
- **Move a bot you already have** (UiPath, a recording, Playwright code, Power Automate Desktop):
  [Move a bot](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/guides/move-a-bot.md)

## Operations

Screenshot, Get Page, Save as PDF, Extract Data, Fill and Submit Form and Download File take a URL and one or two
fields. **Run Steps** runs a signed list of browser or desktop steps, and can repair browser steps with an AI chat
model when a site changes. **Import Steps** turns a recording, code or a UiPath project into steps for approval.
**Sign Steps** signs them once a person approved them. Reference:
[Operations](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/operations.md),
[Steps](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/steps.md),
[Errors](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/errors.md).

## Templates

The package's `templates/` folder (also in the repository's
[`packages/n8n-nodes-rpa/templates`](https://github.com/jb-n8n/n8n-nodes-rpa/tree/main/packages/n8n-nodes-rpa/templates)):

| Template | What it does |
|---|---|
| RPA: Hello world | A first screenshot and a table from the sample site |
| RPA: 0 Connection check | One screenshot of your site, to show the browser reaches it |
| RPA: 2 Data feed | Runs approved steps on a schedule, and repairs them with AI when the site changes |
| RPA: 3 Approve steps | Approval by email: emails the evidence, waits for a person, signs the steps |
| RPA: 5 Import a bot | A form: upload a bot, review and approve it, download the workflow that runs it |

## Security and support

What a run may do, how signing and approval work, and the accepted risks:
[Security](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs/reference/security.md). Support is best effort,
through [GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues). Report vulnerabilities as
[SECURITY.md](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/SECURITY.md) describes. Changes:
[CHANGELOG](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/CHANGELOG.md). License:
[MIT](https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/LICENSE).
