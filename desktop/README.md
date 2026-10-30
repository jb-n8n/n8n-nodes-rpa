# RPA desktop runner and ERP Demo

> **Status:** work in progress. The runner speaks the desktop protocol and drives Windows apps through UI Automation;
> the engine and the node do not use it yet.

| Path | What it is |
|---|---|
| `runner/src/Rpa.Runner.Core` | The platform-neutral part (net8.0): the WebSocket server (TLS, bearer token), JSON-RPC, the run lock and lease, the local policy floor, target resolution, snapshots and file retrieval. |
| `runner/src/Rpa.Runner.Windows` | The Windows driver (net8.0-windows): UI Automation through [FlaUI](https://github.com/FlaUI/FlaUI) (MIT), session health, the foreground check, window capture. |
| `runner/src/Rpa.Runner` | The executable, `RpaRunner.exe`. |
| `runner/test/Rpa.Runner.Core.Tests` | Unit tests of the core with a fake desktop (run anywhere). |
| `runner/test/Rpa.Runner.Scenario` | The protocol test client CI runs against the real runner and the ERP Demo on Windows. |
| `erp-demo` | ERP Demo: a small "legacy ERP" WinForms app with a v1 and a v2 UI. |

## Running the runner

The runner is a user-mode program in the signed-in user's interactive session (it drives that user's desktop; a
Windows service cannot). It listens on `wss://0.0.0.0:8765/rpa/v1` and refuses plain `ws://`.

```powershell
$env:RPA_RUNNER_TOKEN_FILE = 'C:\ProgramData\RPA Runner\token'   # a file holding the token (or RPA_RUNNER_TOKEN)
$env:RPA_RUNNER_POLICY_FILE = 'C:\ProgramData\RPA Runner\policy.json'
.\RpaRunner.exe                       # also --port/RPA_RUNNER_PORT, --bind, --data-dir, --policy: see --help
# RPA runner listening on wss://0.0.0.0:8765/rpa/v1, fingerprint 3A:...:7F
```

The token is never accepted on the command line, and launched apps never inherit any `RPA_RUNNER_*` variable. The
start line also goes to `<data dir>\logs\runner-<date>.log`.

On first start the runner generates a self-signed certificate in the data directory (default
`%ProgramData%\RPA Runner\`, private key protected with DPAPI for the runner's Windows user) and prints its SHA-256
fingerprint; the n8n credential pins it. Logs go to `<data dir>\logs`. They record methods, outcomes and error codes,
never tokens, typed values or file contents.

The runner refuses to start without a policy file (default `<data dir>\policy.json`), and refuses when anyone but
administrators could change or replace it (its owner, its access rules, or its folder's). Prepare the data directory
as an administrator: the runner leaves an existing directory's permissions alone and creates only new files and the
`logs\` and `exports\` folders in it (those get an ACL for the runner's user, SYSTEM and Administrators). See [`runner/policy.example.json`](runner/policy.example.json):

- `allowedApps`: the only executables `app.launch` starts. `exe` is the file name a step set names; `path` (required)
  pins the absolute local path that runs (UNC and device paths are refused). Optional: `sha256` pins the file's hash;
  `allowedArgs` lists the exact argument lists a launch may pass (without it, none); `allowUserWritable: true` permits
  a path the runner's own user could modify or replace, which is refused otherwise. Install apps in a protected folder
  (such as `C:\Program Files`) and run the runner as a normal, non-elevated user.
- `writeControls`: controls (by process and automation id) that act only with `write: true`, including through a child
  element, the mouse landing on them, or the keyboard focus being on them. While any window of the run holds a write
  control, every key without `write: true` must be plain navigation (Tab, Shift+Tab, arrows, Home, End, PageUp,
  PageDown, Escape), and only Tab and Escape while a menu is open: Enter, Space, Alt, F10, Shift+F10 or a mnemonic
  could reach the write control without targeting it.
- `gatedKeys`: key chords that need `write: true` (in any spelling: `ctrl+s` is `Ctrl+S`). List the app's save and
  post shortcuts here.
- `maxFileBytes`: the largest file `file.retrieve` returns (default 20 MiB, at most 36 MiB so the answer fits a 50 MiB
  message).

Each launched app runs in its own Windows job object: the run's windows are those of processes in it, and the run's end
(or its expired lease, or the runner exiting) ends the whole process tree. The data, log and export directories get an
explicit ACL: the runner's user, SYSTEM and Administrators only.

A run acts only on windows of processes it launched whose executable is allowed. If another application's window holds
the foreground and the runner cannot bring the run's window back, the action is refused; OS surfaces (notifications, the
taskbar, the Start menu) are ignored. `mode: "repair"` allows only `focus`, `expand`, `read`, `key` with the value
`Escape` and no target (it goes to the run's focused element, to close a menu or a dialog; an `Escape` listed in
`gatedKeys` stays refused), and `click` on tabs, list items and tree items. Because Escape fires a form's cancel button
whatever has the focus, a repair-mode Escape is refused while its window holds a write control, unless a popup menu of
that window is open (a top-level menu window it owns; a menu bar does not count). When an app's Escape itself writes (a
cancel button that discards or posts), list `Escape` in `gatedKeys`.

Key chords that reach the Windows shell rather than the app (anything with Win, Ctrl+Esc, Ctrl+Shift+Esc,
Alt+Tab, Alt+Esc) are never sent. `type` goes only into editable text fields, as Unicode keystrokes (no shortcuts or
mnemonics), and stops if the keyboard focus moves.

**This is weaker than the browser's guarantee.** The browser policy is enforced on the network: every request and
redirect is checked against an allow-list. A desktop app talks to its own back end, which the runner cannot filter.
The runner limits which apps and windows a run touches, which controls and keys count as writes, and where files come
from; what an allowed app does with an allowed click is up to the app. On a person's own desktop the runner acts with
that person's access. Two limits to keep in mind:

- `write: true` and `mode: "repair"` are chosen by the caller. They keep honest mistakes and AI repair away from
  writes; against a compromised n8n, what still holds is the allowed apps and windows, the shell-chord block, export
  confinement and password redaction.
- An allowed app's own file dialogs carry shell powers: through them a caller can copy files the runner's user can
  read into the export directory, or start programs from a context menu (those programs are not the run's, so the
  runner will not act on them). `file.retrieve` itself never returns files from elsewhere. A dedicated Windows user
  with AppLocker is the real control.

## ERP Demo

Sign in as `clerk` / `demo1234`, pick a company code (1000, 2000, 3000), search, select a row, Post it, or export the
results as CSV (a Save dialog). The data is fixed, so tests can assert exact rows. v2 is the same app after an
"upgrade": Search is now **Find** (automation id `btnFind`), Export moved from **File** to a new **Reports** menu
(**Export line items...**), and a confirmation dialog comes before the Save dialog. Choose the default at build time
(`-p:ErpDemoUi=v2`) or at run time (`ErpDemo.exe --ui v2`).

## Building and testing

```sh
dotnet build desktop/Rpa.Desktop.sln              # the Windows projects compile on Linux and macOS too
dotnet test desktop/runner/test/Rpa.Runner.Core.Tests
```

No .NET SDK? `docker run --rm -v "$PWD/desktop:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 dotnet test runner/test/Rpa.Runner.Core.Tests`.
The UI parts run only on Windows: the `desktop` workflow builds and publishes everything on `windows-latest`, starts
the runner and drives the ERP Demo through it with the scenario client. Its artifacts `rpa-desktop-runner` and
`erp-demo` are self-contained win-x64 builds (no .NET install needed).

## Protocol

JSON-RPC 2.0 over WebSocket, one request per message, `Authorization: Bearer <token>` on the upgrade (HTTP 401
otherwise). Methods: `hello`, `run.begin` (`{ runId, leaseMs }`, 5000 to 600000), `run.heartbeat`, `run.end`,
`app.launch`, `snapshot`, `isVisible`, `resolve`, `act`, `windows`, `file.retrieve`, `screenshot`. One run at a time; a lease that
expires ends the run as `run.end` does (its apps closed, its export directory deleted). Requests on one connection
are handled concurrently, so a `run.heartbeat` is answered while an `act` or `file.retrieve` is still running. The lease is also renewed when
any request for the run finishes, and never expires while one is in progress.

Error codes: -32001 `runner_busy`, -32002 `desktop_unavailable`, -32003 `policy_refused`, -32004 `not_found`,
-32005 `not_unique`, -32006 `expected_file_missing`, -32007 `timeout`, -32008 `no_run`; `error.data.name` carries the
name. Messages never contain typed values.

Beyond the minimum: `act` with `action: "key"` may omit `target` (the key goes to the run's focused element, under the
same write checks); `snapshot` adds `truncated: true` when it stopped at `maxNodes` or `maxDepth`; `windows { runId }`
returns `{ windows: [{ title, exe, automationId, className, foreground }] }`, the run's top-level windows (its own and
owned windows, such as dialogs and open menu drop-downs, never another application's), the foreground window first
(`foreground: true`, only when it is the run's), then front to back, at most 20.
