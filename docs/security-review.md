# Security review (October 2026)

Three independent reviews, one per boundary: network egress, secrets and step integrity, and the AI agent plus
infrastructure and supply chain. Each finding was fixed test first: a new test failed on the old code and passes on the
fix. An automated review then re-checked every fix, and its findings were fixed the same way.

No reviewer found a way to run steps nobody approved. The signing chain (canonical JSON, HMAC binding, timing-safe
compare, Expected Version, Sign Steps' rechecks) held.

## Findings and fixes

| ID | Severity | Finding | Fix |
|---|---|---|---|
| N-H1 | High | Shared workers, and WebSockets opened from any worker, never reached `context.route` or `routeWebSocket`: no allowlist, no private-address block, no write block, no log. Reproduced against a Playwright server. `WebSocketStream` and `WebTransport` bypassed the same way. | An init script in every frame (`browser/harden.ts`) removes `SharedWorker`, `WebSocketStream`, `WebTransport` and WebRTC, and starts each `Worker` through a `blob:` loader that deletes `WebSocket` in the worker before loading the original script. Page script cannot restore them. |
| N-M1 | Medium | WebRTC TURN over TCP reached any host and port. | Covered by the same init script. |
| A1 | Medium | Prompt injection could steer the AI repair agent into GET side effects: a link with `?action=cancel`, a GET form to `/admin/purge`, `formaction`. The denylist only saw names and the href path. | The click check runs the denylist on the full decoded address and on form targets, with a wider word list matched as whole words. In agent and proof sessions, a navigation to a destructive address ends the run. Lenient percent-decoding, login-page queries checked, over-long targets refused. |
| A2 | Medium | The review message compared step intent text only, so a step that kept its intent but targeted another element showed as unchanged, and new pop-up handlers were not shown. | Changes come from the canonical steps. Every candidate a locator may match is listed, names JSON-quoted, and new handlers are flagged. Sign Steps refuses an item whose change list or flags do not match its steps. |
| A3 | Medium | With a Site Login, any credential-listed form could be posted at any moment of a run, not only by a declared `submit` step. | A run may post only the forms its steps declare, each only while its own step runs and at most 3 times. |
| C1 | Medium | Login Breaker Reset Key accepted expressions and was read per item, so `{{$json.id}}` reset the breaker on every item (5 items gave 5 login attempts). | The key is literal-only and read once per execution; a breaker tripped in an execution stays open for the rest of it. |
| C2 | Low to Medium | The masker missed form, path and double percent-encoding, partial HTML escaping (Chromium never escapes `'`), entity variants, `\x` escapes, full-width forms and unaligned base64. | All added; checks that refuse a secret decode first. |
| C3 | Low | The typed TOTP code was kept in traces. | The current and neighbouring codes are added to the run's masker before typing, matched as whole numbers even after an escaped non-digit. |
| H2 | Low | The approval email interpolated run values unescaped. | HTML-escaped like the review email. |
| B1 | Medium | The engine was a separate, unpublished package (dependency confusion if its name were taken on npm). | The engine is bundled inside `n8n-nodes-rpa`; the package's only runtime dependencies are `playwright-core`, `fflate` and `redis`, pinned, and releases are published from CI with npm provenance. |
| B2 | Medium (needs a renderer exploit) | The browser shared a network with Mailpit and n8n, so a compromised renderer could read approval links. | Compose networks are split: the browser and the sandbox are on `browser`, Mailpit only on `mail`, n8n on both. |
| Infra | Hardening | No capability limits, images pinned by tag, install scripts allowed, run-server stderr could expose its secret path, encryption key stored only in the volume, the run-server downloaded at start. | `cap_drop: ALL`, `no-new-privileges`, memory and process limits for the browser, images pinned by digest, `--ignore-scripts`, run-server output discarded, `N8N_ENCRYPTION_KEY` from `.env`, unverified installs off, the run-server installed at build time from a lockfile with integrity hashes. |
| Repo | Hygiene | No CI, secret scan, Dependabot, CODEOWNERS or SECURITY.md; demo passwords hard-coded. | CI (build, typecheck, tests, offline acceptance, `pnpm audit --prod`, gitleaks) with actions pinned by SHA, Dependabot, CODEOWNERS, SECURITY.md; sandbox passwords are synthetic defaults, overridable by environment. |
| Agent | Low | Provider token counts were trusted; a negative count kept the token budget from running out. | Counts are clamped to finite non-negative integers. |

## Residual risk

- **Redirect hops in AI repair.** Fixed since this review: every redirect hop, in every session, is now checked before the browser sends it (`browser/redirects.ts`). The check intercepts each hop in the browser through a browser-level DevTools session instead of fetching it with `route.fetch`, so the browser keeps its pinned addresses and the DNS-rebinding check still applies.
- **GET side effects behind ordinary addresses** are not detected, and the accepted risk for signed steps is unchanged.
- **Network layer.** The engine's checks run on what Playwright exposes. The browser can still reach `n8n:5678` on the compose network, and a page can make the browser look up a host name in DNS. For production, put the browser behind an egress firewall or proxy that blocks private addresses and pins each connection to a checked address.
- **CSP and Trusted Types.** Sites that forbid `blob:` workers can no longer start dedicated workers (fails closed).
- **Masking.** Values typed by `fill` are not masked (documented). Line-wrapped base64 and secrets shorter than about 5 bytes inside longer base64 are not matched.
- **Sign Steps** has no base steps, so a crafted item can omit a step change from its change list. Flags and handlers cannot be hidden.
- **Single process.** The breaker and the lock hold within one n8n process. (Since then, an RPA Redis credential shares them between workers in queue mode.)
