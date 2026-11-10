# Installing RPA on a Windows machine

This guide installs the RPA desktop runner and the RPA browser on one Windows machine, connects them to your n8n, and
runs a sample flow against the ERP Demo app that comes with the package. Follow it from top to bottom; each step says
what to type and what you should see.

This is an open-source project under the [MIT licence](../../LICENSE), provided as is, without warranty of any kind.
Try it on a machine you can rebuild before you use it for real work.

What you get on the Windows machine:

- **The RPA desktop runner** (`RpaRunner.exe`). n8n sends it desktop steps (`"surface": "desktop"`), and it drives
  Windows apps through UI Automation. It listens on `wss://<machine>:8765/rpa/v1`.
- **The RPA browser**: a Chromium browser behind a token gate with its own certificate. n8n drives it like any
  browser server, and it listens on `wss://<machine>:3000`.
- **The policy tool** (`RpaPolicy.exe`), with which an administrator decides which apps the runner may start.
- **The ERP Demo**, a small sample app, for the sample flow.

Both programs run inside the signed-in Windows session of one user, the **bot user**, and start when that user signs
in. A Windows service cannot drive a desktop, so the bot user must be signed in, with its desktop unlocked, whenever
a run should work.

The package was tested on Windows Server 2022. Windows 10, Windows 11 and Windows Server 2019 or 2025 meet the
installer's requirements but have not been tested end to end.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Download and check](#2-download-and-check)
3. [Install](#3-install)
4. [Signing in](#4-signing-in)
5. [Connect n8n](#5-connect-n8n)
6. [Run the sample](#6-run-the-sample)
7. [Allowing your own app](#7-allowing-your-own-app)
8. [Upgrade and uninstall](#8-upgrade-and-uninstall)
9. [Changing the tokens and the certificates](#9-changing-the-tokens-and-the-certificates)
10. [When something fails](#10-when-something-fails)

## 1. Before you start

Check each of these before you download anything.

- [ ] **Windows**: 64-bit Windows 10 version 1809 (build 17763) or later, Windows 11, or Windows Server 2019 or later.
  To see the build, run `winver`, or in PowerShell `[Environment]::OSVersion.Version`; the third number is the build.
  The installer refuses an older build.
- [ ] **An administrator account** on the machine, for the install and for every change to the policy.
- [ ] **A user for the bots.** The installer creates a local standard user, `rpa-runner` by default, or uses one you
  name with `-User` (a local user, or a domain user written `DOMAIN\name`, which must exist already). The bot user must
  be a standard user: the installer refuses a member of Administrators. Decide how it will be signed in (section 4):
  automatically, or by a person.
- [ ] **Licences.** Read [the licensing note](licensing.md) and settle with your licensing contact what this use of
  Windows needs.
- [ ] **The network path from n8n to this machine**: n8n must reach TCP port **8765** (the runner) and TCP port
  **3000** (the browser) on this machine. Note the address of your n8n host as this machine sees it (for the firewall
  rule in section 3), and open both ports in any firewall between the two, such as a cloud security group. To use
  other ports, give `-RunnerPort` and `-BrowserPort` to the installer.
- [ ] **A self-hosted n8n** with community nodes enabled and the package `n8n-nodes-rpa` **0.2.0 or later**
  installed (**Settings → Community nodes → Install**; the [README](../../README.md#operator-guidance) has the
  details). n8n Cloud cannot install this node.
- [ ] **Where the secrets will live.** The installer makes two tokens on this machine, one for the runner and one for
  the browser. You copy each into an n8n credential, where n8n keeps it encrypted. Decide who may read them on this
  machine (administrators can) and who may edit those credentials in n8n.

All commands below run in **Windows PowerShell 5.1 opened with "Run as administrator"** (Start, type
`Windows PowerShell`, right-click it, **Run as administrator**). Not PowerShell 7 (`pwsh`), and not
"Windows PowerShell (x86)": the installer refuses both.

## 2. Download and check

The package is `rpa-windows-x64.zip` on the GitHub Release `desktop-v<version>` of
[jb-n8n/n8n-nodes-rpa](https://github.com/jb-n8n/n8n-nodes-rpa/releases), next to `rpa-windows-x64.zip.sha256`.
The zip is about 570 MB and unpacks to about 1.1 GB. It is not code-signed; what the release has instead is the zip's
SHA-256 and a build attestation. Check both before you unpack it.

**Download.** In the administrator PowerShell (the first line makes Windows PowerShell 5.1 use TLS 1.2, which GitHub
requires; the second hides a progress bar that makes large downloads very slow):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$version = '0.2.0'
$download = Join-Path $env:USERPROFILE "Downloads\rpa-$version"
New-Item -ItemType Directory -Force -Path $download | Out-Null
Set-Location $download
$base = "https://github.com/jb-n8n/n8n-nodes-rpa/releases/download/desktop-v$version"
Invoke-WebRequest -UseBasicParsing -Uri "$base/rpa-windows-x64.zip" -OutFile rpa-windows-x64.zip
Invoke-WebRequest -UseBasicParsing -Uri "$base/rpa-windows-x64.zip.sha256" -OutFile rpa-windows-x64.zip.sha256
```

**Check the hash.** `Get-FileHash` computes the zip's SHA-256; the `.sha256` file holds the published one (in lower
case; PowerShell's `-eq` ignores case):

```powershell
$published = ((Get-Content .\rpa-windows-x64.zip.sha256 -TotalCount 1) -split '\s+')[0]
$computed = (Get-FileHash .\rpa-windows-x64.zip -Algorithm SHA256).Hash
if ($computed -eq $published) { 'The hash matches.' } else { 'The hash DIFFERS: do not use this file.' }
```

You should see `The hash matches.` The hash shows only that the zip is the file that was published next to it.

**Check the attestation.** The attestation shows which workflow, tag and commit of the repository built and attested
the zip. Check it with the [GitHub CLI](https://cli.github.com/) (`gh`, signed in with `gh auth login`), on this
machine or on another one that has the same zip (compare the hash there too):

```powershell
gh attestation verify rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa `
  --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml `
  --source-ref "refs/tags/desktop-v$version"
```

It should end with a line that says the verification succeeded. With these two flags `gh` refuses an attestation
made by another workflow or for another tag. It does not show that the commit was reviewed, nor that the zip is what
the source code would build elsewhere.

**Unblock, then unpack.** Windows marks a downloaded file as coming from the internet, and Windows PowerShell does
not run scripts that carry the mark under the `RemoteSigned` policy (the default on Windows Server). `Unblock-File`
removes the mark; do it only after both checks passed. Then unpack the package into a folder that only
administrators can change. The installer checks that: it reads the owner and the access rules of every file and
folder of the package and of the folders above it, and refuses when anyone else could change them. A folder under
`C:\Program Files` made from this administrator PowerShell passes:

```powershell
Unblock-File -LiteralPath .\rpa-windows-x64.zip
$package = "C:\Program Files\RPA package\$version"
New-Item -ItemType Directory -Force -Path $package | Out-Null
Expand-Archive -LiteralPath .\rpa-windows-x64.zip -DestinationPath $package
Get-ChildItem -LiteralPath $package -Recurse -File | Unblock-File
Set-Location (Join-Path $package 'rpa-windows-x64')
Get-ChildItem
```

You should see `Install-Rpa.ps1`, `Uninstall-Rpa.ps1`, the `RpaInstall.*` files, `LICENSE`, `VERSION` and the folders
`runner`, `browser`, `scripts` and `erp-demo`. `Get-Content VERSION` shows the version. If you unpacked the zip some
other way (for example with Explorer), run the `Get-ChildItem ... | Unblock-File` line on that folder too.

Keep the unpacked package after the install: changing a token or a certificate (section 9) and removing the data
directory (section 8) run from it.

## 3. Install

### The command

Still in the administrator PowerShell, in the package folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\Install-Rpa.ps1 -AllowFrom <n8n address> -UserPassword (Read-Host 'Password for the new user rpa-runner' -AsSecureString)
```

Replace `<n8n address>` with your n8n host's address, for example `-AllowFrom 10.0.0.5`. The first line lets this
PowerShell window, and only this window, run the installer's scripts (a policy set by Group Policy can still forbid
it). `Read-Host` asks for the password without showing it; type a password that meets your Windows password rules.
That password is for signing the bot user in by hand (section 4). To have Windows sign the bot user in by itself
instead, read section 4 first and use `-AutoSignIn`.

The parameters:

| Parameter | What it does |
|---|---|
| `-User <name>` | The bot user. Default `rpa-runner`. A local user that does not exist is created as a standard user (a member of Users, its password never expires); `DOMAIN\name` must exist already. An existing user's password is never changed, and an existing user that is an administrator is refused. |
| `-UserPassword <SecureString>` | The password for a new local user, or, with `-AutoSignIn`, the existing user's password to store (it is tried against the account first). A new user needs `-UserPassword` or `-AutoSignIn`. |
| `-RunnerPort <n>` | The runner's port. Default 8765. |
| `-BrowserPort <n>` | The browser's port. Default 3000. |
| `-AllowFrom <address>[,<address>...]` | Windows Firewall lets in only these addresses (IP addresses, or ranges such as `10.0.0.0/24`), only for the two programs, on every network type (Domain, Private and Public). `0.0.0.0/0` is refused: that is what `-AllowFromAnyAddress` is for. |
| `-AllowFromAnyAddress` | The firewall rules let in any address, on Domain and Private networks only. Where the machine's network is Public (most cloud machines and machines outside a domain), a first install is refused unless you add `-IncludePublicNetwork`. |
| `-IncludePublicNetwork` | With `-AllowFromAnyAddress`: the rules apply on Public networks too. |
| `-NoFirewall` | Leaves Windows Firewall alone; you open the ports yourself. |
| `-NoBrowser` | Installs the runner only. |
| `-AutoSignIn` | Windows signs the bot user in by itself at every start and keeps the desktop unlocked (section 4). |
| `-Force` | Does not ask (about `-AutoSignIn`, or about another `-User` than the one of the install), and upgrades even while the runner is running (a run in progress fails). |

A first install needs exactly one of `-AllowFrom`, `-AllowFromAnyAddress` and `-NoFirewall`.

### Who can reach the ports

The runner and the browser accept anyone who can reach their port and has their token: the runner then drives the
apps its policy allows, and the browser opens pages for whoever connects. So limit who can reach the ports:

- **`-AllowFrom <the n8n host's address>`** (recommended): only n8n can connect. If n8n runs as several machines
  (queue mode workers), list each address, or the range they are in.
- `-AllowFromAnyAddress`: any machine that can route to this one can connect, and only the tokens keep it out.
- `-NoFirewall`: the installer adds no rule. What Windows Firewall or your network does decides who can connect.

Both tokens are files in `C:\ProgramData\RPA Runner` (`token` and `browser-token`), readable by the bot user, and so
by every program the bot user runs, and by administrators. Nobody else can read them.

### What you should see

```text
Checking the package's files...
Installing RPA:
  copy program files
  create user
  protect the data directory
  write policy
  write token
  write browser-token
  add the runner firewall rule
  add the browser firewall rule
  register the runner task
  register the browser task
  write install.json

RPA is installed.
  Programs:  C:\Program Files\RPA Runner
  Data:      C:\ProgramData\RPA Runner (policy.json, the tokens, the certificates, logs)
  Policy:    C:\ProgramData\RPA Runner\policy.json
             It is new and allows no app. Change it with C:\Program Files\RPA Runner\runner\RpaPolicy.exe
  Tasks:     \RPA\RPA Runner and \RPA\RPA Browser start when rpa-runner signs in
  Firewall:  inbound TCP 8765 and 3000 are open to 10.0.0.5 (rules RPA-Runner-In and RPA-Browser-In)
             on Domain, Private and Public networks
  Remove:    C:\Program Files\RPA Runner\Uninstall-Rpa.ps1

Sign in as rpa-runner, then run Show-RpaConnection.ps1:
  C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1"
If rpa-runner is already signed in, sign out and sign in again.
```

The steps listed depend on the parameters (`create user` only for a new user, the sign-in steps only with
`-AutoSignIn`). The installer prints no secret. Exit codes: 0 installed, 1 refused or failed, 3 declined at a
question. When it refuses, it says why and `Nothing was changed.`; fix the cause and run the same command again.

### What the installer changes on the machine

- **Programs** in `C:\Program Files\RPA Runner` (only administrators can change them): `runner\` (the runner and the
  policy tool), `browser\` (Node.js, the browser host and Chromium), `scripts\`, `erp-demo\v1` and `erp-demo\v2`,
  the uninstaller, and `install.json`, which records the parameters of the install.
- **Data** in `C:\ProgramData\RPA Runner`, owned by Administrators: `policy.json` (allows no app yet), `token` and
  `browser-token` (48 random characters each), `logs\`, and later the certificates the runner and the browser make
  when they first start (`runner-certificate.pfx.bin`, `browser-cert.pem`, `browser-key.pem`), the export folders
  of runs and `policy-backups\`. The bot user can read the policy and the tokens and cannot change them; it can
  create files there (the certificates, exports) and change what is in `logs\`.
- **The bot user**, when it did not exist: a local standard user.
- **Two scheduled tasks** in the folder `\RPA\`: `RPA Runner` and `RPA Browser`. Each starts at the bot user's sign-in,
  in that user's session, without administrator rights, and starts its program again within 10 seconds whenever it
  exits.
- **Two Windows Firewall rules**, `RPA-Runner-In` and `RPA-Browser-In` (not with `-NoFirewall`).
- **With `-AutoSignIn`** only: the settings listed in section 4.

The browser also keeps a temporary folder in the bot user's profile (`AppData\Local\RPA Runner\browser-temp`), which
it empties at every start and after every session.

## 4. Signing in

The runner and the browser start when the bot user signs in, and the runner can drive apps only while that user's
desktop is unlocked and shown: on a locked or disconnected desktop runs fail with `runner_unavailable` (section 10).
**Test connection** on the RPA Desktop Runner credential tells you the state: `session interactive` is what you want,
`session locked` is not.

There are two ways to keep the bot user signed in.

### Automatic sign-in (`-AutoSignIn`)

Add `-AutoSignIn` to the install command. For a new user you may leave out `-UserPassword`: the installer then
generates a random password that nobody knows and stores it for Windows. For an existing user, give its password with
`-UserPassword`. Before it changes anything, the installer lists what `-AutoSignIn` does and asks you to type `YES`
(not with `-Force`).

What it stores and changes:

- **The password** of the bot user is stored on this machine where Windows keeps a password for automatic sign-in
  (the LSA secret `DefaultPassword`, not the registry). An administrator of this machine can read it.
- Windows signs the bot user in by itself at every start, and again after a sign-out.
- **For the whole machine, for every user**: the lock screen and the lock when idle are turned off, the display and
  sleep timeouts are set to never, and the first sign-in animation, Server Manager at sign-in and the new network
  question are turned off.
- **For the bot user**: the screen saver and the Lock command are turned off.

What it costs: **anyone who can reach this machine's screen or console** (a person at the machine, the console of a
virtual machine in your hypervisor or cloud, a remote console tool) gets the bot user's signed-in desktop, with the
apps the bot user can open and the tokens it can read. Use it only on a machine whose console is as protected as the
bots' work requires. What Windows licensing says about a machine signed in for unattended work is in
[the licensing note](licensing.md).

`Uninstall-Rpa.ps1` puts these settings back to what they were before the install. It cannot bring back a password
that was stored for automatic sign-in before.

After the install, restart the machine (`Restart-Computer`). Windows signs the bot user in, and both programs start.

### Signing in by hand

Install with `-UserPassword` and without `-AutoSignIn`, then sign in as the bot user, with that password, at the
machine's console, and leave the session open with the desktop unlocked. Lock screen and screen saver settings stay
as they are, so set them for the bot user so that its desktop does not lock while it should work.

To sign in as the bot user through Remote Desktop, it must be allowed to (Windows allows administrators and the
members of the Remote Desktop Users group). Add it from the administrator PowerShell:

```powershell
Add-LocalGroupMember -SID 'S-1-5-32-555' -Member rpa-runner
```

**Disconnecting a Remote Desktop session locks that desktop**, and runs then fail. Before you close the Remote Desktop
window, hand the session back to the machine's console: in the bot user's Remote Desktop session, open a Command
Prompt and run

```text
query session
tscon <ID> /dest:console
```

with the ID that `query session` shows on the line marked `>` (your session). Your Remote Desktop window closes, and
the bot user's desktop stays unlocked on the console. If Windows answers that access is denied, run the `tscon`
line from a Command Prompt opened with "Run as administrator" in that same session; as another user, `tscon`
needs the bot user's password (`/password:*`). See Microsoft's [tscon
reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon).

On Windows 10 and 11, one person uses the desktop at a time: when someone else signs in or switches user, the bot
user's session is disconnected and runs fail until it is back. Windows Server allows two Remote Desktop sessions for
administration at once; more, or other uses, need Remote Desktop Services licences ([licensing note](licensing.md)).

### After the first sign-in

Within a minute of the bot user's sign-in both programs listen, and each has made its certificate. Check from the
administrator PowerShell:

```powershell
& 'C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1'
```

```text
Runner URL: wss://10.0.0.20:8765/rpa/v1
Runner fingerprint: 2E:4B:91:7B:...:7B:66:88:4C
Browser URL: wss://10.0.0.20:3000
Browser fingerprint: 69:46:74:56:...:A3:15:2D:C3
```

(one URL line per IPv4 address of the machine). `fingerprint: not known yet` means that program has not started yet
as the bot user; `Runner: not listening: see <log>` names the log to read (section 10).

## 5. Connect n8n

### What to copy

Run, in the administrator PowerShell:

```powershell
& 'C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1' -ShowTokens
```

It prints the four lines above and two more, `Runner token: ...` and `Browser token: ...`. `-ShowTokens` works only
in an administrator PowerShell, and the tokens are printed only with it. Copy each value into n8n as below, then close
the window or run `Clear-Host`, so that the tokens do not stay on the screen.

The fingerprints are read from files the bot user can write (the runner's start line in `logs\runner.out.log`, the
browser's `browser-cert.pem`). So copy them while you trust what has run as the bot user, best right after the
install. The fingerprints stay the same across restarts and upgrades.

Use an address from the URL lines that n8n reaches this machine by. If n8n reaches it through another address or a
host name (a NAT, a DNS name), use that one with the same port and path.

### The RPA Desktop Runner credential

In n8n: **Credentials → Add credential → RPA Desktop Runner**.

| Field | Value |
|---|---|
| **Runner URL** | The `Runner URL` line, for example `wss://10.0.0.20:8765/rpa/v1` (`wss://10.0.0.20:8765` works too). |
| **Token** | The `Runner token` line, without the label. |
| **Certificate Fingerprint** | The `Runner fingerprint` line, without the label (64 hexadecimal digits with colons). |

Save, then **Test connection**. You should see `Connected to the desktop runner (session interactive)`. n8n checks
the runner's certificate against the fingerprint before it sends the token.

### The RPA Browser credential

In n8n: **Credentials → Add credential → RPA Browser**.

| Field | Value |
|---|---|
| **Mode** | Browser Server |
| **Endpoint URL** | The `Browser URL` line, for example `wss://10.0.0.20:3000` |
| **Token** | The `Browser token` line, without the label |
| **Certificate Fingerprint (SHA-256)** | The `Browser fingerprint` line, without the label |
| **Private Network Endpoint** | Off (it is for plain `ws://` addresses; this one is `wss://`) |

Type the three values directly, not as expressions. Save, then **Test connection**. You should see
`Connected to the browser server (1.63)`. In Browser Server mode the credential has no Headless setting: the browser
server decides how the browser starts.

## 6. Run the sample

The sample runs the ERP Demo in the bot user's session: it signs in, searches the line items of company code 1000,
reads the result count, and exports the line items as a CSV, which comes back to n8n as a file. Three files belong to
it, in [`docs/install/samples/`](samples/):

- [`erp-demo-policy-change.json`](samples/erp-demo-policy-change.json): allows the ERP Demo (v1) at its installed
  path, its Post button as a write control, and Ctrl+S and F11 as gated keys. Nothing else.
- [`erp-demo.workflow.json`](samples/erp-demo.workflow.json): the n8n workflow.
- [`erp-demo-steps.json`](samples/erp-demo-steps.json): the desktop steps, the same ones the workflow holds.

### Allow the ERP Demo

A new policy allows no app, so the runner refuses to start the ERP Demo until you allow it. On the Windows machine,
in the administrator PowerShell, write the change file into the package folder (the policy tool takes a change file
only from a local drive, through no link):

```powershell
$change = Join-Path $package 'erp-demo-policy-change.json'
@'
{
  "allowedApps": [
    { "exe": "ErpDemo.exe", "path": "C:\\Program Files\\RPA Runner\\erp-demo\\v1\\ErpDemo.exe" }
  ],
  "writeControls": [
    { "exe": "ErpDemo.exe", "automationId": "btnPost" }
  ],
  "gatedKeys": ["Ctrl+S", "F11"]
}
'@ | Set-Content -LiteralPath $change -Encoding ASCII
& 'C:\Program Files\RPA Runner\runner\RpaPolicy.exe' apply $change
```

(The text is the content of `erp-demo-policy-change.json`. If `$package` is not set any more because you opened a
new window, set it again as in section 2.) The tool prints what the change does and asks:

```text
Changing the policy at C:\ProgramData\RPA Runner\policy.json (0 app(s), 0 helper process pattern(s) today).
Add write control "ErpDemo.exe" / "btnPost"
Add gated key "Ctrl+S"
Add gated key "F11"
Allow app "ErpDemo.exe" at "C:\\Program Files\\RPA Runner\\erp-demo\\v1\\Erp
        Demo.exe"
This change: 1 app(s) allowed or updated, 0 helper process pattern(s), 1 write control(s), 2 gated key(s).
Apply these changes? [y/N]
```

Read the lines, type `y` and Enter. It answers
`Policy updated. The runner restarts within 10 seconds and uses the new policy.` `RpaPolicy.exe show` prints the
policy as it is now.

### Import and run the workflow

1. Download [`erp-demo.workflow.json`](samples/erp-demo.workflow.json) to the computer you use n8n from (on GitHub,
   open the file and use **Download raw file**).
2. In n8n, create a workflow, open its **⋯** menu and choose **Import from File**, then pick the file. The workflow
   `RPA: ERP Demo sample (Windows)` has a sticky note, a manual trigger **Click Execute** and one RPA node,
   **Export ERP Demo line items**.
3. Open **Export ERP Demo line items** and pick your **RPA Desktop Runner** credential. The file names no credential
   and no host: this is the only thing to fill in.
4. Make sure the bot user is signed in with its desktop unlocked (section 4), then click **Execute workflow**.

The node runs **Run Steps** with these settings, which you can see in the node:

- **Steps (JSON)**: the 17 steps of `erp-demo-steps.json`.
- **Require Signed Steps**: off, so that the sample runs as it is. For your own steps keep it on, and sign the steps
  with **Sign Steps** (README, Run Steps reference). The sample has no write step: it reads and exports only.
- **Options → Variables**: `username` `clerk` and `password` `demo1234` (the ERP Demo's documented sign-in, which is
  not a secret), `in_CompanyCode` `1000`, `in_DateFrom` `2026-01-01`, `in_DateTo` `2026-12-31`. For your own app,
  give a password from a secret source (an n8n external secret, or a node that reads your vault), never as text in a
  workflow.

On the bot user's desktop the ERP Demo opens, signs in, searches and saves the export, then closes when the run ends.

### What the result looks like

The node's output is one item:

```json
{
  "url": "desktop://ErpDemo.exe/ERP Demo - Line items",
  "title": "ERP Demo - Line items",
  "status": null,
  "name": "erp-demo",
  "version": 1,
  "lane": "script",
  "values": { "out_ResultCount": "12 line items", "out_FirstDocument": "1000-0001" },
  "files": [{ "fileName": "line-items.csv", "mimeType": "text/csv", "bytes": 773, "binaryProperty": "file_16" }]
}
```

with more fields (`hash`, `durationMs`, a `log` of the steps). The **Binary** tab has `file_16`, `line-items.csv`:
a header line `Document,Date,Company,Vendor,Amount,Currency,Status` and 12 rows, `1000-0001` to `1000-0012`. The
password typed from the variables does not appear in the output.

If the run fails, the item has an `error` such as `runner_unavailable: ...` or `policy_violation: ...`; section 10
says what each means.

## 7. Allowing your own app

The runner starts only the apps its policy lists, at the path the policy names. Install your app where only
administrators can change it (such as under `C:\Program Files`); the runner refuses an app at a path the bot user
could change unless the policy says otherwise. Then, in the administrator PowerShell:

```powershell
& 'C:\Program Files\RPA Runner\runner\RpaPolicy.exe' allow-app 'C:\Program Files\Your App\YourApp.exe' --pin-hash
```

It shows the change and asks, as above. `--pin-hash` also pins the file's SHA-256, so that the runner starts only
that exact file; run the command again after the app is updated. Give the path by the app's real location on a local
drive, not through a link, a mapped network drive or a `subst` drive: the tool refuses those.

`allow-app` adds the app only. To declare the controls that save, post or submit (`writeControls`), the keys that do
(`gatedKeys`), the helper processes of a web view app or clipboard reads, write a change file like the sample's and
apply it with `RpaPolicy.exe apply <file>`. A change only adds; to remove an entry, an administrator edits
`C:\ProgramData\RPA Runner\policy.json` by hand. [`desktop/README.md`](../../desktop/README.md#changing-the-policy)
describes every field and every message of the tool.

Your app's steps come from **Import Steps** (a UiPath project with desktop activities) or are written by hand; the
README's [Desktop runs](../../README.md#desktop-runs) section describes them.

## 8. Upgrade and uninstall

### Upgrade

Download, check and unpack the new version as in section 2, into a new folder (`$version` set to the new version).
Then, from the new package folder, run the installer again with the same `-User`, ports and `-NoBrowser` as the first
install:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\Install-Rpa.ps1 -Force
```

An upgrade replaces the programs and keeps the user, the policy, both tokens and both certificates, so the n8n
credentials stay as they are. It also keeps the firewall addresses and automatic sign-in of the earlier install when
you give none. While the bot user is signed in the runner is running, and the installer refuses without `-Force`
(`The runner is running; a run in progress will fail. Use -Force to continue.`): run the upgrade when no run is in
progress. The installer prints `Upgrading RPA:`, stops both programs, and starts them again in the bot user's session
at the end.

### Uninstall

From the administrator PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File 'C:\Program Files\RPA Runner\Uninstall-Rpa.ps1'
```

It ends both programs and removes the scheduled tasks, the firewall rules and `C:\Program Files\RPA Runner`, and puts
back every setting `-AutoSignIn` changed. It keeps the data directory `C:\ProgramData\RPA Runner` (the policy, the
tokens, the certificates, the logs) and the Windows user, and says so at the end. A later install for the same bot
user takes the kept data over, with the same tokens and certificates.

To remove the data directory too, add `-RemoveData`. It is refused while the bot user is signed in. So:

1. Run `Uninstall-Rpa.ps1` without `-RemoveData` as above. With `-AutoSignIn`, this turns automatic sign-in off.
2. Sign the bot user out: `quser` lists the sessions; `logoff <ID>` signs out the bot user's one.
3. Run `Uninstall-Rpa.ps1 -RemoveData` from the unpacked package (the copy under Program Files is gone by now):

   ```powershell
   Set-Location (Join-Path $package 'rpa-windows-x64')
   powershell -ExecutionPolicy Bypass -File .\Uninstall-Rpa.ps1 -RemoveData
   ```

It ends with `RPA is removed.` and a `Removed:` line for `C:\ProgramData\RPA Runner` and for the browser's temporary
folder in the bot user's profile. The uninstaller never removes a Windows user; remove one the installer created with
`Remove-LocalUser rpa-runner` when you no longer need it. Then delete the package folders and the downloads.

When the uninstaller could not put a setting back, it lists it, keeps the list in
`C:\Program Files\RPA Runner\uninstall-leftovers.json`, and the next install and uninstall try that setting again.

## 9. Changing the tokens and the certificates

The installer writes a token file only when it is missing, and the runner and the browser make a new certificate only
when theirs is missing. Each program reads its token and its certificate when it starts. So a token or a certificate
is changed by deleting its file and starting the program again; running the installer again (an upgrade with the same
package) does both: it writes the missing token, then stops and starts the programs. There is no other way to change
them yet.

All of this runs in the administrator PowerShell, from the unpacked package folder of the installed version, while the
bot user is signed in. `$data` is the data directory:

```powershell
$data = 'C:\ProgramData\RPA Runner'
```

| To change | Delete | Then |
|---|---|---|
| The runner's token | `Remove-Item -LiteralPath "$data\token"` | `.\Install-Rpa.ps1 -Force` |
| The browser's token | `Remove-Item -LiteralPath "$data\browser-token"` | `.\Install-Rpa.ps1 -Force` |
| The runner's certificate | `Remove-Item -LiteralPath "$data\runner-certificate.pfx.bin"` | `.\Install-Rpa.ps1 -Force` |
| The browser's certificate | both: `Remove-Item -LiteralPath "$data\browser-cert.pem", "$data\browser-key.pem"` | `.\Install-Rpa.ps1 -Force` |

(Give `Install-Rpa.ps1` the same `-User`, ports and `-NoBrowser` as the install, as for an upgrade.) The browser
refuses to start with only one of its two certificate files, and says which one is missing. Until the installer has
run, a program whose file is gone fails at its next start and is retried every 10 seconds.

Then update n8n: run `Show-RpaConnection.ps1 -ShowTokens` (section 5) and put the new token into the **Token** field,
or the new fingerprint into the certificate fingerprint field, of the credential concerned. The old token and the old
certificate stop working as soon as the program has started again; until n8n has the new values, runs fail with
`runner_unavailable` (the runner) or `browser_unavailable` (the browser).

## 10. When something fails

Every log is in `C:\ProgramData\RPA Runner\logs`. The runner writes `runner-<yyyymmdd>.log` (its own log: start,
policy, methods and outcomes; never tokens or typed values), and its output goes to `runner.out.log` and
`runner.err.log`. The browser's output goes to `browser.out.log` and `browser.err.log`. Each program's start loop
writes `start-runner.log` or `start-browser.log` (each start and exit). A restart moves the previous output to
`*.1.log`. A run's error in n8n has the form `<code>: <message>`.

| What you see | What it means | What to do, and the log to read |
|---|---|---|
| `runner_unavailable: Could not connect to the desktop runner at wss://...:8765/rpa/v1 (...). Is it running, and is the port open?` | n8n cannot reach the runner. | Is the bot user signed in? `Show-RpaConnection.ps1` says `Runner: not listening: see ...` when it is not running: read `runner.err.log`, `runner-<yyyymmdd>.log` and `start-runner.log`. If it listens, check the network path and the firewall rule: `Get-NetFirewallRule -Name RPA-Runner-In \| Get-NetFirewallAddressFilter` shows the addresses it lets in. |
| `runner_unavailable: the desktop runner's Windows session is locked: unlock it or sign the runner user in again` (or `... is not in an interactive Windows session`) | The bot user's desktop is locked or disconnected. | Sign in again, or hand the session back to the console (section 4). Test connection shows the session state. |
| `The desktop runner at ... refused the token. Check the Token in the RPA Desktop Runner credential.` | The token in n8n is not the runner's. | Copy the `Runner token` again (section 5). |
| `The desktop runner at ... presented a certificate with fingerprint ..., which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.` | A fingerprint mismatch: the certificate is not the one n8n has. | Run `Show-RpaConnection.ps1`. If its fingerprint is the one presented, the certificate was made again (section 9): put it in the credential. If not, something else answers at that address: leave the credential as it is and find out what. `runner-<yyyymmdd>.log` says `generated a new self-signed certificate` when the runner made one. |
| `The browser server's certificate does not match the Certificate Fingerprint in the RPA Browser credential.` | The same, for the browser. | As above, with the `Browser fingerprint`. |
| `The browser server at ... refused the token. Check the Token in the RPA Browser credential.` | The browser's token in n8n is wrong. | Copy the `Browser token` again (section 5). |
| `busy: the desktop runner is busy with another run` | The runner runs one run at a time, and another one held it longer than this run waited (its lease plus 15 seconds). | Nothing, or run less often. `runner-<yyyymmdd>.log` shows the runs. |
| `policy_violation: ... application "ErpDemo.exe" is not in the runner's allowedApps` | The policy does not allow the app. | Apply the change (section 6) or `allow-app` (section 7). `RpaPolicy.exe show` prints the policy. |
| `runner_unavailable: the desktop runner could not start ErpDemo.exe: it is not installed at the path the runner's policy names (allowedApps[].path). ...` | The app is not at the path the policy names. | Correct the path with a change file, or install the app there. |
| The installer says `Port 3000 is in use by <process>. Choose another with -RunnerPort or -BrowserPort.` | A port in use: another program listens on that port. | Stop that program, or install with another port (and use that port in the credential and the firewall). |
| `Browser: not listening` after an install, and `browser.err.log` has `RPA browser: cannot listen on port 3000: EADDRINUSE` | A port in use, taken after the install. | As above. The runner writes an `ERROR cannot start:` line to `runner-<yyyymmdd>.log` when it cannot start, for this or another reason. |
| `Runner fingerprint: not known yet` | The runner has not started as the bot user since its log was last moved. | Sign the bot user in; read `start-runner.log`. |
| The installer says `... can be changed by <account>. Unpack the package in a folder only you or administrators can change, and run it from there.` | The package folder, or a folder above it, can be changed by someone other than administrators. | Unpack into a folder made from an administrator PowerShell under `C:\Program Files` (section 2). |
| The installer says `Run Install-Rpa.ps1 from Windows PowerShell (powershell.exe), not PowerShell 7 (pwsh).` | Wrong PowerShell. | Open Windows PowerShell as administrator. |
| PowerShell says the script `cannot be loaded because running scripts is disabled on this system`, or that it `is not digitally signed` | The execution policy or the downloaded-file mark. | Run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` in that window, and `Unblock-File` as in section 2. |

For anything else, the README's [Error codes](../../README.md#error-codes) lists every code a run can fail with.
Report a problem on [GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues), without tokens, passwords or
host names you do not want to share; security issues as [`SECURITY.md`](../../SECURITY.md) describes.
