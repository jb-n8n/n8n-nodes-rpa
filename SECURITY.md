# Security policy

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on [the repository](https://github.com/jb-n8n/n8n-nodes-rpa/security/advisories/new). Do not open an issue, pull request or discussion for a vulnerability: they are public.

Include what you ran (operation, credential mode, options), what happened, what you expected, and a minimal reproduction. Leave real secrets out of the report: describe them, or use the synthetic values from the sandbox.

Please keep the report private until a fixed version is published or we agree on a date. You will get a first answer within a week; this is a personal project, so fixes are best effort.

## Supported versions

Only the latest published version of `n8n-nodes-rpa` on npm, and the latest `ghcr.io/jb-n8n/rpa-browser` image, are supported. Fixes land on `main` and ship in a new version.

## Scope

In scope:
- The engine (`packages/engine`) and the n8n node and credentials (`packages/n8n-nodes-rpa`), including the templates.
- The `rpa-browser` image (`images/browser`): the token gate in front of the browser server, its supervisor and its Dockerfile.
- The compose stack and images: `docker-compose.yml`, `docker-compose.dev.yml`, `docker/`.

Out of scope:
- The sandbox site (`sandbox/portal`). It is a deliberately weak mock site with attack pages for tests; its synthetic passwords, TOTP secrets and missing protections are intended.
- Vulnerabilities in n8n, Playwright, Chromium or Mailpit themselves. Report those to their maintainers; tell us if this project makes one easier to exploit.
- Anything that needs control of the n8n instance, its database or the workflow editor beyond what the safety model below says a workflow editor can do.

## What the safety model guarantees

The full rules are in the README, [Safety model](README.md#safety-model). In short, a report is a vulnerability when one of these does not hold:

- A run opens only the sites its operation allows: the URL's site plus **Also Allow These Sites**, or, with a Site Login, only the sites listed in that credential.
- Sites on your own network (loopback, private, link-local, shared address space) are blocked as literal addresses, as names that resolve to them and on every redirect hop, unless **Allow Private Network** is on.
- Read operations send nothing: only GET, HEAD and OPTIONS leave the browser. Writes happen only where the operation allows them: the submit click of Fill and Submit Form, or the `submit` and `download.via` targets that steps declare (signed, or allowed for unsigned steps), each only while its own step runs and at most 3 times. AI repair and its proof send no writes and stop on a page address that names a destructive action.
- Site Login secrets reach a page only through a `signIn` step on a listed login page, and every text output, error and trace passes through a masker that holds every secret of the run.
- With **Require Signed Steps** on, only steps signed with the Step Signing key run, and a signature is bound to its Site Login.
- The six literal-only settings (**Require Signed Steps**, **Allow Private Network**, **Allow Unsigned Writes**, **Deliver Unconfirmed Rows**, Run Steps' **Login Breaker Reset Key** and Sign Steps' **Approver Allowlist**) cannot be switched by item data.
- Pages cannot open channels the engine does not see: shared workers, WebSockets from workers, WebSocketStream, WebTransport and WebRTC are unavailable in every frame.
- The browser gate forwards only connections that carry the token and refuses launch options other than `headless`, `timeout` and `slowMo`.

The README lists the accepted risks (one shared signing key, side effects of GET requests, Data Table write access, secrets drawn in images or canvas, and others). Reports that only restate an accepted risk are welcome as hardening suggestions, but are not treated as vulnerabilities.
