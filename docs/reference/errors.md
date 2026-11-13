# Errors reference

A failed run is an n8n error whose message starts with a code: `<code>: <message>`. A message from a step starts with
the step's intent, for example `Take a screenshot: No element found ...`. A failed desktop step starts with its number
and intent instead, for example `Step 3 (Click Save): no element matched ...`. The error's description in n8n says what to
do. No message holds a URL query string, a token or a user name.

**On the error output.** With **Settings → On Error → Continue (using error output)**, a failure goes to the node's
error output as an item with three fields (n8n sends an item to the error output only when it has no other):

- `error`: `"<code>: <message>"`
- `message`: the message without the code
- `details`: everything else: `code`, `message`, `name`, `version`, `lane`, `hash`, `stepIntent`, `durationMs`,
  `llmTokens` (chat model tokens the run used), `submitted` (`true` once a submit was sent), `log` (the steps that
  finished), `traceRef` (the binary field that holds the scrubbed trace) and `guidance`: what to do, the same text as
  the error's description in n8n, which n8n does not show for an item on the error output. With an RPA Site Login,
  Run Steps adds `account`: the user name it signs in with, never the password or a code

Read them as `{{ $json.details.code }}` and `{{ $json.details.guidance }}`. The workflow the import form hands over
shows the code, the message and the guidance in its **Stop and Error** message and writes them to its run log row.
The error output is output 1 on every operation, and output 2 on Run Steps with AI Repair on and on Import Steps.

A configuration error (a missing credential, a bad option, a setting that must be typed given as an expression) is
not a run failure. On the error output it has `details` `{ configError: true, code: null, ..., guidance }`, the
guidance reading `Check the node parameters and the RPA credentials.` A Sign Steps refusal reads
`Sign Steps refused: <reasons>`.

## Codes

| Code | Meaning | What to do |
|---|---|---|
| `login_failed` | The site rejected the username or password. No further login is tried with them (the login breaker opens). | Correct the username or password in the RPA Site Login or, when its Username and Password are expressions, in the data they read: the next run tries once. If they were right, type a new value (any text, such as today's date) in **Options → Login Breaker Reset Key**. |
| `account_locked` | The site says the account is locked. | Unlock it with the site owner, then change **Options → Login Breaker Reset Key**. |
| `auth_blocked` | The site asked for a second factor this run could not answer. The message says which: no TOTP Secret, or the One-Time Code Workflow gave no code (for example because it is not published). | Add the TOTP Secret to the Site Login, or fix and publish the One-Time Code Workflow. A push message or a hardware key needs a person to sign in. |
| `site_down` | The site did not answer, returned a server error, or the first page did not load in time. | Try again later. |
| `browser_unavailable` | The browser could not be reached, refused the token or the certificate. | Check the RPA Browser credential ([Where the browser runs](../../README.md#where-the-browser-runs)). On a Windows machine, run `rpa status` there. |
| `drift_detected` | A step did not find what it expected: no element, more than one, or one that could not take the action. | Correct the step, or record it again and approve the new version. Browser steps can repair themselves with AI Repair. |
| `not_found` | The page or the data was not found. | Check the URL, the Goal and the trace. |
| `incomplete` | Not every row the page states was read, a capture failed, a limit was hit, the run timed out, or it was cancelled. | Check the trace. Raise **Options → Max Seconds** if runs time out. |
| `script_untrusted` | Nothing ran: the steps are not signed, or the signature does not fit (another Step Signing key, Site Login, name, version or start site). | Approve the steps again. If nobody changed the setup, check who edited the `playwright_steps` table. See [Security](security.md#if-the-signing-key-is-lost-or-changed) for a changed key. |
| `policy_violation` | The run tried something its rules do not allow, and stopped. The first line says what: a site that is not allowed, a write, a password field, an app the runner's policy does not allow, or a desktop write that was not marked. | If it was meant, change the rule that refused it where it is kept: in the RPA Site Login, the RPA Secret Variables credential, the node's Options, or the desktop runner's policy. For a desktop step that saves or sends, the rule is its mark as a write, set when its steps are approved. |
| `locked_out` | No login was tried, because an earlier one with this Site Login failed, or a run changed its password earlier in this execution. | Correct the login in the RPA Site Login or in the data its expressions read, or change the reset key (as for `login_failed`). After a password change, store the new password where the Site Login reads it. |
| `busy` | Another run with this Site Login or this desktop runner is going on. This run was skipped. | Nothing, or run less often. |
| `password_change_failed` | A sign-in set a new password and the site did not confirm it. The login breaker stays closed. | Keep the pending password, and check the site's password rules ([Sign-in](steps.md#sign-in)). |
| `runner_unavailable` | n8n could not use the desktop runner: not reachable, token or certificate refused, Windows session locked, or the app not installed where the policy says. | Check the RPA Desktop Runner credential, then run `rpa status` on the Windows machine ([Windows guide](../install/windows.md#11-when-something-fails)). |

**The login breaker.** With a Site Login, one failed login stops every further login with it and the same username, so
a wrong password does not lock the account. Other accounts of the same Site Login keep running. A changed username, password or TOTP Secret gets one try. In other cases, change **Options →
Login Breaker Reset Key**. A breaker that opened in version 0.2.0 or earlier needs a new reset key in every case. In
queue mode with an RPA Redis credential the breaker is kept in Redis ([Operator guide](operator.md#login-breaker-and-run-lock)).

## Messages

The messages you meet most, word for word:

| Situation | Message |
|---|---|
| No server reachable | `browser_unavailable`: `Could not connect to the browser server at ws://browser:3000/. Is it running? With the compose stack: docker compose up -d browser; on a Windows machine, run rpa status there (README: Where the browser runs).` |
| Wrong token | `browser_unavailable`: `The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.` |
| Version mismatch | `browser_unavailable`: `The browser server is version X but this node needs Y. Use image mcr.microsoft.com/playwright:vY.` |
| Every browser session busy for 60 s | `browser_unavailable`: `The browser service at ws://browser:3000/ had no free browser session for 60 s. Add browser capacity (more replicas or sessions per replica) or start fewer RPA runs at once.` |
| Local Chromium missing | `browser_unavailable`: `Chromium not found. Run: npx playwright install chromium` |
| Certificate not trusted (Browser Server mode, no fingerprint) | `browser_unavailable`: `n8n does not trust the browser server's certificate. If the server uses a certificate of its own, put its SHA-256 fingerprint in Certificate Fingerprint (SHA-256) on the RPA Browser credential.` When the certificate is that of the configured address itself, no request and no token was sent. Read the fingerprint from the certificate file on the server (`openssl x509 -in <certificate file> -noout -fingerprint -sha256`). |
| Certificate not trusted (CDP mode) | `browser_unavailable`: `n8n does not trust the browser server's certificate. Use a certificate that n8n's Node.js process trusts, for example one from an authority listed in NODE_EXTRA_CA_CERTS.` When the certificate is that of the configured address itself, no request and no token was sent. |
| Certificate does not match the fingerprint | `browser_unavailable`: `The browser server's certificate does not match the Certificate Fingerprint in the RPA Browser credential.` No request and no token was sent. Check on the server whether its certificate was replaced. If not, something else answers at that address. |
| Malformed fingerprint | `browser_unavailable`: `The certificate fingerprint must be 64 hexadecimal characters (SHA-256), with or without colons.` |
| Fingerprint with a `ws://` address | `browser_unavailable`: `A certificate fingerprint needs a wss:// Endpoint URL in Browser Server mode.` |
| Not http(s) | `policy_violation`: `URL must start with http:// or https:// (got "file:").` |
| Private address | `policy_violation`: `Blocked: intranet.example resolves to a private network address. Turn on Options → Allow Private Network if this site is on your own network.` |
| Site that is not allowed | `policy_violation`: `Blocked: the page tried to open cdn.other.com, which is not allowed. This run only visits example.com. Add it under Options → Also Allow These Sites if this is expected.` |
| A secret on a host not listed | `policy_violation`: `<step>: A value from the RPA Secret Variables credential may not be typed on erp.example.com: the credential's May Be Typed Into does not list it.` |
| A desktop app not listed for the secrets | `policy_violation`: `The RPA Secret Variables credential's May Be Typed Into does not list ErpDemo.exe, so this run may not start it. Add ErpDemo.exe there, or remove the credential from this node.` |
| A blocked POST | `policy_violation`: `<step>: a blocked request was attempted during the run: POST <host/path>. If it only reads data, list it in the RPA Site Login under Requests That Only Read ...` |
| Locator not found | `drift_detected`: `No element found for Visible Text "Sign In" on https://example.com/account after 30 s. Check the spelling or try Find by: Role and Name.` |
| Not unique | `drift_detected`: `Visible Text "Submit" matches 3 elements. Use a more specific locator; it must match exactly one.` |
| Not signed | `script_untrusted`: `The steps are not signed, or the signature is not valid, and Require Signed Steps is on. Sign them with Sign Steps first. To sign a bot again, for example after the signing key changed, open the import form, leave Bot file empty and type the bot's name.` Steps signed with an earlier Step Signing key get this too. On **RPA: 5 Import a bot**, the bot's name opens a page with the steps that run now: submit them unchanged to sign them again. |
| Count mismatch | `incomplete`: `Expected 120 rows (the page says "120 results") but found 117. Nothing was marked successful.` |
| Breaker open | `locked_out`: `A previous login for example.com failed, so no login was tried.` |
| Runner's address gets no answer | `runner_unavailable`: `Could not connect to the desktop runner at wss://...:8765/rpa/v1 (no answer within 10 s). Check, in this order: 1. The address in the Connection Line is one n8n can reach. ...` Nothing answered the connection itself within 10 seconds. When the line's address is a private one (10.x, 172.16.x to 172.31.x, 192.168.x, fc00::/7, fe80::/10), the message says so and gives the whole command that prints the line again with the right address: `& "C:\Program Files\RPA Runner\rpa.cmd" connection -ShowTokens -Address`, followed by the name or address n8n can reach, in an administrator PowerShell. |
| Runner not reachable | `runner_unavailable`: `Could not connect to the desktop runner at wss://...:8765/rpa/v1 (...). Is it running, and is the port open?` The connection was refused, or it was made and the runner did not answer within 60 seconds. In the mode where nobody is signed in, the sign-in takes part of that time. |
| Runner's desktop locked | `runner_unavailable`: `the desktop runner's Windows session is locked: unlock it or sign the runner user in again` |
| Runner token wrong | `The desktop runner at ... refused the token. Check the Token in the RPA Desktop Runner credential.` |
| Runner certificate changed | `The desktop runner at ... presented a certificate with fingerprint ..., which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.` |
| App not allowed | `policy_violation`: `the desktop runner is not allowed to start ErpDemo.exe. On the Windows machine, allow it: in the RPA Recorder choose "Allow this app…" after saving a recording of it, or as an administrator run: ...` |
| App not installed | `runner_unavailable`: `the desktop runner could not start ErpDemo.exe: it is not installed at the path the runner's policy names (allowedApps[].path). ...` |
| Runner busy | `busy`: `the desktop runner is busy with another run` |
| Missing variable | `missing input "<name>"`, followed by `(a secret goes in an RPA Secret Variables credential, any other value in Options → Variables)` |

Windows-side failures (the supervisor, the installer, the policy tool) are in the
[Windows guide](../install/windows.md#11-when-something-fails).
