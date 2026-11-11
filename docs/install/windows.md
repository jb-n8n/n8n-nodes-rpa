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
  browser server, and it listens on `wss://<machine>:3000`. It opens its windows on the bot user's desktop.
- **The policy tool** (`RpaPolicy.exe`), with which an administrator decides which apps the runner may start.
- **The ERP Demo**, a small sample app, for the sample flow.

Both programs run inside the signed-in Windows session of one user, the **bot user**, and start when that user signs
in. A Windows service cannot drive a desktop, so the bot user must be signed in, with its desktop unlocked, whenever
a run should work. On Windows Server a service can sign the bot user in for each run instead (section 4,
[Running with nobody signed in](#running-with-nobody-signed-in)).

**Who trusts whom.** Treat this machine as part of your n8n: whoever can use the RPA credentials in n8n can act on
this machine as the bot user, as with the robot machine of other RPA tools. The runner's policy and the write
declarations in steps are there to keep mistakes and automatic repair away from things you did not intend; with the
browser installed (the default), they are not a barrier against the n8n that holds the tokens (section 3,
[Who can reach the ports](#who-can-reach-the-ports)).
So give the bot user only the access its work needs, and limit who can reach the two ports.

The package was tested on Windows Server 2022. CI installs it and drives the ERP Demo through it
on GitHub's `windows-latest` runner (Windows Server 2025 in November 2026). Windows 10, Windows 11 and Windows Server
2019 meet the installer's requirements but have not been tested.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Download and check](#2-download-and-check)
3. [Install](#3-install)
4. [Signing in](#4-signing-in)
5. [Administrator work once the bot user is signed in](#5-administrator-work-once-the-bot-user-is-signed-in)
6. [Connect n8n](#6-connect-n8n)
7. [Run the sample](#7-run-the-sample)
8. [Allowing your own app](#8-allowing-your-own-app)
9. [Upgrade and uninstall](#9-upgrade-and-uninstall)
10. [Changing the tokens and the certificates](#10-changing-the-tokens-and-the-certificates)
11. [When something fails](#11-when-something-fails)

## 1. Before you start

Check each of these before you download anything.

- [ ] **Windows**: 64-bit Windows 10 version 1809 (build 17763) or later, Windows 11, or Windows Server 2019 or later.
  To see the build, run `winver`, or in PowerShell `[Environment]::OSVersion.Version`; the third number is the build.
  The installer refuses an older build.
- [ ] **Disk space**: about 2.8 GB free on drive C: about 570 MB for the download, 1.1 GB for the unpacked package
  and about as much again for the install.
- [ ] **An administrator account** on the machine, for the install and for every change to the policy, and a way to
  work as that administrator once the bot user is signed in (section 5).
- [ ] **A user for the bots.** The installer creates a local standard user, `rpa-runner` by default, or uses one you
  name with `-User` (a local user, or a domain user written `DOMAIN\name`, which must exist already). The bot user must
  be a standard user: the installer refuses a member of Administrators. Decide how it will be signed in (section 4):
  automatically, or by a person.
- [ ] **The GitHub CLI** (`gh`), signed in to GitHub, to check the download (section 2). Use it on another machine
  than this one where you can, so that no GitHub sign-in stays on the bot machine.
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
  machine (administrators can) and who may use those credentials in n8n.

Until the bot user is signed in, the commands below run in **Windows PowerShell 5.1 opened with "Run as
administrator"** in your own administrator sign-in (Start, type `Windows PowerShell`, right-click it, **Run as
administrator**). Not PowerShell 7 (`pwsh`), and not "Windows PowerShell (x86)": the installer refuses both. Once the
bot user has signed in, do administrator work from an administrator's own session, not through "Run as administrator"
on the bot user's desktop; section 5 says how.

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

In a shell that runs as another account, such as SYSTEM in a run-command tool, `$env:USERPROFILE` is that account's
profile and the files land there. That is fine: the next steps work in `$download` and install from `$package`.

**Check the hash.** `Get-FileHash` computes the zip's SHA-256; the `.sha256` file holds the published one (in lower
case; PowerShell's `-eq` ignores case):

```powershell
$published = ((Get-Content .\rpa-windows-x64.zip.sha256 -TotalCount 1) -split '\s+')[0]
$computed = (Get-FileHash .\rpa-windows-x64.zip -Algorithm SHA256).Hash
if ($computed -eq $published) { 'The hash matches.' } else { 'The hash DIFFERS: do not use this file.' }
```

You should see `The hash matches.` The hash shows only that the zip is the file that was published next to it.

**Check the attestation.** The attestation shows which workflow, tag and commit of the repository built and attested
the zip. Check it with the [GitHub CLI](https://cli.github.com/) (`gh`, signed in with `gh auth login`). Do it on
another machine that has downloaded the same zip (check the hash there too, as above), so that no GitHub sign-in stays
on this one; if you check on this machine, run `gh auth logout` afterwards. In PowerShell on that machine, in the
folder with the zip:

```powershell
$version = '0.2.0'
gh attestation verify rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa `
  --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml `
  --source-ref "refs/tags/desktop-v$version"
```

It should print a line that says the verification succeeded. With these two flags `gh` refuses an attestation made
by another workflow or for another tag. It does not show that the commit was reviewed, nor that the zip is what the
source code would build elsewhere.

`HTTP 404` from this command means GitHub has no attestation for this file: do not use it. Check that `$version` is
a release's version and that the download finished (check the hash again); if both are right, the file is not one
this release published.

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

Keep the unpacked package after the install: changing a token or a certificate (section 10) and removing the data
directory (section 9) run from it.

## 3. Install

### The command

Still in the administrator PowerShell, in the package folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\Install-Rpa.ps1 -AllowFrom <n8n address> -UserPassword (Read-Host 'Password for the new user rpa-runner' -AsSecureString)
```

Replace `<n8n address>` with your n8n host's address, for example `-AllowFrom 10.0.0.5`. The first line lets this
PowerShell window, and only this window, run the installer's scripts (a policy set by Group Policy can still forbid
it); a new window needs it again, which is why later sections start scripts another way (section 5). `Read-Host` asks
for the password without showing it; type a password that meets your Windows password rules. That password is for
signing the bot user in by hand (section 4). To have Windows sign the bot user in by itself instead, read section 4
first and use `-AutoSignIn`.

In a shell that cannot answer a question, such as a run-command tool, nobody can answer `Read-Host`. There, after
reading section 4, run the second line as:

```powershell
.\Install-Rpa.ps1 -AllowFrom <n8n address> -AutoSignIn -Force
```

The installer then gives the new user a password nobody learns, stores it for automatic sign-in, and asks nothing.

The parameters:

| Parameter | What it does |
|---|---|
| `-User <name>` | The bot user. Default `rpa-runner`. A local user that does not exist is created as a standard user (a member of Users, its password never expires); `DOMAIN\name` must exist already. An existing user's password is never changed, and an existing user that is an administrator is refused. |
| `-UserPassword <SecureString>` | The password for a new local user, or, with `-AutoSignIn` or `-Unattended`, the existing user's password to store (it is tried against the account first). A new user needs `-UserPassword`, `-AutoSignIn` or `-Unattended`. |
| `-RunnerPort <n>` | The runner's port. Default 8765. |
| `-BrowserPort <n>` | The browser's port. Default 3000. |
| `-AllowFrom <address>[,<address>...]` | The installer's two firewall rules allow these addresses in (IP addresses, or ranges such as `10.0.0.0/24`), for the two programs only, on every network type (Domain, Private and Public). `0.0.0.0/0` is refused: that is what `-AllowFromAnyAddress` is for. |
| `-AllowFromAnyAddress` | The firewall rules let in any address, on Domain and Private networks only. Where the machine's network is Public (most cloud machines and machines outside a domain), a first install is refused unless you add `-IncludePublicNetwork`. |
| `-IncludePublicNetwork` | With `-AllowFromAnyAddress`: the rules apply on Public networks too. |
| `-NoFirewall` | Leaves Windows Firewall alone; you open the ports yourself. |
| `-NoBrowser` | Installs the runner only. With the browser installed, whoever holds the browser token and can reach its port acts as the bot user through the browser, and the runner's policy does not limit that ([Who can reach the ports](#who-can-reach-the-ports)). With `-NoBrowser`, leave out the RPA Browser steps of section 6. |
| `-AutoSignIn` | Windows signs the bot user in by itself at every start and keeps the desktop unlocked (section 4). |
| `-Unattended` | Windows Server only: the service RPA Supervisor signs the bot user in for each run and out again afterwards (section 4, [Running with nobody signed in](#running-with-nobody-signed-in)). Not with `-AutoSignIn`; the bot user must be a local user. An upgrade keeps it without the parameter; `-Unattended:$false` goes back to the signed-in mode. |
| `-IdleSeconds <n>` | With `-Unattended`: how long the bot user stays signed in after the last connection. Default 15, 0 to 86400; an upgrade keeps the recorded value when you give none. Refused for an install that is not unattended. |
| `-Force` | Does not ask (about `-AutoSignIn`, `-Unattended`, or another `-User` than the one of the install), and upgrades even while the runner is running (a run in progress fails). |

A first install needs exactly one of `-AllowFrom`, `-AllowFromAnyAddress` and `-NoFirewall`.

**Through a tunnel or a port forward** (an SSH forward, AWS Systems Manager port forwarding, a bastion): the
connection arrives on the machine from the machine itself, which Windows Firewall lets in without a rule, so install
with `-NoFirewall` and keep both ports closed in your network. In the credentials, use the tunnel's own end with the
same path: with local port 38765 forwarded to the machine's 8765 and n8n in Docker (Docker Desktop) on the same
computer, the Runner URL is `wss://host.docker.internal:38765/rpa/v1`, and likewise for the browser's port. The
fingerprint check does not depend on the host name, so it holds through a tunnel. A forward that closes when idle
(Systems Manager's does after 20 minutes) makes later runs fail `runner_unavailable` or `browser_unavailable`: for
scheduled runs use an address that stays.

### Who can reach the ports

The runner and the browser accept anyone who can reach their port and has their token:

- With the runner's token, a caller drives the apps the runner's policy allows.
- With the browser's token, a caller acts as the bot user through the browser, a Chromium that runs as that user. It
  opens any address this machine can reach, reads any file the bot user can read (the runner's token included), and
  can create files with a name and content of its choice where the bot user can write, which is a way to run
  programs as the bot user. The browser host filters no addresses, and the runner's policy does not limit any of
  this: with the browser installed, the policy is a limit for the runner's token only.

On a machine where the runner's policy must hold against n8n itself, install with `-NoBrowser` and run the browser on
another machine (README, [Where the browser runs](../../README.md#where-the-browser-runs)). What was seen on a test
machine is in [`desktop/README.md`](../../desktop/README.md#running-the-runner), the third limit under "This is
weaker than the browser's network policy".

Either way, limit who can reach the ports:

- **`-AllowFrom <the n8n host's address>`** (recommended): from the network, only that address can connect. Programs
  on this machine itself can always reach the ports, and an address that several machines share through NAT lets in
  everything behind it. If n8n runs as several machines (queue mode workers), list each address, or the range they
  are in.
- `-AllowFromAnyAddress`: any machine that can route to this one can connect, and only the tokens keep it out.
- `-NoFirewall`: the installer adds no rule. What Windows Firewall or your network does decides who can connect.

The installer adds its two allow rules and changes nothing else in Windows Firewall: it removes no other rule, and it
does not turn the firewall on where it is off.

Both tokens are files in `C:\ProgramData\RPA Runner` (`token` and `browser-token`). The bot user can read them, and so
can every program the bot user runs, SYSTEM and administrators. The files' access rules give nobody else access.

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

The steps listed depend on the parameters (`create user` only for a new user). With `-AutoSignIn`, three more follow
`write install.json` (`store sign-in password`, `turn on automatic sign-in`, `keep the desktop unlocked`), and the last
lines are different: `Automatic sign-in is on. Restart this machine now (Restart-Computer): Windows then signs
rpa-runner in and starts the runner and the browser. About a minute after its desktop shows, run
Show-RpaConnection.ps1:` and the command line, without `If rpa-runner is already signed in ...`: the sign-in happens
when you restart the machine (section 4). The installer prints no secret. Exit
codes: 0 installed, 1 refused or failed, 3 declined at a question. When it refuses, it says why and
`Nothing was changed.`; fix the cause and run the same command again.

With `-Unattended` (section 4, [Running with nobody signed in](#running-with-nobody-signed-in)), here for a new user
on a machine where Remote Desktop is on already, the installer first shows what `-Unattended` changes and asks
(without `-Force`):

```text
Checking the package's files...
-Unattended changes how this machine works:
  - The service RPA Supervisor (RpaSupervisor.exe, running as SYSTEM, started with Windows) listens on port 8765 and 3000.
    When n8n connects, it signs rpa-runner in through a Remote Desktop connection from this machine to itself,
    and signs it out again 15 s after the last connection. The runner and the browser listen on 127.0.0.1 only,
    at port 18765 and 13000.
  - rpa-runner is added to the group Remote Desktop Users, unless it is a member already.
  - The password of rpa-runner is stored on this machine for the RPA Supervisor. An administrator of this machine
    can read it.
  - The firewall rules for port 8765 and 3000 let connections in to the RPA Supervisor instead of the runner and the
    browser.
  - While someone is signed in as rpa-runner, at the console or over Remote Desktop, runs are refused.
  Uninstall-Rpa.ps1 puts these settings back to what they were.
Type YES to continue: YES
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
  allow the bot user to sign in through Remote Desktop
  store the bot user's password for the supervisor
  register the supervisor service
    waiting for the first sign-in of rpa-runner through the RPA Supervisor (up to 120 s)
    rpa-runner was signed in, and the runner answered after 34 s
  point the firewall rules at the supervisor

RPA is installed.
  Programs:  C:\Program Files\RPA Runner
  Data:      C:\ProgramData\RPA Runner (policy.json, the tokens, the certificates, logs)
  Policy:    C:\ProgramData\RPA Runner\policy.json
             It is new and allows no app. Change it with C:\Program Files\RPA Runner\runner\RpaPolicy.exe
  Tasks:     \RPA\RPA Runner and \RPA\RPA Browser start when rpa-runner signs in
  Service:   RPA Supervisor signs rpa-runner in when n8n connects, and out 15 s after the last connection;
             its log is C:\ProgramData\RPA Runner\supervisor\supervisor.log
  Firewall:  inbound TCP 8765 and 3000 are open to 10.0.0.5 (rules RPA-Runner-In and RPA-Browser-In)
             for the RPA Supervisor
             on Domain, Private and Public networks
  Remove:    C:\Program Files\RPA Runner\Uninstall-Rpa.ps1

Nobody needs to be signed in: the RPA Supervisor signs rpa-runner in for each run. Run Show-RpaConnection.ps1, as an
administrator, for what the n8n credentials need and for how the supervisor is doing:
  C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1"
While someone is signed in as rpa-runner, runs are refused: sign rpa-runner out after looking at something.
```

Where Remote Desktop is off, the list has one more item, and the step `turn on Remote Desktop` comes after
`allow the bot user to sign in through Remote Desktop`. The seconds after `answered after` depend on the machine; when
the runner does not answer, a warning with the supervisor's last failure takes the place of that line.

### What the installer changes on the machine

- **Programs** in `C:\Program Files\RPA Runner` (only administrators can change them): `runner\` (the runner and the
  policy tool), `browser\` (Node.js, the browser host and Chromium), `scripts\`, `erp-demo\v1` and `erp-demo\v2`,
  the uninstaller, and `install.json`, which records the parameters of the install.
- **Data** in `C:\ProgramData\RPA Runner`, owned by Administrators: `policy.json` (allows no app yet), `token` and
  `browser-token` (48 random characters each), `logs\` and `policy-backups\` (where the policy tool keeps the
  earlier policy when it changes it), and later the certificates the runner and the browser make when they first
  start (`runner-certificate.pfx.bin`, `browser-cert.pem`, `browser-key.pem`) and the export folders of runs. The bot
  user can read the policy and the tokens and cannot change them; it can create files there (the certificates,
  exports) and change what is in `logs\`.
- **The bot user**, when it did not exist: a local standard user.
- **Two scheduled tasks** in the folder `\RPA\`: `RPA Runner` and `RPA Browser`. Each starts at the bot user's sign-in,
  in that user's session, without administrator rights, and starts its program again within 10 seconds whenever it
  exits.
- **Two Windows Firewall rules**, `RPA-Runner-In` and `RPA-Browser-In` (not with `-NoFirewall`).
- **With `-AutoSignIn`** only: the settings listed in section 4.
- **With `-Unattended`** only: the service RPA Supervisor and what section 4 lists under
  [Running with nobody signed in](#running-with-nobody-signed-in).

The browser also keeps a temporary folder in the bot user's profile (`AppData\Local\RPA Runner\browser-temp`), which
can hold what was typed into pages. The browser host empties it when it starts, when it stops, and when the browser
ends by itself. A host that is ended without a chance to stop (on Windows a program is usually ended that way) leaves
what is in the folder until its next start.

## 4. Signing in

The runner and the browser start when the bot user signs in, and the runner can drive apps only while that user's
desktop is unlocked and shown: on a locked or disconnected desktop runs fail with `runner_unavailable` (section 11).
n8n's credential test does not tell you the state: it succeeds whenever the runner answers, also on a locked desktop,
and the modal shows n8n's own `Connection tested successfully`. A run tells you: on a locked or disconnected desktop
it fails with `runner_unavailable` and says which.

There are two ways to keep the bot user signed in. On Windows Server there is a third: a service signs the bot user
in for each run, and out again afterwards ([Running with nobody signed in](#running-with-nobody-signed-in)).

### Automatic sign-in (`-AutoSignIn`)

Add `-AutoSignIn` to the install command. For a new user you may leave out `-UserPassword`: the installer then
generates a random password that nobody knows and stores it for Windows. For an existing user, give its password with
`-UserPassword`. Before it changes anything, the installer lists what `-AutoSignIn` does and asks you to type `YES`
(not with `-Force`).

What it stores and changes:

- **The password** of the bot user is stored on this machine where Windows keeps a password for automatic sign-in
  (the LSA secret `DefaultPassword`, not the registry). An administrator of this machine can read it, and so can
  anyone who can read this machine's disk, a backup or a snapshot of it; for a domain user the password works
  wherever that account can sign in.
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

What you will see on the bot user's desktop: at sign-in, a PowerShell window for some seconds (the two programs
starting), then an ordinary desktop with nothing of RPA on it; `Show-RpaConnection.ps1` tells you both programs
listen. During a run, the app or the browser opens by itself, works and closes. Whoever can see this screen sees what
the apps show, one-time codes of an authenticator app included.

### Signing in by hand

Install with `-UserPassword` and without `-AutoSignIn`, then sign in as the bot user, with that password, at the
machine's console, and leave the session open with the desktop unlocked. Lock screen and screen saver settings stay
as they are, so set them for the bot user so that its desktop does not lock while it should work.

To sign in as the bot user through Remote Desktop, it must be allowed to (Windows allows administrators and the
members of the Remote Desktop Users group). Add it from the administrator PowerShell, before the bot user signs in:

```powershell
Add-LocalGroupMember -SID 'S-1-5-32-555' -Member rpa-runner
```

Connect without clipboard and drive redirection (in Remote Desktop Connection: **Show Options → Local Resources**,
clear **Clipboard**, and under **More...** clear **Drives**): anything running as the bot user can read them while you
are connected. When you no longer sign the bot user in this way, take it out of the group again, from the
administrator shell (section 5): `Remove-LocalGroupMember -SID 'S-1-5-32-555' -Member rpa-runner`. If it has to stay
in the group, give it a long random password.

**Disconnecting a Remote Desktop session locks that desktop**, and runs then fail. Before you close the Remote Desktop
window, hand the session back to the machine's console: in the bot user's Remote Desktop session, open a Command
Prompt (not as administrator) and run

```text
query session
tscon <ID> /dest:console
```

with the ID that `query session` shows on the line marked `>` (your session). Your Remote Desktop window closes, and
the bot user's desktop stays unlocked on the console.

If Windows answers that access is denied, do not open an elevated prompt in the bot user's session: there Windows
would ask for an administrator's name and password on the bot user's desktop (section 5 says why to avoid that).
Close the Remote Desktop window instead, which leaves the bot user's session disconnected, and hand it back from an
administrator's own session (section 5), in a Command Prompt or PowerShell run as administrator there:

```text
query session
tscon <ID> /dest:console /password:*
```

with the ID on the bot user's line. `/password:*` asks for the bot user's password. See Microsoft's [tscon
reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon).

On Windows 10 and 11, one person uses the desktop at a time: when someone else signs in or switches user, the bot
user's session is disconnected and runs fail until it is back. For Windows Server, Microsoft's troubleshooting article
on Remote Desktop says, under remote connections for administration, that "Remote Desktop supports two concurrent
remote connections to the computer", for which no Remote Desktop Services client access licences (RDS CALs) are
needed, and that more than two administrative connections, or multiple user connections, need the RD Session Host
role and RDS CALs. Whether a bot user's session counts as administration is not stated there;
[the licensing note](licensing.md#remote-desktop-to-windows-server) quotes the sources and lists what to confirm with
your licensing contact.

### Running with nobody signed in

On Windows Server 2019 or later, add `-Unattended` to the install command, and the bot user does not have to stay
signed in. A Windows service, the **RPA Supervisor** (`RpaSupervisor.exe`, running as SYSTEM), then listens on the
runner's and the browser's port in their place. When n8n connects, the supervisor signs the bot user in through a
Remote Desktop connection from this machine to itself, waits until the runner (or the browser) listens in that
session, and then passes the connection through as it is: TLS, the token and the protocol stay between n8n and the
runner, and the n8n credentials stay the same. When no connection has been open for `-IdleSeconds` (default 15), it
signs the bot user out again. Between runs nobody is signed in.

The installer refuses `-Unattended` on Windows 10 and 11, where it was not tested, and together with `-AutoSignIn`.
The bot user must be a local user of this machine: a domain user (`DOMAIN\name`) is refused.

**The command.** For a new bot user (the installer gives it a random password and stores it for the supervisor only):

```powershell
.\Install-Rpa.ps1 -AllowFrom <n8n address> -Unattended
```

For an existing local user, add `-UserPassword (Read-Host 'Password of rpa-runner' -AsSecureString)`; the installer
tries the password against the account first. Before it changes anything, the installer lists what `-Unattended` does
and asks you to type `YES` (not with `-Force`). To store a new password later, run the same command again with
`-UserPassword`; the installer then starts the supervisor again, which it needs to use the new password.
When an administrator sets a new password for the bot user (Windows does not let the bot user change its own), the
runner can no longer read its certificate, which Windows protects with the user's old password, and every run fails:
`supervisor.log` and `Show-RpaConnection.ps1` then say that nothing listened on `127.0.0.1:18765` and that the runner
did not start in the bot user's session, and `logs\runner.out.log` says `cannot read the runner certificate`. Remove
`runner-certificate.pfx.bin` as in section 10, and put the runner's new fingerprint into the n8n credential.

**What it changes**, besides what section 3 lists:

- **Remote Desktop Users**: the bot user is added, unless it is a member already. Windows lets this group sign in
  through Remote Desktop.
- **Remote Desktop**: turned on when it is off, with the registry value `fDenyTSConnections` alone. The installer
  turns on no firewall rule for Remote Desktop, because the supervisor connects from this machine to itself (turning
  Remote Desktop on in Settings would also turn those rules on). Where Remote Desktop is on already, its rules stay
  as they are. Once it is on, Remote Desktop can be reached from the network wherever a firewall rule that is on
  already, or a firewall that is off, lets connections to port 3389 in: check that before you install.
- **The bot user's password** is stored in the LSA secret `L$RpaRunnerBotPassword`. SYSTEM and administrators can
  read it, and so can anyone who can read this machine's disk, a backup or a snapshot of it. The installer does not
  put it on a command line, in a log or in a file.
- **The service RPA Supervisor**, started with Windows after the Remote Desktop service, and started again a minute
  after it fails. Its log and state are in `C:\ProgramData\RPA Runner\supervisor\`, a folder that only SYSTEM and
  administrators can open. When it does not start, the reason is in the Application event log, source `RPA
  Supervisor`, or in its log.
- **The two firewall rules** let connections in to the supervisor instead of the runner and the browser. Who may
  connect stays what you chose with `-AllowFrom`.
- **The runner and the browser** listen on `127.0.0.1` only, at their port + 10000 (18765 and 13000 by default),
  where the supervisor passes the connections on. The scheduled tasks stay as they are: they start both programs when
  the supervisor signs the bot user in.

After the service starts, the installer signs the bot user in once and waits until the runner answers. It waits at
most 120 s, but the supervisor gives up on a connection after 90 s, so a runner that does not start is reported after
about 90 s. Windows makes a user's profile at its first sign-in, which took 29 to 48 s on a test machine, and n8n's first
run would wait for it otherwise. It prints how long that took. When the runner does not answer in time, it prints a
warning with the supervisor's last failure, and the install is complete all the same.

`Uninstall-Rpa.ps1` stops and removes the service, removes the stored password, takes the bot user out of Remote
Desktop Users when the installer put it there, and turns Remote Desktop off again when the installer turned it on
(it says so at its end: an administrator who has started to use Remote Desktop since loses it).
An install with `-Unattended:$false` over one with `-Unattended` does the same: that is the way back to the
signed-in mode. An upgrade without the parameter keeps unattended mode (section 9).

**What the machine needs.**

| What | Needed? | Why |
|---|---|---|
| Remote Desktop turned on (the Remote Desktop service running and listening on port 3389) | Yes. The installer turns it on when it is off. | The supervisor signs the bot user in through it. |
| Remote Desktop on its standard port, 3389 (`PortNumber` of `HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp`) | Yes. The installer refuses `-Unattended` when it is another port. | The supervisor connects to port 3389. |
| Network Level Authentication for Remote Desktop | Leave it on, as Windows sets it. | The sign-in works with it; a test with it turned off was refused. |
| The bot user in Remote Desktop Users (or holding the right to sign in through Remote Desktop in another way) | Yes. The installer adds it. | Without it Windows refuses the sign-in. |
| Inbound firewall rules for Remote Desktop | No. | The connection stays on this machine; the sign-in worked with all of them turned off. |
| One session per user (Windows' default) | Keep the default. | The supervisor expects one session of the bot user. |
| A password that does not expire and need not change at the next sign-in | Yes. | An expired password, or one that must change, stops the sign-ins (see the failures below). A user the installer creates gets a password that never expires, so this concerns an existing user given with `-UserPassword`. |
| An account lockout policy | Not needed. | The supervisor tries a wrong password once and then stops trying. |
| Group Policy time limits for Remote Desktop sessions (idle, disconnected, active) | None that end a session during a run. | A limit that ends the session ends the run. |

Windows Server without the Remote Desktop Session Host role allows two remote sessions at a time; the bot user's
session is one of them, so one administrator can still connect through Remote Desktop during a run. Whether the bot
user's session needs Remote Desktop Services client access licences is a question for your Microsoft licence terms:
see [the licensing note](licensing.md#remote-desktop-to-windows-server).

**How a run looks.** n8n connects as before. A connection after a quiet time waits while the bot user is signed in:
about 5 to 10 s, and about 20 s for the first connection after the machine starts; the RPA node waits up to 60 s for
the runner's answer, while the supervisor keeps trying a sign-in for up to 90 s. A sign-in that takes longer than
60 s therefore fails that run in n8n, but the session is still made, and the next run finds it. Then the run goes on
as in the signed-in mode, on a desktop that nobody sees. While the session
is there, `quser rpa-runner` lists it; 15 s after the last connection it is gone. Check the supervisor from an
administrator PowerShell (the bot user cannot read the supervisor's folder):

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1"
```

Besides the lines of section 4 it shows:

```text
Mode: unattended. The RPA Supervisor signs rpa-runner in when n8n connects, and out 15 s after the last connection.
Supervisor: running
Sessions of rpa-runner: none
Supervisor's last failure: none recorded
Supervisor log: C:\ProgramData\RPA Runner\supervisor\supervisor.log
```

**Someone signed in as the bot user.** The supervisor does not sign out or take over a session of the bot user that it
did not make. While someone is signed in as the bot user, at the console or through Remote Desktop, every run is
refused within a few seconds, and the person's session is left alone. To watch or record what a run does, sign in as
an administrator, not as the bot user, and sign the bot user out when you are done.

**The log.** `C:\ProgramData\RPA Runner\supervisor\supervisor.log` (the previous one in `supervisor.1.log`) has a line
for each sign-in, sign-out and failure with its reason. It does not write a password, a token or what a connection
carries.
`supervisor-state.json` beside it holds the session the supervisor made and its last failure.

**When something fails.** n8n is not told why the supervisor could not sign the bot user in: the connection closes,
and the run fails with `runner_unavailable` (or the browser's connection error). The reason is on the machine, in
`Show-RpaConnection.ps1` and in `supervisor.log`.

| What you see | Why | What to do |
|---|---|---|
| Last failure `UserSignedIn: ...` | Someone is signed in as the bot user. | Sign that session out. Runs work again with the next connection. |
| Last failure `WrongPassword: ...` or `PasswordExpired: ...`, and `Supervisor: sign-ins are blocked until the service is restarted` | The stored password is wrong, has expired, or must be changed. The supervisor tried it once and tries no further sign-in, so that an account lockout policy is not tripped. The service still shows as running. | Give the bot user a password that does not expire, and store it with `.\Install-Rpa.ps1 -Unattended -UserPassword (...)` and the parameters of the install, which also starts the service again; then remove the runner's certificate and put its new fingerprint into the n8n credential (see the next row). Or fix the cause and run `Restart-Service 'RPA Supervisor'`. |
| Last failure `Nothing listened on 127.0.0.1:18765 within 90 s: the runner did not start in rpa-runner's session; ...` | The bot user was signed in, but the runner did not start in its session. After an administrator set a new password for the bot user, the runner cannot read its certificate (`logs\runner.out.log`: `cannot read the runner certificate`). | Read `logs\runner.out.log`. For the certificate: remove `runner-certificate.pfx.bin` (section 10) and put the new fingerprint into the n8n credential. |
| Last failure names the Remote Desktop service: `... (TermService) is not running`, `Nothing listens on the Remote Desktop port 3389: ...` or `Another program (process ...) listens on the Remote Desktop port 3389` | The supervisor signs in only while the Remote Desktop service runs and is the only program listening on port 3389. | Start the Remote Desktop service, turn Remote Desktop on, or end the other program. Right after the machine starts, the service may still be starting: the supervisor keeps trying while the connection waits, and the run starts when it can. |
| Last failure `NoPassword: ...`, `NotAllowed: ...` or `Refused: ...` | No password is stored for the supervisor or it cannot be read (`NoPassword`); Windows does not let the bot user sign in through Remote Desktop, for example because it is not in Remote Desktop Users (`NotAllowed`); or the Remote Desktop client refused the connection for another reason, with its numbers in the text (`Refused`). | Read `supervisor.log` for the whole text. Run the installer again with `-Unattended` (and `-UserPassword` where the password is missing), or fix what the text names. |
| The first run after a restart takes about 20 s before it starts | The first sign-in after a restart is slow. | Nothing. |
| A run ends with its connection closed, or with `desktop_unavailable`, in the middle | The supervisor or its Remote Desktop connection ended during the run. Windows starts the supervisor again a minute after it fails. The next connection signs the session that was left out first and makes a new one. | Run it again, and read `supervisor.log` for why it ended. |
| The bot user is signed in while no run is going on | Anything that connects to the runner's or the browser's port makes the supervisor sign the bot user in: a health check or a port scanner too. | Point health checks elsewhere (for example at the service's state), and limit who can reach the ports (`-AllowFrom`). |
| `Supervisor: the service RPA Supervisor is stopped` | It was stopped, or it did not start. It depends on the Remote Desktop service: stopping that service (`Stop-Service TermService -Force`) stops the supervisor too, and it stays stopped until it is started, also after the Remote Desktop service starts again. (`Restart-Service TermService -Force` starts the supervisor again by itself.) | `Start-Service 'RPA Supervisor'`. When it stops again, the reason is in `supervisor.log`, or in the Application event log, source `RPA Supervisor`, when its folder is missing or not its own. |

Behind the supervisor, the runner's own log names every caller as `127.0.0.1`: every connection reaches the runner
through the supervisor. The supervisor's log has the address of each connection (`Connection from <address> to port
<port>.`, at most one line per address and port every 30 s).

### After the first sign-in

Within a minute of the bot user's sign-in both programs listen, and each has made its certificate. Check it as the bot
user, in a Windows PowerShell on its desktop that is **not** run as administrator (the script needs no administrator
rights for this):

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1"
```

or run the same line in the administrator shell of section 5 (with `-Unattended`, run it there: the bot user cannot read
the supervisor's folder). You should see:

```text
Runner URL: wss://10.0.0.20:8765/rpa/v1
Runner fingerprint: 2E:4B:91:7B:...:7B:66:88:4C
Browser URL: wss://10.0.0.20:3000
Browser fingerprint: 69:46:74:56:...:A3:15:2D:C3
```

(one URL line per IPv4 address of the machine). `fingerprint: not known yet (the program has not started)` means that
program has not started yet as the bot user; for the runner it can also mean that its latest start failed, as the
script reads the runner's fingerprint from the start line in its current `logs\runner.out.log`. `Runner: not
listening yet. It starts within a minute of the bot user's sign-in: run this again. If it stays like this, read <log>`
(and the same for `Browser`) names the log to read, `logs\runner.out.log` or `logs\browser.err.log` (section 11).

## 5. Administrator work once the bot user is signed in

Once the bot user is signed in, its desktop is where the bots work. Avoid "Run as administrator" there: the bot user
is a standard user, so Windows asks for an administrator's name and password, and you would type them in a session
where the bot's programs run, and where something they started could show a look-alike prompt. Do administrator work
from an administrator's own session instead. Which way depends on the machine:

- **A remote management shell**, which opens no desktop session: PowerShell remoting (`Enter-PSSession` from another
  machine, signed in as an administrator of this one), or the run-command feature of the cloud or management tool you
  use. It leaves the bot user's session alone.
- **On Windows Server**: a second Remote Desktop session, signed in as the administrator, with Windows PowerShell run
  as administrator in that session. The bot user stays signed in on the console. (On licences, see section 4,
  Signing in by hand.)
- **On Windows 10 or 11**, where one person signs in at a time: signing in as the administrator disconnects the bot
  user's session, and bots cannot run meanwhile. Do the work, then give the desktop back to the bot user: restart the
  machine (with `-AutoSignIn`, Windows signs the bot user in again), or hand its session back to the console with
  `tscon <ID> /dest:console /password:*` as in section 4, Signing in by hand.

The rest of this guide calls a Windows PowerShell 5.1 opened in one of these ways, as an administrator, **the
administrator shell**. It is a new window each time, so the guide starts each script as
`powershell.exe -ExecutionPolicy Bypass -File "<path>" <parameters>`, which runs it in any window unless Group Policy
sets an execution policy, and sets again in the same block every variable that it takes from an earlier section.

**The policy tool asks in a console.** `RpaPolicy.exe` prints what a change does and asks `Apply these changes? [y/N]`.
It honours `--yes` (apply without asking) only when it shares its console with at least one other program and every
program attached to that console runs as administrator; otherwise it prints
`--yes is ignored: start RpaPolicy from an administrator console to use it` and asks anyway. It reads the answer from
its input: a line `y` or `yes` applies the change; any other line, or an input that gives no line, writes nothing and
ends with exit code 3. Whether a remote management shell lets you answer depends on how that shell starts programs.
If you cannot answer there, the tool has written nothing. Read the summary it printed, then run the same command
again with `--yes` at the end. If it then prints
`--yes is ignored: start RpaPolicy from an administrator console to use it`, that shell cannot apply a change: run
the tool in an administrator's own desktop session (the second or third way above).

## 6. Connect n8n

### What to copy

In the administrator shell (section 5), run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\scripts\Show-RpaConnection.ps1" -ShowTokens
```

It prints the lines of section 4 and a token line for each program, `Runner token: ...` and `Browser token: ...`.
`-ShowTokens` works only as an administrator (otherwise the script says `-ShowTokens needs an administrator
PowerShell.`), and the tokens are printed only with it.

Paste each token straight into its n8n credential field below and nowhere else. The script writes the two token
lines through the PowerShell host's own writer, not through a cmdlet or the pipeline, so that no cmdlet's parameters
carry a token (PowerShell's module logging records those). A transcript records what the window shows, though: where
PowerShell transcription is turned on (by Group Policy, for example), the transcript can hold the tokens. A
run-command tool keeps the output of a command, so whoever can read its history can read both tokens. If such a tool
is your only shell for now, run `-ShowTokens` there, copy the tokens into n8n, and change both tokens (section 10)
once you have a shell that keeps no output. If a run-command tool is the only shell you will ever have, you cannot
avoid its history holding the tokens: limit who can read that history (in AWS, the permissions to read command
invocations), and treat those people as holders of both tokens. A token that went anywhere else is changed as in
section 10. When you have copied the values, close the window or run `Clear-Host`, so that the tokens do not stay on
the screen.

The fingerprints are read from files the bot user can write (the runner's start line in `logs\runner.out.log`, the
browser's `browser-cert.pem`). So copy them while you trust what has run as the bot user, best right after the
install. A fingerprint stays the same across restarts and upgrades as long as its certificate files are kept
(section 10).

Use an address from the URL lines that n8n reaches this machine by. If n8n reaches it through another address or a
host name (a NAT, a DNS name), use that one with the same port and path. Through a tunnel or a port forward, see
section 3, "Through a tunnel or a port forward".

### The RPA Desktop Runner credential

In n8n: in the left sidebar, **+ → New credential → RPA Desktop Runner**.

| Field | Value |
|---|---|
| **Runner URL** | The `Runner URL` line, for example `wss://10.0.0.20:8765/rpa/v1` (`wss://10.0.0.20:8765` works too). |
| **Token** | The `Runner token` line, without the label. |
| **Certificate Fingerprint** | The `Runner fingerprint` line, without the label (64 hexadecimal digits with colons). |

Save. n8n tests the credential and the modal says `Connection tested successfully` (n8n's own text) when the runner
answered with this token and certificate; n8n checks the runner's certificate against the fingerprint before it sends
the token. The test succeeds on a locked desktop too: the node's own result, `Connected to the desktop runner (session
interactive)` (or `session locked`, `session not interactive`), shows only when the credential is tested through n8n's
API. On Windows 10 or 11, give the desktop back to the bot user before a run (section 5).

If the modal says `Couldn't connect with these settings`, n8n does not show the reason. To see it, use the credential
in a run: for the runner, the sample of section 7. The run's error says which it is: not reachable, token refused, or
another certificate.

### The RPA Browser credential

In n8n: in the left sidebar, **+ → New credential → RPA Browser**.

| Field | Value |
|---|---|
| **Mode** | Browser Server |
| **Endpoint URL** | The `Browser URL` line, for example `wss://10.0.0.20:3000` |
| **Token** | The `Browser token` line, without the label |
| **Certificate Fingerprint (SHA-256)** | The `Browser fingerprint` line, without the label |
| **Private Network Endpoint** | Off (it is for plain `ws://` addresses; this one is `wss://`) |

Type the three values directly, not as expressions. Save. n8n tests the credential and the modal says `Connection
tested successfully` (n8n's own text; the node's own result, `Connected to the browser server (1.63)`, shows when the
credential is tested through n8n's API).

If the modal says `Couldn't connect with these settings`, n8n does not show the reason. To see it, use the credential
in a run: for the browser, a Screenshot of any page (or the template **RPA: 0 Connection check**). The run's error
says which it is: not reachable, token refused, or another certificate.

The browser on this machine serves one session at a time (the installer does not change that). A second browser run
that starts while one is open waits up to 60 s for it, then fails `browser_unavailable` with `The browser service at
wss://...:3000/ had no free browser session for 60 s. Add browser capacity (more replicas or sessions per replica) or
start fewer RPA runs at once.` The capacity advice is for the browser service at scale; here, start fewer browser runs
at once.

There is no Headless setting to make: that field belongs to the Local Browser mode. The browser on this machine
opens with a window on the bot user's desktop for every run from n8n. One limit follows from that: a **Save as PDF**
step needs a headless browser and fails on this one (section 11).

## 7. Run the sample

The sample runs the ERP Demo in the bot user's session: it signs in, searches the line items of company code 1000,
reads the result count, and exports the line items as a CSV, which comes back to n8n as a file. Three files belong to
it, in [`docs/install/samples/`](samples/):

- [`erp-demo-policy-change.json`](samples/erp-demo-policy-change.json): allows the ERP Demo (v1) at its installed
  path, its Post button as a write control, and Ctrl+S and F11 as gated keys. Nothing else.
- [`erp-demo.workflow.json`](samples/erp-demo.workflow.json): the n8n workflow.
- [`erp-demo-steps.json`](samples/erp-demo-steps.json): the desktop steps, the same ones the workflow holds.

### Allow the ERP Demo

A new policy allows no app, so the runner refuses to start the ERP Demo until you allow it. In the administrator
shell (section 5), write the change file into the package folder (the policy tool takes a change file only from a
local drive, through no link) and apply it. The first line is the package folder of section 2; change the version if
yours is another:

```powershell
$package = 'C:\Program Files\RPA package\0.2.0'
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

The text between `@'` and `'@` is the content of `erp-demo-policy-change.json`. The tool prints what the change does
and asks:

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

Read the lines, type `y` and Enter (if the shell does not let you answer, see the end of section 5). It answers
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
4. Make sure the bot user is signed in with its desktop unlocked (section 4; on Windows 10 or 11, after administrator
   work, section 5), then click **Execute workflow**.

The node runs **Run Steps** with these settings, which you can see in the node:

- **Steps (JSON)**: the 17 steps of `erp-demo-steps.json`.
- **Require Signed Steps**: off, so that the sample runs as it is. With it off, whoever can edit the workflow decides
  what the bot does in the allowed apps. For your own steps keep it on, and sign the steps with **Sign Steps**
  (README, Run Steps reference). The sample has no write step: it reads and exports only.
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

If the run fails, the item has an `error` such as `runner_unavailable: ...` or `policy_violation: ...`; section 11
says what each means.

### Try the browser

Create a new workflow with one RPA node. Choose **Take a screenshot of a page** (operation **Screenshot**), set
**URL** to `https://example.com`, leave **Capture** at Full Page, and pick your **RPA Browser** credential (section 6).
While it runs, a browser window opens on the bot user's desktop. The output item has `url` `https://example.com/`,
`title` `Example Domain` and `status` `200`, and the **Binary** tab has the page as a PNG in `screenshot`
(`screenshot.png`).

## 8. Allowing your own app

The runner starts only the apps its policy lists, at the path the policy names. Install your app where only
administrators can change it (such as under `C:\Program Files`); the runner refuses an app at a path the bot user
could change unless the policy says otherwise. Then, in the administrator shell (section 5):

```powershell
& 'C:\Program Files\RPA Runner\runner\RpaPolicy.exe' allow-app 'C:\Program Files\Your App\YourApp.exe' --pin-hash
```

It shows the change and asks, as in section 7. `--pin-hash` also pins the file's SHA-256, so that the runner starts
only that exact file; run the command again after the app is updated. Give the path by the app's real location on a
local drive, not through a link, a mapped network drive or a `subst` drive: the tool refuses those.

Many apps install for one user (into that user's AppData). Installed from an administrator or a run-command shell,
such an app lands in that administrator's or SYSTEM's profile, where the bot user cannot start it. Use the
installer's all-users choice (for an MSI, an install folder under `C:\Program Files`), then check that the path exists
before `allow-app`. An app that can only live in the bot user's profile needs `allowUserWritable` in a change file
([`desktop/README.md`](../../desktop/README.md#changing-the-policy)), which the tool warns about.

`allow-app` adds the app only. To declare the controls that save, post or submit (`writeControls`), the keys that do
(`gatedKeys`), the helper processes of a web view app or clipboard reads, write a change file like the sample's and
apply it with `RpaPolicy.exe apply <file>`. Until an app's write controls and keys are declared, the runner gates no
write in it: steps can press its Save, Post or Delete without `"write": true` and without **Allow Unsigned Writes**.
And an app with Open or Save dialogs gives a caller the bot user's files and a way to start other programs (see "Three
limits to keep in mind" in [`desktop/README.md`](../../desktop/README.md#running-the-runner)), so allow only apps you
would let n8n use as the bot user.

**A web view app with a Copy button** (many current apps, and authenticator apps): allow the app, then apply a
change file that adds the web view runtime as a helper process and turns on clipboard reads:

```json
{
  "helperProcesses": [
    { "exe": "msedgewebview2.exe", "pathPattern": "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe" }
  ],
  "clipboardRead": true
}
```

Apply it as in section 7 (`RpaPolicy.exe apply <file>`; `--yes` only where section 5 says it is honoured).

A change only adds; to remove an entry, an administrator edits `C:\ProgramData\RPA Runner\policy.json` by hand. The
runner reads the policy only when it starts: after editing by hand, end `RpaRunner.exe` (in the administrator shell,
`Stop-Process -Name RpaRunner -Force`; it starts again within 10 seconds) or sign the bot user out and in, then check
with `RpaPolicy.exe show`. [`desktop/README.md`](../../desktop/README.md#changing-the-policy) describes every field
and every message of the tool.

Your app's steps come from **Import Steps** (a UiPath project with desktop activities) or are written by hand; the
README's [Desktop runs](../../README.md#desktop-runs) section describes them, and how a UI Automation inspector shows
the parts of a control's locator.

## 9. Upgrade and uninstall

### Upgrade

In the administrator shell (section 5), download, check and unpack the new version as in section 2, into a new folder
(`$version` set to the new version). Then run the new package's installer with the same `-User`, ports and
`-NoBrowser` as the first install (another `-User` moves the install to another bot user: see
[Another bot user](#another-bot-user) below):

```powershell
$version = '<the new version>'
$package = "C:\Program Files\RPA package\$version"
# add the -User, -RunnerPort, -BrowserPort and -NoBrowser of the first install at the end, if you gave any there
powershell.exe -ExecutionPolicy Bypass -File "$package\rpa-windows-x64\Install-Rpa.ps1" -Force
```

An upgrade replaces the programs and keeps the user, the policy, both tokens and both certificates, so the n8n
credentials stay as they are. It also keeps the firewall addresses and automatic sign-in of the earlier install when
you give none. An install made with `-Unattended` stays unattended, with its idle time and its stored password; to go
back to the signed-in mode, run the installer with `-Unattended:$false`. While the bot user is signed in the runner is
running, and the installer refuses without `-Force` (`The runner is running; a run in progress will fail. Use -Force
to continue.`): run the upgrade when no run is in progress. The installer prints `Upgrading RPA:`, stops both
programs, and starts them again in the bot user's session at the end.

### Another bot user

To move the install to another bot user, uninstall with `-RemoveData` (below), then install for the new user as in
section 3. That is a first install: a new policy (apply your policy changes again, sections 7 and 8), new tokens and
new certificates (copy both tokens and both fingerprints into the n8n credentials again, section 6), and one of
`-AllowFrom`, `-AllowFromAnyAddress` and `-NoFirewall` again.

The installer can also change the user of an existing install when it is run with another `-User`. It refuses that
while automatic sign-in is set up for the earlier user or while the data directory still holds files the earlier user
owns (its logs, certificates and export folders), and its refusal names the same way out as above. When it does change
the user, it replaces both tokens, because the earlier user could read them, and says so:

```text
Both tokens are new: the earlier bot user could read the old ones.
Update the n8n credentials with the new tokens, which Show-RpaConnection.ps1 -ShowTokens shows.
```

The earlier user stays a Windows user. Remove it with `Remove-LocalUser <earlier user>` when you no longer need it.

### Uninstall

In the administrator shell (section 5):

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\Uninstall-Rpa.ps1"
```

It ends both programs and removes the scheduled tasks, the firewall rules and `C:\Program Files\RPA Runner`, and puts
back every setting `-AutoSignIn` or `-Unattended` changed (for `-Unattended`: the service RPA Supervisor, the stored
password, the bot user's place in Remote Desktop Users, and Remote Desktop when the installer turned it on). It keeps the data directory `C:\ProgramData\RPA Runner` (the policy, the
tokens, the certificates, the logs) and the Windows user, and says so at the end. A later install for the same bot
user takes the kept data over, with the same tokens and certificates. An install for another user, or for a user of
the same name that was removed and created again, is a change of user ([Another bot user](#another-bot-user)).

To remove the data directory too, add `-RemoveData`. It is refused while the bot user is signed in. So:

1. Run `Uninstall-Rpa.ps1` without `-RemoveData` as above. With `-AutoSignIn`, this turns automatic sign-in off.
2. Sign the bot user out: `quser` lists the sessions; `logoff <ID>` signs out the bot user's one.
3. Run `Uninstall-Rpa.ps1 -RemoveData` from the unpacked package of the installed version (the copy under Program
   Files is gone by now); the first line is the package folder of section 2; change the version if yours is
   another:

   ```powershell
   $package = 'C:\Program Files\RPA package\0.2.0'
   powershell.exe -ExecutionPolicy Bypass -File "$package\rpa-windows-x64\Uninstall-Rpa.ps1" -RemoveData
   ```

It ends with `RPA is removed.` and a `Removed:` line for `C:\ProgramData\RPA Runner` and, when it is still there, for
the browser's temporary folder in the bot user's profile (step 1 already removes it when no process of the bot user
runs; a `Kept:` line with the reason when it could not remove it). The uninstaller never removes a Windows user;
remove one the installer created with `Remove-LocalUser rpa-runner` when you no longer need it. Windows keeps its
profile folder (`C:\Users\rpa-runner`); remove it in Settings (System, About, Advanced system settings, User
Profiles) or leave it. Then delete the package folders and the downloads.

When the uninstaller could not put a setting back, it lists it and keeps the list in
`C:\Program Files\RPA Runner\uninstall-leftovers.json`. The next install only records those settings, with what they
were before the earlier install; the uninstall after it tries to put them back again.

## 10. Changing the tokens and the certificates

Each program reads its token and its certificate when it starts. Tokens and certificates are changed in different
ways.

**A token** is written by the installer, and only when its file is missing: an install or an upgrade writes a missing
`token` or `browser-token` and never writes a file that is there. A program whose token file is missing fails at its
next start, and its start loop tries again every 10 seconds, until the installer has written the file. Running the
installer again for the installed version stops both programs, writes the missing token and starts them again. The
installer also replaces both tokens by itself on a change of bot user, because the earlier user could read them, and
says that the n8n credentials need the new ones ([Another bot user](#another-bot-user) in section 9).

**A certificate** is made by its own program, at a start that finds none: the runner makes a new one when
`runner-certificate.pfx.bin` is missing, and the browser makes a new pair when both `browser-key.pem` and
`browser-cert.pem` are missing. With only one of the two browser files there, the browser does not start and names the
missing file (`browser-cert.pem is missing beside browser-key.pem; restore it, or delete both to create a new
certificate (the fingerprint changes)`), so remove both files of the pair. The new certificate is made at the
program's next start, whatever causes it: running the installer is one way; a policy change with `RpaPolicy.exe`
(which ends the runner), a crash, or the bot user signing out and in are others. So once you have deleted a
certificate file, its fingerprint can change before you run the installer, and runs from n8n then fail until the
credential has the new fingerprint.

The bot user can read both tokens and both certificates' keys (its programs use them). After a suspected exposure,
change all four, and first find out what ran as the bot user: it would read the new ones too.

All of this runs in the administrator shell (section 5), while the bot user is signed in. The first line is the data
directory, the second the unpacked package of the installed version (section 2; change the version if yours is
another):

```powershell
$data = 'C:\ProgramData\RPA Runner'
$package = 'C:\Program Files\RPA package\0.2.0'
```

| To change | Delete |
|---|---|
| The runner's token | `Remove-Item -LiteralPath "$data\token"` |
| The browser's token | `Remove-Item -LiteralPath "$data\browser-token"` |
| The runner's certificate | `Remove-Item -LiteralPath "$data\runner-certificate.pfx.bin"` |
| The browser's certificate | both: `Remove-Item -LiteralPath "$data\browser-cert.pem", "$data\browser-key.pem"` |

Then run the installer, with the same `-User`, ports and `-NoBrowser` as the install, as for an upgrade:

```powershell
# add the -User, -RunnerPort, -BrowserPort and -NoBrowser of the install at the end, if you gave any there
powershell.exe -ExecutionPolicy Bypass -File "$package\rpa-windows-x64\Install-Rpa.ps1" -Force
```

Then update n8n: run `Show-RpaConnection.ps1 -ShowTokens` (section 6) and put the new token into the **Token** field,
or the new fingerprint into the certificate fingerprint field, of the credential concerned. The old token stops
working when its program has started again with the new one, and the old certificate when its program has made the
new one; until n8n has the new values, runs fail with the messages section 11 lists for a refused token or a
fingerprint mismatch.

## 11. When something fails

Every log is in `C:\ProgramData\RPA Runner\logs`. The runner writes `runner-<yyyymmdd>.log`, its own log: its start,
the policy it loaded, each connection and the address it came from, each request by the name of its method with the
outcome, the apps it starts and the actions of a run. The method name in a line is the text the caller sent. The
same lines go to its output, `runner.out.log`, and its error output goes to `runner.err.log`. The browser's output
goes to `browser.out.log` and `browser.err.log`. Each program's start loop writes `start-runner.log` or
`start-browser.log` (each start and exit). A restart moves the previous output to `*.1.log`. A run's error in n8n has
the form `<code>: <message>`.

With `-Unattended`, a connection the RPA Supervisor could not serve fails with `runner_unavailable` too; the
supervisor's log is `C:\ProgramData\RPA Runner\supervisor\supervisor.log`, and section 4,
[Running with nobody signed in](#running-with-nobody-signed-in), lists its failures.

| What you see | What it means | What to do, and the log to read |
|---|---|---|
| `runner_unavailable: Could not connect to the desktop runner at wss://...:8765/rpa/v1 (...). Is it running, and is the port open?` | n8n cannot reach the runner. | Is the bot user signed in? `Show-RpaConnection.ps1` says `Runner: not listening yet. ... read ...\logs\runner.out.log` when it is not running: read `runner.out.log` (the runner writes its failures there and to `runner-<yyyymmdd>.log`), `runner.err.log` and `start-runner.log`. If it listens, check the network path and the firewall rule: `Get-NetFirewallRule -Name RPA-Runner-In \| Get-NetFirewallAddressFilter` shows the addresses it lets in. |
| `runner_unavailable: the desktop runner's Windows session is locked: unlock it or sign the runner user in again` (or `... is not in an interactive Windows session`) | The bot user's desktop is locked or disconnected. | Sign in again, or hand the session back to the console (section 4). On Windows 10 or 11, an administrator's sign-in disconnects it (section 5). n8n's credential test succeeds on a locked session too, so it does not show this. |
| `The desktop runner at ... refused the token. Check the Token in the RPA Desktop Runner credential.` | The token in n8n is not the runner's. | Copy the `Runner token` again (section 6). |
| `The desktop runner at ... presented a certificate with fingerprint ..., which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.` | A fingerprint mismatch: the certificate is not the one n8n has. | Run `Show-RpaConnection.ps1`. If its fingerprint is the one presented, the certificate was made again (section 10): if nobody changed the certificate on purpose, find out what did before you accept the new fingerprint, then put it in the credential. If not, something else answers at that address: leave the credential as it is and find out what. `runner-<yyyymmdd>.log` says `generated a new self-signed certificate` when the runner made one. |
| `The browser server's certificate does not match the Certificate Fingerprint in the RPA Browser credential.` | The same, for the browser. | As above, with the `Browser fingerprint`. |
| `The browser server at ... refused the token. Check the Token in the RPA Browser credential.` | The browser's token in n8n is wrong. | Copy the `Browser token` again (section 6). |
| `Could not connect to the browser server at wss://...:3000/. Is it running? ...` (in a run: `browser_unavailable: ...`) | n8n could not connect to the browser: it is not listening, or it did not answer in time. | Is the bot user signed in? `Show-RpaConnection.ps1` says `Browser: not listening yet. ... read ...\logs\browser.err.log` when it is not listening: read `browser.err.log` and `start-browser.log`. If it listens, test again: the first connection after a sign-in can take longer. If it still fails, check the network path and the firewall rule `RPA-Browser-In`, as for the runner. |
| `Save as PDF needs headless Chromium` (the run fails `incomplete`) | A known limit of this install: the browser opens with a window, and Save as PDF needs a headless browser. | Run Save as PDF steps on a headless browser service, with its own RPA Browser credential (README, [Save as PDF](../../README.md#save-as-pdf)). |
| `browser_unavailable: The browser service at wss://...:3000/ had no free browser session for 60 s. ...` | The browser on this machine serves one session at a time, and another browser run held it for the 60 s this run waited. | Start fewer browser runs at once (section 6). |
| `busy: the desktop runner is busy with another run` | The runner runs one run at a time, and another one held it longer than this run waited (its lease plus 15 seconds). | Nothing, or run less often. `runner-<yyyymmdd>.log` shows the runs. |
| `policy_violation: ... application "ErpDemo.exe" is not in the runner's allowedApps` | The policy does not allow the app. | Apply the change (section 7) or `allow-app` (section 8). `RpaPolicy.exe show` prints the policy. |
| `runner_unavailable: the desktop runner could not start ErpDemo.exe: it is not installed at the path the runner's policy names (allowedApps[].path). ...` | The app is not at the path the policy names. | Correct the path with a change file, or install the app there. |
| The installer says `Port 3000 is in use by <process>. Choose another with -RunnerPort or -BrowserPort.` | A port in use: another program listens on that port. | Stop that program, or install with another port (and use that port in the credential and the firewall). |
| `Browser: not listening yet` after an install, and `browser.err.log` has `RPA browser: cannot listen on port 3000: EADDRINUSE` | A port in use, taken after the install. | As above. The runner writes an `ERROR cannot start:` line to `runner.out.log` and `runner-<yyyymmdd>.log` when it cannot start, for this or another reason. |
| `Runner fingerprint: not known yet (the program has not started)` | The current `runner.out.log` has no start line: the runner has not started as the bot user, or its latest start failed. | Sign the bot user in; read `runner.out.log` and `start-runner.log`. |
| The installer says `<path> is a link or junction. Remove it and run the installer again.` or `<path> has more than one name (a hard link). Check what it is, remove it, and run the installer again.` | The installer looks at everything in `C:\ProgramData\RPA Runner` on every run and refuses a link, a junction or a file with a second name there. The programs do not make such entries, so something else running as the bot user did. | Find out what made it. Then uninstall, sign the bot user out and uninstall again with `-RemoveData` (section 9), which removes a link as the link itself and not what it points to, and install again as in section 3 (a first install: new policy, tokens and certificates). Do not paste the path into a command: whoever made the entry chose its name. |
| The installer says `... can be changed by <account>. Unpack the package in a folder only you or administrators can change, and run it from there.` | The package folder, or a folder above it, can be changed by someone other than administrators. | Unpack into a folder made from an administrator PowerShell under `C:\Program Files` (section 2). |
| The installer says `Run Install-Rpa.ps1 from Windows PowerShell (powershell.exe), not PowerShell 7 (pwsh).` | Wrong PowerShell. | Use Windows PowerShell 5.1 as administrator: as in section 1 before the bot user has signed in, as in section 5 after. |
| PowerShell says the script `cannot be loaded because running scripts is disabled on this system`, or that it `is not digitally signed` | The execution policy or the downloaded-file mark. | Start the script as `powershell.exe -ExecutionPolicy Bypass -File "<path>"` (section 5), or run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` in that window first. For files of a download, `Unblock-File` as in section 2. |

For anything else, the README's [Error codes](../../README.md#error-codes) lists every code a run can fail with.
Report a problem on [GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues), without tokens, passwords or
host names you do not want to share; security issues as [`SECURITY.md`](../../SECURITY.md) describes.
