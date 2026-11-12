# Installing RPA on a Windows machine

This page is for the administrator of the Windows machine the bots work on. It covers the install, how the bot user is
signed in, the `rpa` command, allowing apps, upgrades, changing tokens and certificates, and what to do when something
fails. For the short path from nothing to a running bot, follow [Your first Windows desktop bot](../guides/desktop-bot.md).

What the package puts on the machine:
- **The desktop runner** (`RpaRunner.exe`): n8n sends it desktop steps, and it drives Windows apps through UI
  Automation. It listens on `wss://<machine>:8765/rpa/v1`.
- **The browser**, only when you add it with `-WithBrowser`: Chromium behind a token check with its own certificate,
  on `wss://<machine>:3000`. It comes in a second zip, `rpa-browser-windows-x64.zip`.
- **The policy tool** (`RpaPolicy.exe`): with it an administrator decides which apps the runner may start.
- **The RPA Recorder** (`RpaRecorder.exe`, in the Start menu as **RPA Recorder**): records a flow in a Windows app
  ([Record a bot](../guides/record-a-bot.md)).
- **ERP Demo**, a small sample app.

The runner (and the browser, when installed) runs in the Windows session of one user, the **bot user** (`rpa-runner`
by default). A Windows service cannot drive a desktop, so the bot user is signed in whenever a run works: on Windows
Server a service signs it in for each run ([section 4](#4-signing-in)).

**Who trusts whom.** Treat this machine as part of your n8n: whoever can use its RPA credentials in n8n can act on it
as the bot user, as with the robot machine of other RPA tools. Give the bot user only the access its work needs, and
limit who can reach its ports.

The package was tested on Windows Server 2022, and CI installs it on Windows Server 2025. Windows 10, Windows 11 and
Windows Server 2019 meet its requirements but were not tested. It is open source under the [MIT licence](../../LICENSE),
provided as is: try it on a machine you can rebuild first.

> **Not released yet.** No release of the Windows package has been published, so the download below has nothing to
> fetch yet. Until the first release, build the package as [`desktop/README.md`](../../desktop/README.md#building-and-testing)
> says. The build writes a `Get-Rpa.ps1` beside the zip: run that one with `-Zip <path to the zip>`.

## 1. Before you start

- **Windows**: 64-bit Windows Server 2019 or later (Windows 10 1809 or later and Windows 11 work with `-AutoSignIn` or
  a person who signs in, not unattended).
- **Disk**: about 3.5 GB free on drive C.
- **An administrator account**, for the install and for every change to the policy.
- **The network path**: n8n must reach TCP port **8765** (the runner) on this machine, and **3000** too when you add the
  browser. Note n8n's address as this machine sees it, and open the port in any firewall between them, such as a cloud
  security group.
- **n8n** self-hosted, with the RPA node 0.2.0 or later.
- **Licences**: read [the licensing note](licensing.md) and settle with your licensing contact what this use of
  Windows needs.

Run every command on this page in **Windows PowerShell 5.1 opened with "Run as administrator"** in your own
administrator session. Not PowerShell 7 (`pwsh`) and not "Windows PowerShell (x86)": the installer refuses both.

## 2. Install

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
Invoke-WebRequest -UseBasicParsing https://github.com/jb-n8n/n8n-nodes-rpa/releases/download/desktop-v<version>/Get-Rpa.ps1 -OutFile Get-Rpa.ps1
Set-ExecutionPolicy -Scope Process Bypass -Force
.\Get-Rpa.ps1 -AllowFrom <n8n address>
```

`Get-Rpa.ps1` prints its own SHA-256 first, to compare with the file you checked. It then downloads
`rpa-windows-x64.zip` and its `.sha256` from the release, compares the zip's SHA-256 with that file and with the one
the script names, and checks the build attestation with the GitHub CLI when `gh` is installed and signed in (without
it, one line says the attestation was not checked and gives the command to check it elsewhere). It unpacks into
`C:\Program Files\RPA package\<version>`, checks that only administrators can change that folder, and starts
`Install-Rpa.ps1` with the parameters you gave. A failed check stops it before anything is unpacked. Add
`-RequireAttestation` to make the attestation check mandatory, or `-Zip <path>` for a zip you downloaded already (with
its `.sha256` beside it).

The install has no browser unless you add `-WithBrowser`. With it, `Get-Rpa.ps1` also downloads
`rpa-browser-windows-x64.zip` from the same release, checks it the same way, and unpacks it into the package folder.
With `-Zip`, give the browser zip with `-BrowserZip <path>`. Without `Get-Rpa.ps1`, unpack `rpa-browser-windows-x64.zip`
into the `rpa-windows-x64` folder and run `Install-Rpa.ps1 -WithBrowser`.

The installer lists what it will change and asks you to type `YES`. On Windows Server, a first install for a new bot
user with no sign-in mode is **unattended** (section 4), and the list starts with
`No sign-in mode was given, so this install is unattended (-Unattended): the default on Windows Server for a new bot user.`

The parameters (all of them work with `Get-Rpa.ps1` and `Install-Rpa.ps1`):

| Parameter | What it does |
|---|---|
| `-AllowFrom <address>[,<address>...]` | The firewall rules let in only these addresses (or ranges such as `10.0.0.0/24`), normally the n8n host. List every address of n8n's workers in queue mode. |
| `-AllowFromAnyAddress` | The rules let in any address, on Domain and Private networks. On a Public network (most cloud machines) add `-IncludePublicNetwork`. |
| `-NoFirewall` | Leave Windows Firewall alone. A first install needs one of these three. |
| `-User <name>` | The bot user. Default `rpa-runner`, created as a standard user. An existing administrator is refused. |
| `-UserPassword <SecureString>` | A password for the bot user, for example `-UserPassword (Read-Host 'Password' -AsSecureString)`. Give one you keep if a person will ever sign in as the bot user. |
| `-Unattended`, `-IdleSeconds <n>` | Nobody signed in: a service signs the bot user in for each run and out `-IdleSeconds` (15) after it. Windows Server only. |
| `-AutoSignIn` | Windows keeps the bot user signed in. |
| `-RunnerPort`, `-BrowserPort` | Other ports than 8765 and 3000. |
| `-WithBrowser` | Add the browser (see [Who can reach the ports](#who-can-reach-the-ports)). It needs the browser zip. |
| `-NoBrowser` | No browser, which is the default. On an install that has the browser, it removes the browser. |
| `-Force` | Do not ask, and upgrade even while a run is going on. |

**Through a tunnel or a port forward** (SSH, a cloud port forward): the connection arrives from the machine itself,
which Windows Firewall lets in, so install with `-NoFirewall` and keep the ports closed in your network. Give n8n the
tunnel's address with `rpa connection -Address <name>` (section 6). A forward that closes when idle makes later runs
fail: for scheduled runs, use an address that stays.

When it has finished, the installer prints where everything is, `RPA is installed.`, and with `-Unattended` the
Connection Lines with their tokens hidden, then `For how the supervisor is doing: & "C:\Program Files\RPA Runner\rpa.cmd" status`.

## 3. What the install changes

- **Programs** in `C:\Program Files\RPA Runner` (only administrators can change them): `runner\`, `recorder\`,
  `scripts\`, `erp-demo\`, `rpa.cmd`, the uninstaller, and `install.json` with the install's parameters.
- **Data** in `C:\ProgramData\RPA Runner`: `policy.json` (allows no app yet), the runner's token `token`, the
  certificate the runner makes at its first start, `logs\`, `policy-backups\` and `policy-changes\`.
- **The bot user**, when it did not exist: a local standard user.
- **A scheduled task**, `\RPA\RPA Runner`, which starts the runner when the bot user signs in, and again within 10
  seconds when it exits.
- **A firewall rule**, `RPA-Runner-In` (not with `-NoFirewall`). Nothing else in the firewall changes.
- **A Start menu entry** for all users, **RPA Recorder**.
- With `-Unattended` or `-AutoSignIn`: the changes section 4 lists.
- With `-WithBrowser`, also: `browser\` in the programs, the token `browser-token` and the browser's certificate in the
  data, the task `\RPA\RPA Browser` and the firewall rule `RPA-Browser-In` for port 3000.

### Who can reach the ports

The runner and the browser accept anyone who can reach their port and has their token. With the runner's token, a
caller drives the apps the policy allows. With the browser's token, a caller acts as the bot user through the browser:
it can open any address this machine reaches and read any file the bot user can read, the runner's token included.
The runner's policy does not limit that. So add the browser only when your bots need a browser on this machine, for
example for a site only this machine can reach. Otherwise keep the default and run the browser elsewhere. Either way,
use `-AllowFrom` with n8n's address.

## 4. Signing in

The runner drives apps only while the bot user's desktop is signed in and unlocked. On a locked or disconnected desktop
a run fails `runner_unavailable` and says which. There are three ways:

| Mode | How | For |
|---|---|---|
| **Unattended** (`-Unattended`) | A service signs the bot user in when n8n connects, and out after the idle time. Nobody stays signed in. | Windows Server 2019 or later. The default for a new bot user there. |
| **Automatic sign-in** (`-AutoSignIn`) | Windows signs the bot user in at every start and keeps the desktop unlocked. | Windows 10 and 11, or a machine whose console is protected. |
| **By hand** (`-UserPassword` only) | A person signs the bot user in and leaves the session open. | Trying it out. |

### Running with nobody signed in

The **RPA Supervisor** service (`runner\RpaSupervisor.exe`, as SYSTEM) listens on the runner's port, and on the
browser's when the browser is installed. When n8n connects, it signs the bot user in through a Remote Desktop
connection from the machine to itself, waits until the runner listens, and passes the connection through unchanged:
TLS, the token and the n8n credentials stay as they are. A run after a
quiet time waits about 5 to 20 seconds for the sign-in. The node waits up to 60 seconds, and tries once more when the
connection drops during the TLS handshake. The bot user must be a local user.

What it changes:
- the bot user joins **Remote Desktop Users**,
- Remote Desktop is turned on when it is off (the registry value only, no firewall rule),
- the bot user's password is stored in the LSA secret `L$RpaRunnerBotPassword`, which SYSTEM and administrators can read,
- the runner (and the browser) listen on `127.0.0.1` at their port + 10000.

A bot user the installer creates gets a random password nobody knows. `Uninstall-Rpa.ps1`, or an install with
`-Unattended:$false`, undoes these changes.

- **While someone is signed in as the bot user, runs are refused.** Record and inspect as an administrator, and sign
  the bot user out when you are done.
- **A new password set by an administrator** makes the runner unable to read its certificate. Store the new password
  with `-Unattended -UserPassword (...)`, remove the runner's certificate (section 10), and put the new fingerprint into
  n8n. Data the bot user's programs protect with the old password (an authenticator app's codes) is lost.
- **Anything that connects to the ports**, a health check or a port scanner too, makes the supervisor sign the bot user
  in. Limit who can reach the ports.
- Windows Server allows two remote sessions without the Remote Desktop Session Host role, so one administrator can
  connect during a run. Whether the bot user's session needs client access licences: [the licensing note](licensing.md#remote-desktop-to-windows-server).

### Automatic sign-in and signing in by hand

`-AutoSignIn` stores the bot user's password where Windows keeps it for automatic sign-in (the LSA secret
`DefaultPassword`), turns off the lock screen, the idle lock, sleep and the screen saver, and restarts nothing: restart
the machine afterwards. Anyone who can reach the machine's screen or console gets the bot user's desktop. Moving
between `-AutoSignIn` and `-Unattended` keeps the password.

By hand: sign in as the bot user at the console and leave the session open. Disconnecting a Remote Desktop session
locks it: hand it back to the console with `tscon <ID> /dest:console` (the ID from `query session`) before you close
the window.

## 5. The rpa command

`C:\Program Files\RPA Runner\rpa.cmd` (not on PATH: type the full path) runs in an administrator PowerShell:

| Command | What it does |
|---|---|
| `& "C:\Program Files\RPA Runner\rpa.cmd" connection -ShowTokens` | Prints the Connection Lines for n8n, with the tokens. Without `-ShowTokens` the tokens are hidden. Add `-Address <name or address>` when n8n reaches this machine by another name. |
| `& "C:\Program Files\RPA Runner\rpa.cmd" status` | Whether the runner (and the browser) listen, the mode, the bot user's sessions, and in unattended mode the supervisor and its last failure. No secrets. |
| `& "C:\Program Files\RPA Runner\rpa.cmd" policy apply <file>` | Applies a policy change file. The tool copies the file into `policy-changes\`, shows what it changes, and asks `Apply these changes? [y/N]`. |

Do administrator work from an administrator's own session (a second Remote Desktop session on Windows Server, or a
remote shell), not with "Run as administrator" on the bot user's desktop, where you would type an administrator's
password in a session the bots' programs share. Where your shell cannot answer the policy tool's question, it writes
nothing: run it in an administrator's desktop session.

## 6. Connect n8n

Run `rpa connection -ShowTokens` (section 5). It prints a line for the credential's **Connection Line** field:

- `rpa-runner://<address>:8765/rpa/v1#token=<token>&fingerprint=<64 hex digits>`

In n8n, create an **RPA Desktop Runner** credential and paste the line. Save it: the window says
`Connection tested successfully`.
n8n checks the certificate's fingerprint before it sends the token. The test succeeds on a locked desktop too: only a
run shows that.

Each line holds a token. Paste it straight into n8n, then close the window or run `Clear-Host`. A PowerShell
transcript, or a run-command tool's history, keeps what the window shows: if a token went there, change it
(section 10). Below the lines the command also prints the URL and the fingerprint separately, for the credentials'
older fields. The fingerprints come from files the bot user can write, so copy them while you trust what has run as
the bot user, best right after the install.

**With the browser** (`-WithBrowser`) it prints a second line,
`rpa-browser://<address>:3000/#token=<token>&fingerprint=<64 hex digits>`. Paste it into an **RPA Browser** credential
(**Mode** Browser Server). The browser on this machine serves one session at a time, and opens a window on the bot
user's desktop. **Save as PDF** needs a browser without a window, so it fails here.

## 7. Run the sample

The sample runs ERP Demo: it signs in, searches the line items of company code 1000, reads the result count, and
exports a CSV that comes back to n8n. Its files are in [`docs/install/samples/`](samples/).

**Allow ERP Demo.** A new policy allows no app. Write the change file and apply it:

```powershell
$change = Join-Path $env:TEMP 'erp-demo-policy-change.json'
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
& "C:\Program Files\RPA Runner\rpa.cmd" policy apply $change
```

It allows ERP Demo at its installed path, marks its Post button as a write control, and gates Ctrl+S and F11. Read
the lines the tool prints, type `y` and Enter. It answers
`Policy updated. The runner restarts within 10 seconds and uses the new policy.`

**Run it.** Download [`erp-demo.workflow.json`](samples/erp-demo.workflow.json) and import it in n8n
(**⋯ → Import → From File**). On **Export ERP Demo line items**, pick your RPA Desktop Runner credential and click
**Execute workflow**. The sample runs its steps unsigned (**Require Signed Steps** off), and its variables hold ERP
Demo's documented sign-in (`clerk` / `demo1234`). For your own bots keep signing on, and give passwords from an
RPA Secret Variables credential. The output has `values` (`out_ResultCount`: `12 line items`) and `line-items.csv` in
the **Binary** tab.

## 8. Allow your own app

Install the app for all users under `C:\Program Files` (the runner refuses an app at a path the bot user could change).
The recorder's **Allow this app…** button allows the app it recorded. By hand:

```powershell
& "C:\Program Files\RPA Runner\runner\RpaPolicy.exe" allow-app "C:\Program Files\Your App\YourApp.exe" --pin-hash
```

`--pin-hash` pins the file's SHA-256: after an app update, run it again. Give the app's real path on a local drive.

**Protect the writes.** Until an app's write controls and keys are in the policy, the runner gates no write in it.
List the buttons that save, post or submit (`writeControls`, by `automationId`) and the keys that do (`gatedKeys`) in a
change file like the sample's, and apply it with `rpa policy apply`. A step may then press them only when it was
marked as a write on approval.

**A web view app with a Copy button** (such as an authenticator app) also needs its web view runtime as a helper
process and clipboard reads:

```json
{
  "helperProcesses": [
    { "exe": "msedgewebview2.exe", "pathPattern": "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe" }
  ],
  "clipboardRead": true
}
```

A change only adds. To remove an entry, edit `C:\ProgramData\RPA Runner\policy.json` as an administrator, then end
`RpaRunner.exe` (`Stop-Process -Name RpaRunner -Force`, it restarts within 10 seconds) and check with
`RpaPolicy.exe show`. [`desktop/README.md`](../../desktop/README.md#changing-the-policy) describes every field.

## 9. Upgrade and uninstall

**Upgrade.** Run the new release's `Get-Rpa.ps1` with the same `-User` and ports as the first install, and `-Force`
when a run may be going on. An upgrade keeps the bot user, the policy, the tokens, the certificates, the firewall
addresses, the sign-in mode and the browser or its absence, so the n8n credentials stay as they are. For an install
with the browser, `Get-Rpa.ps1` gets the browser zip too (with `-Zip`, give `-BrowserZip`). `-WithBrowser` adds the
browser to an install without it. `-NoBrowser` removes it: its task, firewall rule, token, certificate and files.

**Another bot user.** Uninstall with `-RemoveData`, then install for the new user. That is a first install: a new
policy, new tokens and certificates, and new Connection Lines in n8n.

**Uninstall:**

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA Runner\Uninstall-Rpa.ps1"
```

It ends the programs and removes the tasks, the firewall rules, the Start menu entry, the programs, and what
`-AutoSignIn` or `-Unattended` changed. It keeps `C:\ProgramData\RPA Runner` and the Windows user. To remove the data
too, sign the bot user out (`quser`, then `logoff <ID>`), and run it again from the unpacked package:
`powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA package\<version>\rpa-windows-x64\Uninstall-Rpa.ps1" -RemoveData`.
Remove the user with
`Remove-LocalUser rpa-runner` when you no longer need it.

## 10. Changing the tokens and the certificates

Each program reads its token and certificate when it starts. The installer writes a missing token, and each program
makes a new certificate at a start that finds none. After a suspected exposure, change all of them, and first find out
what ran as the bot user. In an administrator PowerShell, delete what you want changed:

| To change | Delete |
|---|---|
| The runner's token | `Remove-Item -LiteralPath "C:\ProgramData\RPA Runner\token"` |
| The browser's token | `Remove-Item -LiteralPath "C:\ProgramData\RPA Runner\browser-token"` |
| The runner's certificate | `Remove-Item -LiteralPath "C:\ProgramData\RPA Runner\runner-certificate.pfx.bin"` |
| The browser's certificate | `Remove-Item -LiteralPath "C:\ProgramData\RPA Runner\browser-cert.pem", "C:\ProgramData\RPA Runner\browser-key.pem"` |

Then run the installer of the installed version again, with the same parameters and `-Force`:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Program Files\RPA package\<version>\rpa-windows-x64\Install-Rpa.ps1" -Force
```

Then run `rpa connection -ShowTokens` and paste the new lines into the n8n credentials. Until n8n has them, runs fail
with a refused token or a fingerprint mismatch.

## 11. When something fails

Start with `& "C:\Program Files\RPA Runner\rpa.cmd" status`. Logs are in `C:\ProgramData\RPA Runner\logs`
(`runner-<date>.log`, `runner.out.log`, `browser.err.log`, `start-runner.log`) and, for the supervisor, in
`C:\ProgramData\RPA Runner\supervisor\supervisor.log`.

| What you see | What it means | What to do |
|---|---|---|
| `runner_unavailable: Could not connect to the desktop runner at ... Is it running, and is the port open?` | n8n cannot reach the runner, or the supervisor could not sign the bot user in. | Run it again once. Then `rpa status`: is the runner listening, and what is the supervisor's last failure? Check the firewall rule (`Get-NetFirewallRule -Name RPA-Runner-In \| Get-NetFirewallAddressFilter`) and the network path. |
| `rpa status` says `Supervisor's last failure: UserSignedIn: ...` | Someone is signed in as the bot user. | Sign that session out. |
| `WrongPassword: ...` or `PasswordExpired: ...`, and `sign-ins are blocked until the service is restarted` | The stored password is wrong or expired. The supervisor stops trying so it does not lock the account. | Give the bot user a password that does not expire, store it with `Install-Rpa.ps1 -Unattended -UserPassword (...)`, then change the runner's certificate (section 10). |
| `Nothing listened on 127.0.0.1:18765 within 90 s ...` | The runner did not start in the bot user's session. | Read `logs\runner.out.log`. `cannot read the runner certificate` there means the bot user's password was changed: remove the certificate (section 10). |
| `runner_unavailable: the desktop runner's Windows session is locked ...` | The bot user's desktop is locked or disconnected (signed-in modes). | Sign in again, or hand the session back to the console (section 4). |
| `The desktop runner at ... refused the token.` or `The browser server at ... refused the token.` | The token in n8n is not the machine's. | Paste the Connection Line again (section 6). |
| `... presented a certificate with fingerprint ..., which is not the fingerprint in the RPA Desktop Runner credential.` or `The browser server's certificate does not match ...` | The certificate changed, or something else answers at that address. | If you did not change the certificate on purpose, find out what did before you accept the new fingerprint. |
| `policy_violation: the desktop runner is not allowed to start ErpDemo.exe. On the Windows machine, allow it: ...` | The policy does not allow the app. | Allow it (sections 7 and 8). `RpaPolicy.exe show` prints the policy. |
| `runner_unavailable: the desktop runner could not start ErpDemo.exe: it is not installed at the path the runner's policy names ...` | The app is not where the policy says. | Install the app there, or allow it at its real path. |
| `busy: the desktop runner is busy with another run` | One run at a time: another one held the runner longer than this run waited (45 s). | Run less often, or at other times. |
| `The browser service at wss://...:3000/ had no free browser session for 60 s.` | The browser here serves one session at a time. | Start fewer browser runs at once. |
| `Save as PDF needs headless Chromium` | The browser here shows a window. | Run Save as PDF on another browser ([Operator guide](../reference/operator.md#where-the-browser-runs)). |
| `Port 3000 is in use by <process>. Choose another with -RunnerPort or -BrowserPort.` | Another program holds the port. | Stop it, or install with another port. |
| `The browser files are not in ...` or `This install has the browser, and its files are not in ...` | The browser zip was not unpacked into the package folder. | Run `Get-Rpa.ps1 -WithBrowser`, or unpack `rpa-browser-windows-x64.zip` there. To remove the browser instead, add `-NoBrowser`. |
| `... can be changed by <account>. Unpack the package in a folder only you or administrators can change, and run it from there.` | The package folder is not protected. | Use `Get-Rpa.ps1`, which unpacks under `C:\Program Files`. |
| The script `cannot be loaded because running scripts is disabled on this system` | The execution policy. | Run `Set-ExecutionPolicy -Scope Process Bypass -Force` in that window first. |

Every error code a run can fail with is in [Errors](../reference/errors.md). Report a problem on
[GitHub issues](https://github.com/jb-n8n/n8n-nodes-rpa/issues) without tokens, passwords or host names, and security
issues as [`SECURITY.md`](../../SECURITY.md) describes.

## 12. Download and check by hand

To check the package yourself before anything runs, download it on another machine with the
[GitHub CLI](https://cli.github.com/) signed in:

```powershell
$version = '<version>'
gh release download "desktop-v$version" --repo jb-n8n/n8n-nodes-rpa --pattern 'rpa-windows-x64.zip*' --pattern 'Get-Rpa.ps1'
gh attestation verify rpa-windows-x64.zip --repo jb-n8n/n8n-nodes-rpa `
  --signer-workflow jb-n8n/n8n-nodes-rpa/.github/workflows/desktop-release.yml --source-ref "refs/tags/desktop-v$version"
```

The attestation shows which workflow, tag and commit built the zip. It does not show that the commit was reviewed.
Copy `rpa-windows-x64.zip`, `rpa-windows-x64.zip.sha256` and `Get-Rpa.ps1` to the Windows machine, then run
`.\Get-Rpa.ps1 -Zip .\rpa-windows-x64.zip -AllowFrom <n8n address>`: it checks the hash again and installs. For the
browser, download `rpa-browser-windows-x64.zip*` too, check it with the same `gh attestation verify` command, copy it
and its `.sha256` as well, and add `-WithBrowser -BrowserZip .\rpa-browser-windows-x64.zip`.
