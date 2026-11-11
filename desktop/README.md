# RPA desktop runner and ERP Demo

The runner speaks the desktop protocol and drives Windows apps through UI Automation; Run Steps sends it desktop
steps (README, [Desktop runs](../README.md#desktop-runs)). To install the runner, the policy tool and the RPA browser
on a Windows machine, follow the [Windows install guide](../docs/install/windows.md), which uses the package this
folder builds (`installer/`, released as `rpa-windows-x64.zip`). The RPA browser the package installs serves one
browser session at a time: a second browser run that starts while one is open waits up to 60 s for it, then fails
`browser_unavailable` with `The browser service at wss://<host>:3000/ had no free browser session for 60 s. ...`.

| Path | What it is |
|---|---|
| `runner/src/Rpa.Runner.Core` | The platform-neutral part (net8.0): the WebSocket server (TLS, bearer token), JSON-RPC, the run lock and lease, the local policy floor, target resolution, snapshots and file retrieval. |
| `runner/src/Rpa.Runner.Windows` | The Windows driver (net8.0-windows): UI Automation through [FlaUI](https://github.com/FlaUI/FlaUI) (MIT), session health, the foreground check, window capture. |
| `runner/src/Rpa.Runner` | The executable, `RpaRunner.exe`. |
| `runner/src/Rpa.Runner.PolicyTool` | The policy tool, `RpaPolicy.exe`: shows a change to the policy file, asks, and applies it as an administrator. |
| `runner/src/Rpa.Supervisor.Core` | The platform-neutral part of the RPA Supervisor (net8.0): when to sign the bot user in and out, the port proxy, reading `install.json`, the supervisor's log. |
| `runner/src/Rpa.Supervisor` | The RPA Supervisor, `RpaSupervisor.exe`: the Windows service for unattended mode and its Remote Desktop host (see "Unattended mode"). |
| `runner/test/Rpa.Runner.Core.Tests` | Unit tests of the core with a fake desktop (run anywhere). |
| `runner/test/Rpa.Supervisor.Core.Tests` | Unit tests of the supervisor's core with fake sessions (run anywhere). |
| `runner/test/Rpa.Runner.Scenario` | The protocol test client CI runs against the real runner and the ERP Demo on Windows. |
| `recorder/src/Rpa.Recorder.Core` | The platform-neutral part of the recorder (net8.0): the session that turns input into steps, the locator and secret rules, the recording file and the policy change file. |
| `recorder/src/Rpa.Recorder` | The recorder, `RpaRecorder.exe` (net8.0-windows): a bar that stays on top, and the hooks and UI Automation that watch the app. It saves a recording file for Import Steps; see [Recording a flow](../docs/install/windows.md#12-recording-a-flow). |
| `recorder/test/Rpa.Recorder.Core.Tests` | Unit tests of the recorder's core with fakes (run anywhere). |
| `recorder/test/Rpa.Recorder.Scenario` | The recorder scenario CI runs on Windows: a stand-in for a person drives the ERP Demo while `RpaRecorder.exe` records it, and the file is compared with a golden one. |
| `erp-demo` | ERP Demo: a small "legacy ERP" WinForms app with a v1 and a v2 UI. |
| `installer` | The Windows package: `Install-Rpa.ps1`, `Uninstall-Rpa.ps1` and their module (the package also holds the recorder, in `recorder\`), the start scripts and `Show-RpaConnection.ps1` (`scripts/`), the script that stages the zip (`build/Stage.ps1`) and the Pester tests. |

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
`logs\` and `exports\` folders in it (those get an ACL for the runner's user, SYSTEM and Administrators). See
[`runner/policy.example.json`](runner/policy.example.json), which the package also holds as
`runner\policy.example.json`. It is an example of a whole policy file, not a change file for `RpaPolicy.exe apply`
(a change may not hold `maxFileBytes`, so the tool refuses it), and its app path is not where the package installs
the ERP Demo. The keys:

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
taskbar, the Start menu) are ignored. `mode: "repair"` (no operation sends it yet: the node refuses AI repair for
desktop steps) allows only `focus`, `expand`, `read`, `key` with the value
`Escape` and no target (it goes to the run's focused element, to close a menu or a dialog; an `Escape` listed in
`gatedKeys` stays refused), and `click` on tabs, list items and tree items. Because Escape fires a form's cancel button
whatever has the focus, a repair-mode Escape is refused while its window holds a write control, unless a popup menu of
that window is open (a top-level menu window it owns; a menu bar does not count). When an app's Escape itself writes (a
cancel button that discards or posts), list `Escape` in `gatedKeys`.

Key chords that reach the Windows shell rather than the app (anything with Win, Ctrl+Esc, Ctrl+Shift+Esc,
Alt+Tab, Alt+Esc) are never sent. `type` goes only into editable text fields, as Unicode keystrokes (no shortcuts or
mnemonics), and stops if the keyboard focus moves.

**This is weaker than the browser's network policy.** The browser policy is enforced on the network: every request
and redirect is checked against an allow-list. A desktop app talks to its own back end, which the runner cannot
filter. The runner limits which apps and windows a run touches, which controls and keys count as writes, and where
files come from; what an allowed app does with an allowed click is up to the app. On a person's own desktop the runner
acts with that person's access. Three limits to keep in mind:

- `write: true` and `mode: "repair"` are chosen by the caller. They keep honest mistakes and AI repair away from
  writes. Against a caller that holds the runner token and nothing else (a compromised n8n without the browser
  token), the runner still applies the allowed apps and windows, the shell-chord block, export confinement and
  password redaction.
- An allowed app's own file dialogs carry shell powers: through them a caller can copy files the runner's user can
  read into the export directory, or start programs from a context menu (those programs are not the run's, so the
  runner will not act on them). `file.retrieve` itself reads only from the run's export directory. A dedicated
  Windows user with AppLocker narrows what that user can start.
- The RPA browser runs as the same Windows user as the runner when it is installed beside it, which the installer
  does unless it is given `-NoBrowser`. With the browser installed, whoever holds the browser token and can reach the
  browser's port acts as the bot user through the browser: it can read the files the bot user can read (the runner's
  token among them), and it can create files with a name and content of its choice where the bot user can write,
  which is a way to run programs as the bot user. The runner's policy does not limit that, so the policy is a limit
  for the runner token only; on a machine where the policy must hold against n8n itself, install with `-NoBrowser`
  and run the browser on another machine. On Windows Server 2022 a plain Playwright client with the browser token
  read a file of the bot user through a `file://` page, and, after a CDP session set the download folder of its
  browser context (`Browser.setDownloadBehavior`), saved a download with the name and content it chose into a folder
  of the bot user's profile; the file belonged to the bot user. A file only administrators could read was refused.

## Unattended mode

The runner needs a signed-in, unlocked desktop. In unattended mode nobody has to be signed in: the RPA Supervisor, a
Windows service (`RPA Supervisor`, `RpaSupervisor.exe`, running as SYSTEM), listens on the runner's port (and the
browser's) in place of the runner. When n8n connects, it signs the bot user in over a Remote Desktop connection from the
machine to itself (to `127.0.0.2`, through the RDP client control that ships with Windows), waits until the session is
Active and the runner listens inside it, and then passes the connection's bytes through unchanged: TLS, the token and
the protocol stay between n8n and the runner. When no connection has held the session for `idleSeconds`, it signs the
bot user out again. One bot user, one session at a time.

`Install-Rpa.ps1 -Unattended [-IdleSeconds 15]` sets this up on Windows Server 2019 or later (it refuses Windows 10
and 11, where it was not tested, and `-AutoSignIn` with it): it puts the bot user into Remote Desktop Users, turns
Remote Desktop on with the registry value alone when it is off (no firewall rule for Remote Desktop), stores the bot
user's password in the LSA secret, registers the service (LocalSystem, automatic start, started again a minute after a
failure) and points the two firewall rules at `RpaSupervisor.exe`. The start scripts read `mode` from `install.json`
and let the runner and the browser host listen on `127.0.0.1` at the inner ports (`RPA_RUNNER_BIND`,
`RPA_BROWSER_BIND`). After the service starts, the installer makes one connection to the runner's port and waits up to
120 s, so that the bot user's profile exists before n8n's first run. An upgrade keeps unattended mode and its idle
time; `Uninstall-Rpa.ps1`, and an install with `-Unattended:$false`, put back what it changed. The install guide,
[`docs/install/windows.md`](../docs/install/windows.md), section 4, "Running with nobody signed in", is the user's
side of this.

The service reads `install.json` in the install directory (`%ProgramFiles%\RPA Runner`), which the installer writes:

| Field | Meaning |
|---|---|
| `mode` | `"unattended"` makes the service run; with anything else it writes one line to its log and does nothing. |
| `user` | The bot user: a local Windows user, as `name`, `.\name` or `<this machine>\name`. |
| `runnerPort`, `runnerInnerPort` | The service listens on `runnerPort` and passes each connection to `127.0.0.1:runnerInnerPort`, where the runner listens in the bot user's session. |
| `browserPort`, `browserInnerPort` | The same for the RPA browser; without `browserPort` only the runner is passed on. |
| `idleSeconds` | How long the session stays signed in without a connection (default 15, 0 to 86400). |
| `listenAddresses` | The addresses the service listens on (default `["0.0.0.0"]`; the installer writes `["0.0.0.0"]`, where the runner and the browser host listen in the signed-in mode). |

A field that is missing or wrong stops the service at start, and so does a port it cannot listen on; the reason is in
its log, in one line. The bot user's password is read from the local security authority (the LSA secret
`L$RpaRunnerBotPassword`, which standard users cannot read) for each sign-in. It reaches the Remote Desktop host process
on its standard input, never on a command line, and is not written to the log or any file. The Remote Desktop connection
does not check the server's identity: the server is the machine itself, over the loopback. Before each sign-in the
service checks that the machine's Remote Desktop service (TermService) is running and that every listener on port 3389
is that service: while the service is stopped any user may listen on the port, and such a listener stays after the
service starts again. Until both hold, no sign-in is tried and the connection waits. It does not check who answers on
the port after that check.

The machine needs Remote Desktop turned on with Network Level Authentication, and the bot user in the Remote Desktop
Users group. The service refuses a connection rather than act on a session it did not create: when someone is signed in
as the bot user (at the console or over Remote Desktop), connections are closed until that session is signed out. When
Windows refuses the password, or the account (unknown, disabled, locked, restricted or expired), or the password has
expired or must change, the service tries no further sign-in until it is restarted, because retrying could lock the
account out. Another refusal by the Remote Desktop client fails that connection only.

The service's log and state are in `%ProgramData%\RPA Runner\supervisor\`, a folder the installer creates for SYSTEM and
administrators only (the service does not create it); when it is missing, is a link, or is owned by anyone but SYSTEM or
Administrators, the service does not start, and says so in the Windows event log. The log is `supervisor.log` there (the
previous one in `supervisor.1.log`). It records sign-ins, sign-outs and failures with their reasons, never a password, a
token or bytes of a connection, and writes the same failure at most once in 30 s. `supervisor-state.json` names the
session the service created and its last failure, so that after a restart it signs its own stale session out and leaves
anyone else's alone. A connection waits up to 90 s for the session and the runner together; the first sign-in after a
restart, or of a new user, can take most of that.

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
  administrator prompt showed only the program's name. Before it asks, the tool also looks at the size of that
  window's buffer (see "What the tool prints"). Before the window closes the tool prints `Press Enter to close.` and
  waits, so its output can be read.

The test behind this: the tool honours `--yes` and `--policy` only when it shares its console with at least one other
program and every program attached to that console is elevated. It asks Windows about each one, and a program it
cannot ask about counts as not elevated. Alone in its console, without a console, or beside a program that is not
elevated (in a console that an elevation helper shares with a normal shell, for example), it ignores `--yes` and
refuses `--policy`.

The wait for Enter has its own test: the tool waits when no other program is attached to its console, the console
has a window, the tool runs on the window station of a signed-in desktop, and its input is that console. The test
does not ask whether the window can be seen, so a tool alone in a console with a hidden window on a signed-in desktop
waits as well. Without a console, on a window station nobody is signed in to (a service, or a scheduled task set to
run whether a user is signed in or not), or with input that comes from a file or a pipe, it does not wait.

```powershell
.\RpaPolicy.exe show
.\RpaPolicy.exe allow-app "C:\Program Files\ERP Demo\ErpDemo.exe" --pin-hash
# Changing the policy at C:\ProgramData\RPA Runner\policy.json (0 app(s), 0 helper process pattern(s) today).
# Allow app "ErpDemo.exe" at "C:\\Program Files\\ERP Demo\\ErpDemo.exe"
#         (SHA-256 pinned
#         3A7F5C1E9B2D4F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8)
# This change: 1 app(s) allowed or updated, 0 helper process pattern(s), 0 write control(s), 0 gated key(s).
# Apply these changes? [y/N] y
# Policy updated. The runner restarts within 10 seconds and uses the new policy.
.\RpaPolicy.exe apply change.json
```

- `show` prints the policy file, and says why when the runner would refuse it.
- `allow-app <path-to-exe>` adds the application to `allowedApps` with its file name and full path. `--pin-hash` also
  pins the file's SHA-256, so the runner starts only a file with that hash (run the command again after the app is
  updated). An app the policy already has keeps its allowed argument lists, and its pin unless `--pin-hash` gives a
  new one. Give the application by its real location on a local drive (the tests are described below). A UNC or device
  path (`\\server\share\...`, `\\.\...`) and a short (8.3) name are refused before the tool opens anything, with
  the messages a change file gets for such a path. `--pin-hash` reads the file as a stream
  (`Application file not found: <path>` when there is none).
- `apply <change.json>` adds what a change file lists. A change file is a JSON object with any of `allowedApps`,
  `writeControls`, `gatedKeys`, `helperProcesses` and `clipboardRead`, written as in the policy file. It must be on a
  local drive (`the change file must be on a local drive` for a UNC or device path).
- The change file and the application are paths chosen by whoever started the tool, and the tool works with
  administrator rights. Before it opens such a path or writes it into the policy (`allow-app` with and without
  `--pin-hash`), it tests the path itself:
  - Its drive must be a letter that is a volume of its own with the drive type "fixed". A mapped network drive, a
    removable drive and a letter that `subst` made for a folder are refused.
  - No name in the path may be a link (a junction, a symbolic link, a mount point). The tool asks about each name
    from the drive downward without following it and stops at the first link, so it does not go where the link
    leads (a network share, for example).

  A path that fails either test is refused: `<path> is not a regular file on a local drive`. So give an application
  by its real location, not through a link or a substituted drive letter: a policy entry under such a path would
  name whatever the link points to later.

  Then the tool opens the file once (`apply` always, `allow-app` only for `--pin-hash`). It does not follow a link in
  the last name of the path, and it asks Windows to let a named pipe's server on this machine identify the tool's
  user without acting as that user. It reads the file only when what it opened is a regular file whose final path
  is on a local fixed drive; a folder, a link, a pipe or another device, and a file on a network share or a
  removable drive get the same refusal. This second test also covers a path that someone changed between the first
  test and the open; the open has then gone where the path led, and the tool reads nothing from it.
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
| A summary longer than 8,000 characters: everything the tool prints for the change before it asks, from the first line to the count line, as printed (line breaks and the eight spaces of continued rows counted). A value shown as `\uXXXX` escapes is six times as long as it is in the file. | `the summary of this change would be longer than 8000 characters; split it into smaller changes` |
| A key the policy file does not have, at the top or inside an entry | `the change: unknown key "<key>"`, `the change: unknown key "<key>" in <list>` |

A refusal that repeats a name or a value from a file (a key, a path, a key chord, an exe name) prints it like a value
in the summary: in double quotes with `\uXXXX` escapes, and only its first 60 characters, followed by `...` when it
is longer. The same checks and the same form apply to the policy file itself (`show`, and the policy a change is merged
into), with the file's path or `the current policy` in place of `the change`.

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

The tool breaks a long line itself, into rows of at most 76 characters, and starts every row after the first with
eight spaces. Its own words are broken only after a space, so the words a line starts with (up to the opening quote
of its first value), every other word of the tool's and a 64-digit hash each stay on one row. Inside a value a break
falls between characters as printed, with a `\uXXXX`, `\"` or `\\` kept whole, and not next to one of the value's
spaces where that can be avoided inside the value: put the rows together without the eight spaces and you have the
line.

Where this holds: for the summary lines, and for every refusal and failure message. There, in a window at least 77
columns wide, every row after a line's first starts with eight spaces, and a row that starts at the left edge is the
start of one of the tool's lines (a `with arguments` line starts after two spaces). So text from a change file or
from the policy file is not at the start of a row: it follows the tool's own words, or it is on a row that starts
with eight spaces. Where it does not hold in that form:

- Some messages start with a path, not with the tool's words. `<path> is not a regular file on a local drive`
  starts with the path as it was given on the command line, which whoever started the tool chose; read such a line
  to its end. `<path> exists and is not a folder; ...`, `<path> is a folder, not a policy file; ...` and the line
  with which `show` says why the runner would refuse the file (`<path>: ...`) start with the backup folder's or the
  policy file's own path.
- `show` prints your policy file. Each line of the file starts a row with whatever the file holds, and only the rest
  of a long line is on rows that start with eight spaces (a line of the file that itself starts with eight spaces
  looks the same).
- The first line (`Creating a new policy ...`, `Changing the policy ...`, `Policy file: ...`), the count line and the
  tool's fixed messages (`Policy updated. ...`) are not broken by the tool. They hold the tool's own words, numbers
  and the policy file's path (the default, or the one you gave with `--policy`); in a window narrower than they are,
  the console breaks them.

Before it asks, the tool reads the size of its console's screen buffer: its width, and the rows it keeps and lets
you scroll back to. Whoever starts the tool through the administrator prompt may be able to choose that size. When
the buffer has fewer than 77 columns, or keeps fewer rows than the first line, the summary, the count line and the
prompt take in 77 columns, the tool does not ask and exits 1:
`This window cannot show the whole summary (it needs <rows> rows and 77 columns). Start RpaPolicy from an
administrator console and run the command again.` The test is made only when the tool is about to ask and its output
is a console. It looks at the buffer, not at how much of it the window shows at once. A terminal that keeps its
scrollback itself may report a buffer only as tall as its window; a long summary is then refused in it, also in an
administrator console (use a classic console window or a taller window, or split the change).

Warnings come directly under the line they belong to (under an app line, before its `with arguments` lines):

| Warning | When |
|---|---|
| `WARNING: this line holds characters outside plain ASCII, shown as \u escapes` | A value in the line has a character other than a printable ASCII one. |
| `WARNING: a value in this line has leading, trailing or repeated spaces` | A value in the line starts or ends with a space, or has two or more spaces in a row. Spaces are printed as they are, and a long run of them can push the rest of a value onto the next row of the window, where it can look like a line of its own. |
| `WARNING: "<path>" can be changed by the runner's own user` | The app is, or becomes, `allowUserWritable`. It is printed on every line for such an app. |
| `WARNING: any program at this path counts as part of the app that started it` | Under every `Add helper process` line. |

Every value from the change is printed as a JSON string literal: in double quotes, with `"` and `\` escaped (so a
Windows path shows doubled backslashes) and every character outside printable ASCII written as `\uXXXX`. A no-break
space in `C:\Program Files` is printed as `\u00A0`, an invisible character as its code, and a file named
`x.exe (SHA-256 pinned)` inside its quotes; the quotes show where each value starts and ends. Everything else the tool
prints (messages, the `show` output, paths) has control and format characters written as `\uXXXX` too.

These measures make a misleading change harder to write; they do not replace reading the lines. Read each of them and
the count line, and answer `n` when anything is unclear. Limits that remain: a summary may be up to 8,000 characters
long (more than 100 rows), which the buffer keeps but a window does not show at once, so scroll up to the first
line (`Creating a new policy ...` or `Changing the policy ...`) before you answer; and the tool cannot tell whether a
path that looks right is the program you mean.

### What the tool writes, and what it trusts

- **The existing policy file.** Before the tool reads an existing policy file (for `show`, `apply` and `allow-app`) it
  runs the runner's own start check on it. When someone other than an administrator owns the file or could change or
  replace it, the tool stops: `the existing policy file cannot be trusted: <problem>; an administrator must check and
  replace it`. Such a file may have been put there by a user who is not an administrator.
- **Writing.** The tool writes the new policy to a temporary file beside the policy
  (`policy.json.<32 hex digits>.tmp`, created for Administrators and SYSTEM only) and swaps it in in one step. It
  compares the policy file with what it read at its start before it creates anything, and again, with the backup
  copy, directly before the swap, and does not swap when the file differs; a change made between that last comparison
  and the swap is not seen. When the file changed in between
  (another administrator edited it while you read the summary), the tool prints
  `the policy file changed while this change was being applied; nothing was written` and exits 1. Run the command
  again to see the change against the policy as it is now. When there was no policy file at the start, the new one
  is moved into place only if nothing has its name by then; otherwise the tool prints
  `a policy file appeared while the change was being applied; nothing was written` and exits 1. Look at the file that
  appeared before you run the command again: the tool did not make it.
- **Backups.** Before the swap the tool writes the old policy (the bytes it read at its start) to `policy-backups\`
  beside the policy, as `policy.json.<yyyyMMdd-HHmmss>.bak`. When that name is taken (by a file or a folder), the
  tool takes `-2.bak`, then `-3.bak`, and so on. The tool creates the folder for Administrators and SYSTEM only. A
  backup is a new file in that folder: its owner is Administrators and its access rules are the ones it inherits
  from the folder, not the policy file's (which let the runner's user read the policy). The tool does not delete a
  backup it has made, so a change that failed or was stopped after this step leaves a backup of a policy that did
  not change.
- **When writing fails.** The tool exits 1 and does not restart the runner. A failure before the swap (the
  temporary file or the backup could not be written) leaves the policy file untouched:
  `Writing the policy failed: <reason>. The runner keeps running with the policy it has.` After a swap that failed,
  the tool looks at what is under the policy's name before it removes anything:
  - The policy file is there and holds the old policy: the tool removes the temporary file and prints the message
    above.
  - The policy file is there, but holds something else or cannot be read (a file that another program is deleting
    keeps its name for a while and cannot be opened): the tool removes nothing and prints
    `... The policy file at <path> is still there, but the tool could not confirm that it is unchanged; look at it.
    A copy of the old policy is at <backup>. The changed policy, which was not applied, is at <temporary file>.`
    Look at the policy file; when it is gone or wrong, copy the backup to its path as described below, and delete
    the temporary file.
  - There is no policy file (Windows documents a failed replace that leaves none): the tool moves the old policy
    back from its backup copy, which fails when something has the name by then, gives it the permissions its folder
    gives, runs the runner's start check on it, and only then removes the temporary file:
    `... After the failed swap there was no policy file at <path>; the tool put the old policy back there from its
    backup copy, with the permissions its folder gives.` Permissions someone had set on the old file by hand are not
    carried over; when the start check finds a problem, the message names it.
  - There is no policy file and the old policy could not be moved back: both files stay where they are, and the
    message names them: `... After the failed swap there is no policy file at <path>, and putting the old policy
    back failed: <reason>. The old policy is at <backup>. The changed policy, which was not applied, is at
    <temporary file>. An administrator must put the old policy back at <path>: the runner reads it when it starts.`
    Copy the backup to the policy's path, check that the runner's user can read it and that only administrators can
    change it, and delete the temporary file.

  For a new policy the messages are `Writing the policy failed: <reason>. No policy file was written.` and, when
  the file is in place but still has the temporary file's permissions,
  `The policy file was written at <path>, but it could not be given the permissions of its folder: <reason>. ...`
  When a temporary file could not be removed, the message ends with its path.
- **What can stop a change before it is shown.** The runner's user may be able to create files and folders beside the
  policy, so the tool looks at what it is about to use before it prints the summary, and stops with exit 1 when:
  - a `policy-backups` folder is already there and is a link, or someone other than an administrator owns it, can
    change it or can create files or folders in it:
    `the backup folder cannot be trusted: <problem>; an administrator must check and remove it`;
  - a file has the folder's name: `<path> exists and is not a folder; an administrator must check and remove it`;
  - a folder has the policy file's name:
    `<path> is a folder, not a policy file; an administrator must check and remove it`.

  When one of these is shown, look at the item and at who created it, move anything you want to keep, remove the
  item, and run the command again. The tool does not remove it for you.
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
dotnet test desktop/recorder/test/Rpa.Recorder.Core.Tests
```

No .NET SDK? `docker run --rm -v "$PWD/desktop:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 dotnet test runner/test/Rpa.Runner.Core.Tests`.
The UI parts run only on Windows: the `desktop` workflow builds and publishes everything on `windows-latest` (Windows
Server 2025 in November 2026), starts

the runner and drives the ERP Demo through it with the scenario client, records the same flow with `RpaRecorder.exe`, then builds the Windows package, installs it
and drives it, and installs it again with `-Unattended` and drives it through the RPA Supervisor. Its artifact `rpa-windows-package` holds the package, `rpa-windows-x64.zip`, with its SHA-256 (see
"Releasing the Windows package"); the artifacts `rpa-desktop-runner` and `erp-demo` are the self-contained win-x64
builds of the runner and the demo app (no .NET install needed).

## Releasing the Windows package

The maintainers release the Windows package, `rpa-windows-x64.zip`, from the `Desktop release` workflow
(`.github/workflows/desktop-release.yml`). Pushing a tag `desktop-v<version>`, where `<version>` is the `<Version>` in
`desktop/Directory.Build.props` (for example `desktop-v0.2.0`), starts it:

1. It checks that the environment `desktop-release` exists and has required reviewers, that the tag names that
   version, that the tagged commit is on `main`, and that `CHANGELOG.md` has a section `## <version>`, which becomes
   the release notes. The node's release of the same version number uses the same section. If any check fails,
   nothing is built. The notes are uploaded as an artifact, and their SHA-256 and the artifact's id are kept for
   step 4.
2. It runs the `desktop` workflow, which builds the package, tests it, installs it on `windows-latest` and drives it.
3. It checks the package it built. It downloads the package by the artifact id the `desktop` workflow reports, not by
   the artifact's name, so an artifact of the same name uploaded by another job of the run is not taken; the download
   fails if the archive differs from the digest GitHub recorded for that artifact (when it recorded one). It compares
   the zip's SHA-256 with the hash the `desktop` workflow computed when it staged the zip (not with the `.sha256` file
   in the artifact), checks that `rpa-windows-x64.zip.sha256` holds that same hash, and that the `VERSION` file in the
   zip is the tag's version.
4. It waits until a required reviewer of the `desktop-release` environment approves the release (see "Before the
   first release" for what that approval covers). Then it downloads and checks the package again in the same way,
   downloads the notes by the id from step 1 (not by name) and compares them with the SHA-256 from step 1, checks
   that the tag still names the commit it built, records a build attestation of the zip and creates the GitHub
   Release `desktop-v<version>` with `rpa-windows-x64.zip` and `rpa-windows-x64.zip.sha256`. It stops if a release
   for that tag exists already, a draft included; it does not replace one. The release is not marked as the
   repository's latest release, which stays the node's.

A manual run (Actions, `Desktop release`, Run workflow, on `main`) is a dry run: it does steps 1 to 3 with the
version of `desktop/Directory.Build.props` in place of a tag, and never attests or publishes anything.

**Before the first release**, in the repository settings:

- Environments: create the environment `desktop-release`, add required reviewers (the people who approve each
  release), and add a deployment tag rule `desktop-v*`. GitHub creates an environment that does not exist when a job
  first names it, with no protection; step 1 stops the workflow while `desktop-release` has no required reviewers.
- Rules, Rulesets: add a tag ruleset for `desktop-v*` that restricts creating, updating (moving) and deleting such
  tags, with only the release maintainers allowed to bypass it. The approval of the environment applies to a run of a
  workflow file that names the environment, and whoever can push a tag also chooses the workflow file of the tagged
  commit: one that leaves the environment out, or these checks, runs without asking anyone. The ruleset limits who
  can push such a tag.

Then run the dry run once on `main`.

The package is not code-signed: the zip has no signature, and neither have the runner, the policy tool, the ERP Demo
or the PowerShell scripts in it (the files it ships from other projects, such as `node.exe` and Chromium, are as those
projects publish them). What a release has instead is the zip's SHA-256 and a build attestation. Check both before
you unpack a download, with the release's version in place of `<version>`:

```sh
gh attestation verify rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa \
  --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml \
  --source-ref refs/tags/desktop-v<version>
sha256sum -c rpa-windows-x64.zip.sha256
```

In PowerShell, compare `(Get-FileHash rpa-windows-x64.zip -Algorithm SHA256).Hash` with the hash in
`rpa-windows-x64.zip.sha256` (the case differs). The hash shows only that the download matches the file next to it
on the release page. The attestation shows which workflow, ref and commit of this repository attested the zip; with
the two flags above, `gh` refuses an attestation made by another workflow or for another ref. It does not show that
the commit was reviewed, or that the zip is what the source code would build elsewhere.

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

`resolve` and `act` look for their target every 200 ms until one candidate matches exactly one visible element or
`timeoutMs` runs out. A primary target that matched more than one element on every look for 3 seconds is answered
`not_unique` then (with the count and what to add to the locator), without waiting out a longer `timeoutMs`; a window
that is still drawing can show two matches for a moment and then one, which resolves. A target that matches nothing
waits the whole `timeoutMs` (`not_found`), and so does an `act` on a disabled element (`timeout`, with what to do
instead). A window selector that matches only a window of a copy of an allowed app that the run did not start (one a
person left open, or one an app that keeps one window handed the launch to) is `policy_refused` with a message that
says to close that copy.

Beyond the minimum: `act` with `action: "key"` may omit `target` (the key goes to the run's focused element, under the
same write checks); `snapshot` adds `truncated: true` when it stopped at `maxNodes` or `maxDepth`; `windows { runId }`
returns `{ windows: [{ title, exe, automationId, className, foreground }] }`, the run's top-level windows (its own and
owned windows, such as dialogs and open menu drop-downs, never another application's), the foreground window first
(`foreground: true`, only when it is the run's), then front to back, at most 20.

`clipboard.read { runId }` returns `{ text }`, the clipboard's Unicode text (`""` when it holds none). It returns only
the run's own copy: it does not return text another application or a person copied (a password). A paste key
(`Ctrl+V`, `Shift+Insert`) is a key like any other, though: `act` sends it, the app pastes whatever the clipboard
holds, and an `act` with `action: "read"` or a `snapshot` returns the field's text (a password field, or one named
like a credential, comes back redacted). On a machine where the clipboard matters, such as a person's own desktop,
list both chords in `gatedKeys`, so that an `act` needs `write: true` to send them (an app's own Paste menu item is a
click, which the two chords do not cover). `clipboard.read` is `policy_refused`:

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
