# RPA desktop runner and ERP Demo

> **Status:** work in progress. The runner speaks the desktop protocol and drives Windows apps through UI Automation;
> the engine and the node do not use it yet.

| Path | What it is |
|---|---|
| `runner/src/Rpa.Runner.Core` | The platform-neutral part (net8.0): the WebSocket server (TLS, bearer token), JSON-RPC, the run lock and lease, the local policy floor, target resolution, snapshots and file retrieval. |
| `runner/src/Rpa.Runner.Windows` | The Windows driver (net8.0-windows): UI Automation through [FlaUI](https://github.com/FlaUI/FlaUI) (MIT), session health, the foreground check, window capture. |
| `runner/src/Rpa.Runner` | The executable, `RpaRunner.exe`. |
| `runner/src/Rpa.Runner.PolicyTool` | The policy tool, `RpaPolicy.exe`: shows a change to the policy file, asks, and applies it as an administrator. |
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
- `helperProcesses`: processes an allowed app starts to host its UI, such as the WebView2 runtime that draws a web view
  app's window content:
  `[{ "exe": "msedgewebview2.exe", "pathPattern": "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe" }]`.
  `pathPattern` is an absolute local path ending in `exe` with exactly one folder written as `*`, which matches any one
  folder name (WebView2's version folder changes on every update); no other wildcards. A process on such a path counts
  as the run's only while it descends from a process the run launched (in its job object, or by parent links that
  started in order); the same executable started by anything else is another application, and `app.launch` never
  starts a helper. Without this entry a web view app's elements never resolve and input that would land on them is
  refused. Point the pattern at an administrators-only folder. The runner does not check the helper's Authenticode
  signature (a Microsoft publisher check is a follow-up); the path pattern and the descent from an allowed app are the
  control.
- `clipboardRead` (default `false`): lets `clipboard.read` return the clipboard's text, for apps whose value is only
  available through a Copy button (a desktop authenticator app). The runner returns only text the run's own app copied
  right after one of the run's acts (see `clipboard.read` below), never what another application or a person put
  there; still, turn it on only for runners whose step sets need it.

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

## Changing the policy

`RpaPolicy.exe` changes the policy file for you. It prints what a change does in plain lines, asks, and writes the
file. It needs administrator rights, because only administrators may change the policy. There are two ways to start
it, and they look different:

- **From an administrator console** (a Command Prompt or PowerShell window opened with "Run as administrator"). The
  tool prints into that window and returns to its prompt. Use this way for `--yes` and `--policy`.
- **From anywhere else** (a normal console, a shortcut, another program). Windows shows its administrator prompt, and
  the tool then opens a console window of its own. In that window `--yes` is ignored (the tool prints
  `--yes is ignored: start RpaPolicy from an administrator console to use it` and asks anyway) and `--policy` is
  refused (`--policy needs an administrator console`), because whoever started the tool chose its arguments while the
  administrator prompt showed only the program's name. Before the window closes the tool prints
  `Press Enter to close.` and waits, so its output can be read.

```powershell
.\RpaPolicy.exe show
.\RpaPolicy.exe allow-app "C:\Program Files\ERP Demo\ErpDemo.exe" --pin-hash
# Changing the policy at C:\ProgramData\RPA Runner\policy.json (0 app(s), 0 helper process pattern(s) today).
# Allow app "ErpDemo.exe" at "C:\\Program Files\\ERP Demo\\ErpDemo.exe" (SHA-256 pinned 3A7F...)
# This change: 1 app(s) allowed or updated, 0 helper process pattern(s), 0 write control(s), 0 gated key(s).
# Apply these changes? [y/N] y
# Policy updated. The runner restarts within 10 seconds and uses the new policy.
.\RpaPolicy.exe apply change.json
```

- `show` prints the policy file, and says why when the runner would refuse it.
- `allow-app <path-to-exe>` adds the application to `allowedApps` with its file name and full path. `--pin-hash` also
  pins the file's SHA-256, so the runner starts only a file with that hash (run the command again after the app is
  updated). An app the policy already has keeps its allowed argument lists, and its pin unless `--pin-hash` gives a
  new one.
- `apply <change.json>` adds what a change file lists. A change file is a JSON object with any of `allowedApps`,
  `writeControls`, `gatedKeys`, `helperProcesses` and `clipboardRead`, written as in the policy file. It must be on a
  local drive (`the change file must be on a local drive` otherwise).
- Every command takes `--policy <path>` (default `%ProgramData%\RPA Runner\policy.json`). `apply` and `allow-app` take
  `--yes`, which writes without asking. Both options work only from an administrator console.

### What a change may do

A change only adds. Entries the policy already has are skipped, `clipboardRead` may only be `true`, and `maxFileBytes`
or an unknown key is refused: to remove an entry or change the file size limit, edit the policy file by hand. A change
whose result the runner would refuse is refused, and nothing is written.

An `allowedApps` entry with the same `exe` and `path` as an existing one (in any letter case) is merged into the
existing entry and does not take its place:

- `sha256` sets the pin or changes it. An entry without `sha256` keeps the existing pin; a change does not remove one.
- `allowedArgs` lists are added to the existing lists (a list is the same when its strings are equal, in order); a
  change does not remove one.
- `allowUserWritable: true` turns it on. Left out, it stays as it is. `false` for an entry where it is on is refused
  (`a policy change cannot turn allowUserWritable off for <path>`).

A change file may be written by a user who is not an administrator (a recorder, for example), and the lines the tool
prints are all the administrator sees before saying yes. So the tool limits a change and the length of what it prints
for it:

| Refused | Message |
|---|---|
| A change file larger than 256 KiB (checked before it is read) | `the change file is larger than 256 KiB` |
| More than 40 entries in `allowedApps`, `writeControls`, `gatedKeys` and `helperProcesses` together, each allowed argument list counting as one | `a change may hold at most 40 entries; this one holds <n>` |
| An argument list with more than 20 arguments | `an allowed argument list may hold at most 20 arguments` |
| A name, path, id or argument longer than 260 characters | `a value in the change is longer than 260 characters` |
| A short (8.3) name such as `C:\PROGRA~1\...` in an app `path` or a helper `pathPattern` (any `~` followed by a digit): it would name an existing entry's file without being that entry | `write the full path, not a short (8.3) name: <the path>` |
| An entry that is not an object, or an argument that is not text | `an entry in <key> must be an object`, `an allowed argument must be text` |
| A summary longer than 8,000 characters: every line the tool prints for the change before it asks, from the first line to the count line, line breaks counted. A value shown as `\uXXXX` escapes is six times as long as it is in the file. | `the summary of this change would be longer than 8000 characters; split it into smaller changes` |

### What the tool prints

The first line names the policy file: `Creating a new policy at <path>.` or
`Changing the policy at <path> (<n> app(s), <m> helper process pattern(s) today).` Then one line for each thing the
change does. Lines that only tighten the policy come first, lines that widen what may run come after them, and a count
line is last, directly above the prompt:

| Line | Meaning |
|---|---|
| `Add write control "<exe>" / "<automationId>"` | A new `writeControls` entry. |
| `Add gated key "<chord>"` | A new `gatedKeys` entry. |
| `Allow app "<exe>" at "<path>"` | A new `allowedApps` entry. ` (SHA-256 pinned <64 hex digits>)` follows when it sets `sha256`. |
| `Update app "<exe>" at "<path>" (<what changes>)` | The existing entry for this exe and path changes. In the parentheses, joined by `; `: `SHA-256 pinned <hash>` (it had no pin), `SHA-256 pin changed from <hash> to <hash>`, `allowed arguments added`, `user-writable path allowed`. |
| `  with arguments: "<arg>" "<arg>" ...` | Under an `Allow app` or `Update app` line, one line for each `allowedArgs` list it adds; `  with arguments: (none)` for an empty list. |
| `Add helper process "<exe>" at "<pathPattern>"` | A new `helperProcesses` entry. |
| `Turn on clipboard read` | `clipboardRead` becomes `true`. |
| `This change: <a> app(s) allowed or updated, <h> helper process pattern(s), <w> write control(s), <k> gated key(s).` | The count of the lines above (`, clipboard read turned on` before the full stop when it is). Compare it with what you read: if lines scrolled out of view, the counts still show them. |

Warnings come directly under the line they belong to (under an app line, before its `with arguments` lines):

| Warning | When |
|---|---|
| `WARNING: this line holds characters outside plain ASCII, shown as \u escapes` | A value in the line has a character other than a printable ASCII one. |
| `WARNING: "<path>" can be changed by the runner's own user` | The app is, or becomes, `allowUserWritable`. It is printed on every line for such an app. |
| `WARNING: any program at this path counts as part of the app that started it` | Under every `Add helper process` line. |

Every value from the change is printed as a JSON string literal: in double quotes, with `"` and `\` escaped (so a
Windows path shows doubled backslashes) and every character outside printable ASCII written as `\uXXXX`. A no-break
space in `C:\Program Files`, an invisible character or a file named `x.exe (SHA-256 pinned)` shows for what it is, and
the quotes show where each value starts and ends. Everything else the tool prints (messages, the `show` output, paths)
has control and format characters written as `\uXXXX` too.

These measures make a misleading change harder to write; they do not replace reading the lines. Read each of them and
the count line, and answer `n` when anything is unclear. Limits that remain: a summary may be up to 8,000 characters
long (100 rows of a window 80 columns wide), which is more than a small window shows at once, so scroll up to the first
line (`Creating a new policy ...` or `Changing the policy ...`) before you answer; and the tool cannot tell whether a
path that looks right is the program you mean.

### What the tool writes, and what it trusts

- **The existing policy file.** Before the tool reads an existing policy file (for `show`, `apply` and `allow-app`) it
  runs the runner's own start check on it. When someone other than an administrator owns the file or could change or
  replace it, the tool stops: `the existing policy file cannot be trusted: <problem>; an administrator must check and
  replace it`. Such a file may have been put there by a user who is not an administrator.
- **Writing.** The tool writes the new policy to a temporary file beside the policy
  (`policy.json.<32 hex digits>.tmp`, created for Administrators and SYSTEM only) and swaps it in in one step. If the
  swap fails the tool says so (`Writing the policy failed: ...`), exits 1, and the runner keeps running with the
  policy it has.
- **Backups.** The old policy goes to `policy-backups\` beside the policy, as `policy.json.<yyyyMMdd-HHmmss>.bak`.
  When that name is taken (by a file or a folder), the tool takes `-2.bak`, then `-3.bak`, and so on. The tool creates
  the folder for Administrators and SYSTEM only. A folder that is already there is used only when it is a real folder
  (not a link) that passes the test the runner's start check uses for the policy's folder; otherwise:
  `the backup folder cannot be trusted: <problem>`.
- **After writing.** The tool runs the runner's start check on the new policy file. When it finds a problem the tool
  says so, exits 1 and leaves the runner running: fix the permissions before the runner's next start.
- **The runner.** The tool then ends the running `RpaRunner.exe`, which reads the policy only at start. The runner's
  start script starts it again within 10 seconds; start a runner you started by hand again yourself. When the runner
  cannot be ended the tool prints `Policy updated, but the runner could not be restarted: ... Restart it by hand.`
- **Layout.** The tool writes the whole file in one layout (two-space indent, the key order of the example), so
  comments in a hand-edited policy are not kept; the backup still has them.

`Nothing to change.` means the policy already has everything; the file is not written and the runner is not restarted.

Exit codes: 0 applied or nothing to change, 1 refused or failed, 2 wrong arguments (the usage is printed), 3 declined
at the prompt.

## ERP Demo

Sign in as `clerk` / `demo1234`, pick a company code (1000, 2000, 3000), search, select a row, Post it, or export the
results as CSV (a Save dialog). **Copy** (automation id `btnCopyDetail`) puts the selected row's detail on the
clipboard. The data is fixed, so tests can assert exact rows. v2 is the same app after an
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
`app.launch`, `snapshot`, `isVisible`, `resolve`, `act`, `windows`, `file.retrieve`, `screenshot`, `clipboard.read`. One run at a time; a lease that
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

`clipboard.read { runId }` returns `{ text }`, the clipboard's Unicode text (`""` when it holds none). It returns only
the run's own copy, so text another application or a person copied (a password) never leaves the machine. It is
`policy_refused`:

- unless the policy sets `clipboardRead`;
- while the foreground window is not one of the run's (the runner never brings its window back for a read: the text
  could then be another application's);
- before the run's first `act`, and more than 10 seconds after the run's most recent `act` finished;
- unless a process of the run owns the clipboard: the process of the clipboard's owner window (`GetClipboardOwner`,
  read while the runner holds the clipboard open) is a process the run launched (or a descendant of one) running one
  of the policy's pinned apps, or a helper process of the policy that descends from one (a WebView2 app copies from
  its `msedgewebview2.exe`). No owner window (text put there without one, or by an application that has exited) is
  refused too;
- unless the clipboard changed since the run's most recent `act`: the runner records the clipboard's sequence number
  (`GetClipboardSequenceNumber`) before every `act`, refused ones included, and the number read with the text must
  differ. So the read must follow the act that copied (a click on the app's Copy button) with no other act in
  between.

The owner and the sequence number are checked while the clipboard is open, before any text is copied out of it. Text
longer than 1000 characters is refused, not cut. A clipboard another application holds open is retried for 2
seconds, then `timeout`. The runner reads it on a short-lived STA thread in its own session and never logs the text or puts it in an error (the
log records `clipboard.read chars=<n>`). A runner older than the method answers -32601. The protocol stays version 1:
the method and the policy fields are additions.
