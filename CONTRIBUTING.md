# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are welcome; for a larger change, open an issue
first so we can agree on the approach.

## Build and test

You need Node.js 22.12 or later, pnpm 10.32.1 (`corepack enable` picks up the pinned version), Docker with Compose for
the stack, and a local Chromium for the engine tests (`npx playwright@1.63.0 install chromium`).

```bash
pnpm install
pnpm -r build
pnpm test            # engine, node, eval, sandbox, gate, deploy script
pnpm -r typecheck
pnpm -r lint
pnpm acceptance      # offline; ANTHROPIC_API_KEY adds the live-model parts
make -C deploy check # the Helm chart and the Terraform modules (needs terraform, helm, kubeconform; tflint optional)
```

The Redis tests of the queue-mode breaker and lock run when `REDIS_URL` points at a test database (for example
`REDIS_URL=redis://localhost:6379/15`); without it they are skipped.

The README's [Development](README.md#development) section lists what each suite covers and how to run one test file.

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
`packages/n8n-nodes-rpa/scripts/pack.mjs` (devDependencies and scripts stripped, the manifest checked), and a second
job with no checkout publishes that tarball. A maintainer bumps the version in `packages/n8n-nodes-rpa/package.json`, adds the entry to `CHANGELOG.md`,
and pushes a `v<version>` tag. The `rpa-browser` image is published the same way by
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
