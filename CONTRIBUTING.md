# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are welcome; for a larger change, open an issue
first so we can agree on the approach.

## Build and test

You need Node.js 22.12 or later, pnpm 10.32.1 (`corepack enable` picks up the pinned version on Node 22 and 24; Node 25
and later ship without corepack, so use `npm install -g pnpm@10.32.1`), Docker with Compose for the stack, and a local
Chromium for the engine tests (`npx playwright@1.63.0 install chromium`).

```bash
pnpm install
pnpm -r build
pnpm test            # engine, node, eval, sandbox, gate, deploy script (one suite at a time)
pnpm -r typecheck
pnpm -r lint
pnpm acceptance      # offline; ANTHROPIC_API_KEY adds the live-model parts
make -C deploy check # the Helm chart and the Terraform modules (needs terraform, helm, kubeconform; tflint optional)
```

The Redis tests of the queue-mode breaker and lock run when `REDIS_URL` points at a test database (for example
`REDIS_URL=redis://localhost:6379/15`); without it they are skipped.

Run one test file with `pnpm --filter n8n-rpa-engine exec vitest run <file>` or
`pnpm --filter n8n-nodes-rpa exec vitest run test/<file>`.

| Suite | Command | Covers |
|---|---|---|
| Engine | `pnpm --filter n8n-rpa-engine test` | Step runner, locators, policy and address checks, masking, signing, traces, the agent loop (with a scripted fake model), compile, prove, imports. Runs against the sandbox and a real Chromium. |
| Node | `pnpm --filter n8n-nodes-rpa test` | Every operation through an n8n execution harness, the credentials, the templates' JSON, and the doc texts the docs quote (`test/readme.test.ts`). |
| Eval | `pnpm --filter n8n-rpa-eval test` | The eval's fixtures and leak detectors. `pnpm --filter n8n-rpa-eval start` runs the live heal-rate eval (needs `ANTHROPIC_API_KEY`). |
| Sandbox and gate | `pnpm --filter n8n-rpa-sandbox test`, `pnpm --filter n8n-rpa-gate test` | The sample site and the browser's token gate. |
| Deploy script | `node --test "deploy/scripts/test/*.test.mjs"` | `deploy/scripts/configure-n8n.mjs` against a fake n8n API. |
| Acceptance | `pnpm acceptance` | The acceptance criteria through the templates. `ACCEPTANCE_COMPOSE=1` adds the compose smoke test (start the stack with `docker-compose.dev.yml` first). |
| Desktop | see [`desktop/README.md`](desktop/README.md#building-and-testing) | The runner, the recorder and the installer (.NET and Pester). |

**Stacks.** `docker compose up --build -d` runs n8n with the node built from the source, the browser, the sandbox and
Mailpit ([browser bot guide](docs/guides/browser-bot.md)). `docker compose -p n8n-rpa-queue -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.queue.yml up -d --build`
runs n8n in queue mode with Postgres, Redis and two workers, on its own ports (n8n http://localhost:35678).
`SANDBOX_SAP=realistic` switches the sandbox's SAP pages to a realistic look-alike
([runbook](docs/onboarding/sap-lookalike.md)). `docker/n8n.Dockerfile` builds the n8n image with the node baked in.
Rebuild after changing the engine or the node: `docker compose up --build -d n8n`.

**Secrets in this repo.** `.env` is git-ignored: copy `.env.example`. n8n writes its encryption key into the `n8n_data`
volume, so treat that volume as secret. Every password, TOTP secret and key in the sandbox, the templates and the tests
is synthetic.

**Layout.** `packages/engine` (the engine, bundled into the node), `packages/n8n-nodes-rpa` (the node, its credentials
and templates), `packages/eval` (the heal-rate eval and acceptance tests), `sandbox/portal` (the sample site),
`images/browser` (the `rpa-browser` image: run-server, token gate, supervisor), `docker/` (the n8n image), `deploy/`
(Helm chart, Terraform, the configure script), `desktop/` (the Windows runner, recorder, policy tool and installer) and
`docs/` (guides, reference, install and deploy runbooks).

## Changes

- **Test first.** A fix comes with a test that fails without it. A change to the safety model (allowlist, writes,
  masking, signing, AI repair) needs a test for the boundary it moves.
- **Messages are part of the interface.** Every user-facing message lives in `packages/engine/src/messages.ts` or next to
  the node's operations, and tests assert them word for word. Update the tests with the text.
- **Stored identifiers do not change.** Credential type IDs (`playwright*Api`), the node type name (`playwright`), the
  Data Table names (`playwright_steps`, `playwright_runs`), the signing domain and the breaker key are stored in users'
  workflows and data; renaming them breaks existing installs.
- **User-facing wording** calls the product, the node and the credentials RPA (or browser for the browser itself).
  "Playwright" appears where it means Playwright itself: the browser server protocol, the version match, the install
  command for a local browser, the Playwright recorder and Playwright code for Import Steps.
- Keep commits focused, and describe what changed and why.
- Maintainers keep their private working notes outside the repository (the paths `.gitignore` lists under "Maintainers' private notes"); never commit them.

## Releases

Releases are published to npm from GitHub Actions with provenance (`.github/workflows/publish.yml`), never from a
laptop. The workflow tests in a job without publish rights, packs the tarball with
`packages/n8n-nodes-rpa/scripts/pack.mjs` (devDependencies and scripts stripped, the manifest checked) and cuts the
version's section out of `CHANGELOG.md`; a second job with no checkout publishes that tarball to npm; once it has, a
third job with no checkout attests the same tarball and creates the GitHub Release `v<version>` with the tarball, its
SHA-256 and that section as the notes. A maintainer bumps the version in `packages/n8n-nodes-rpa/package.json`, adds
the `## <version> (<date>)` entry to `CHANGELOG.md`, and pushes a `v<version>` tag. The `rpa-browser` image is published the same way by
`.github/workflows/browser-image.yml`, from a `browser-v<version>` tag on `main`; its Playwright version must equal the
node's `playwright-core`.

## The community package scan

The package is unverified on purpose: it drives a browser through `playwright-core`, which n8n's verification rules do
not allow. `pnpm -r lint` runs the plugin's `recommendedWithoutN8nCloudSupport` set with two rules off (runtime
dependencies, `usableAsTool`). n8n's scanner (`npx @n8n/scan-community-package n8n-nodes-rpa`) applies the full
`recommended` set, and these findings are expected there; anything else is a regression:

- `no-runtime-dependencies` (package.json): `playwright-core`, `fflate` and `redis`.
- `node-usable-as-tool` (Playwright.node.ts): left out on purpose; tool conversion would drop the model input and the
  extra outputs.
- `no-restricted-imports`: `redis` (redis-store.ts, the shared breaker and lock in queue mode) and `node:fs`
  (guard-store.ts, to read `EXECUTIONS_MODE_FILE`).
- `no-restricted-globals`: `process` (guard-store.ts, to detect queue mode) and `setTimeout`/`clearTimeout`
  (redis-store.ts, to bound every Redis command).

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
