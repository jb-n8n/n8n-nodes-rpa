# Record a bot

The **RPA Recorder** watches a person work in a Windows app and saves what they did as a recording file. n8n's import
form turns that file into steps, which a person approves before the bot runs. The recorder only watches: it sends no
input to the app, starts nothing but the app you choose, and changes no settings by itself.

It comes with the [Windows package](../install/windows.md) and is in the Start menu as **RPA Recorder**
(`C:\Program Files\RPA Runner\recorder\RpaRecorder.exe`). To record a website instead, use Chrome's Recorder or the
Playwright recorder ([Move a bot](move-a-bot.md)).

**Tried on:** WinForms and Win32 apps. Not tried on WPF apps, apps that show their content in WebView2, or apps that
draw their own controls: there it may record nothing, or steps that do not find their controls later.

## Before you start

- **Record in your own administrator session**, not as the bot user. The recording does not depend on who recorded it.
  Start the app from where the bot user will start it (installed for all users, under `C:\Program Files`).
- **Record as the bot user** only when the app keeps per-user settings the run depends on (a saved server address, a
  layout). That needs the bot user's password and a time when no run is due. Sign the bot user out afterwards:
  runs are refused while anyone is signed in as the bot user.
- Open the app in a state you can start from again: signed out, or a fresh document.

## The bar, stage by stage

The bar opens at the top right of the screen and stays on top. Its top line says the stage, with a coloured dot, and
one sentence under it says what to do now. Drag it aside if it covers the app. Clicks on the bar are not recorded.

**Ready.** Two buttons: **Start an app…** and **Use an open app…**. The bar says
`Your clicks and what you type in that app become steps, listed here as plain sentences.` and
`Clicks on this window are never recorded, and password boxes are never read.`
- **Start an app…** opens a small window: **App** with **Browse…**, and **Arguments (optional)**. Do not put a
  password in the arguments: they are saved in the recording. Choose **Start recording**.
- **Use an open app…** lists the windows of other apps. Choose the app's window.

**Starting.** `Starting <app>…` and `Wait for its window: recording starts when it shows.` An app that shows no
window within 30 seconds is reported.

**Recording.** `Recording <app> · <n> steps`, with a red dot. Do the work in the app once, as the bot should do it,
without detours. Each step appears in the numbered list as a sentence, such as `Click Sign in`,
`Type "clerk" into User name` or `Choose "2000" in Company code`.
- **Pause** stops recording (the top line says `Paused`, with an amber dot), and **Resume** goes on.
- To return a value to n8n, point at it in the app and press **F9**: `Point at a value in the app and press F9 to read it on every run.`
  The bar asks for an output name (for example `out_result_count`) and adds `Read "6 line items" as out_result_count`.
- To fix a mistake, select the step and choose **Delete step**.
- **Make variable…** and **Make secret…** turn a selected step's value into a variable or a secret now. You can also
  do it all at once after **Finish**.

<!-- screenshot: recorder-bar-recording.png -->

**Which of these change from run to run?** After **Finish**, the top line says `Almost done · <n> steps` and the bar
lists every step that typed a value or chose an item. Tick each value that changes from run to run, such as a date or
a company code. It becomes a variable with the name under it, which you can change, and the recorded value becomes its
start value. Leave the rest unticked: they stay as recorded. A secret shows as a secret and stays one. Choose
**Continue**, or **Back** to record more.

<!-- screenshot: recorder-values-page.png -->

**Finished.** `Finished · <n> steps` and `Check the steps, then name the recording and save it.` **Name** starts as
`<program> recording`. The folder is `Documents\RPA recordings`. **Change folder…** picks another. Choose **Save**. It
asks before it replaces a file.

**Saved.** `Saved · <n> steps` and `Saved <file> in <folder>. Two things are left to do:`
1. **Allow <app> on this machine**, with **Allow this app…**. The runner starts only the apps in its **policy**, the
   list of allowed apps on this machine. The button starts the policy tool with administrator rights: Windows asks for
   them, and the tool shows what it will allow (the app's path and a fingerprint of the file) and asks. Type `y`. The
   bar then says the tool reported success. A recorder that is not part of an install shows the command for an
   administrator instead.
2. **Import the recording in n8n**, with **Show the file**: `Upload it in n8n's Import a bot form.` Upload the
   `.rpa-recording.json` file there ([desktop bot guide](desktop-bot.md#4-import-and-approve)). Its review page also
   lists the steps the import adds: a wait for each window, and one for each file the bot returns.

**Record another** starts over. It asks first when the steps are not saved, and so does closing the bar.

<!-- screenshot: recorder-bar-saved.png -->

## What it records

- **Recorded:** a left click, a double click, the text of a field (read when you leave the field), a choice in a
  list, a check box as the state it is set to, Space on a button, Enter, Tab, Escape, the function keys, and Ctrl or
  Alt shortcuts.
- **Not recorded:** a right click and its menu (unless you then left-click a menu item), the mouse wheel, dragging,
  Ctrl+Alt with a letter or digit (on many keyboards that types characters, which may be part of a password), keys that
  belong to Windows (the Windows key, Alt+Tab, Alt+Esc, Ctrl+Esc), and choosing an empty item.
- **Only the app you record.** Input in other programs, a program the app starts included, is not recorded. The bar
  says `Input in other programs is not recorded.`
- **An app that runs as administrator** can only be recorded by a recorder started as administrator.

## Marks on a step

A small mark after a step says it needs a look. Its tooltip says why.
- **Variable**: on each run this value comes from a variable, which n8n supplies.
- **Secret**: the typed value is not in the recording. On each run a secret variable supplies it.
- **Check**: the app answered late, so the step was recorded as it was then. Or the step finds its element by a row
  position (`Vendor Row 1`), so a later run acts on whatever is in that row. Or it finds its element by the text it
  shows now, or it is a click on a label. Check it, and delete it if it is wrong.

## Passwords and secrets

- The recorder does not read a field it recognises as a password box (by its password flag, or a name or id that
  reads like one). Its step types a secret variable, such as `{{var.password}}`.
- A value typed into a box the recorder does not recognise is read like any field. Make that step a secret before you
  save: the value is removed from the list and the file. Close the recorder after saving, so the value does not stay
  in its memory. The import refuses a recording that still holds a value in a field named like a password.
- n8n supplies secrets from an **RPA Secret Variables** credential on the bot's **Run steps** node, by the variable's
  name. Who may hold that credential is in [Security](../reference/security.md#secret-variables).

## Notices

The bar shows one notice at a time on the line under the state, amber when something should be checked. A long one is
cut, and its tooltip shows it whole. **Earlier notices** lists them all. The ones to act on:

| Notice | What to do |
|---|---|
| `This app runs as administrator, so the recorder cannot see inside it. Start the recorder as administrator to record it.` | Start the recorder as administrator, from your own session. |
| `The recorder missed some input (the app was slow, or an administrator's window had it). Check the last steps.` | Look at the last steps and record again what is missing. |
| `Check the step on "<step>": the app answered late, so it was recorded as it was then. Delete it if it is wrong.` | Check that step. |
| `The value typed into "<field>" could not be read, so that step is not in the recording: add it by hand.` | Add the step in a step document ([Steps](../reference/steps.md#desktop-steps)). |
| `A Ctrl+Alt shortcut was not recorded: on many keyboards Ctrl+Alt types characters. Use the app's menu for that step.` | Use the app's menu instead. |
| `The recording makes about <n> steps, and Import Steps takes at most 200: delete steps, or record the work in shorter parts.` | Delete steps, or record in parts. |

## Without the bar's button

An administrator can allow the app from the saved policy change file (`<name>.policy-change.json`, beside the
recording), in an administrator PowerShell:

```powershell
& "C:\Program Files\RPA Runner\rpa.cmd" policy apply "$env:USERPROFILE\Documents\RPA recordings\<name>.policy-change.json"
```

The tool copies the file into its own folder, shows what it allows, and asks. The change file allows the app at its
path, pins the file's fingerprint, and lists the arguments you gave. It lists no write controls: to protect the app's
Save and Post buttons, see the [Windows guide](../install/windows.md#8-allow-your-own-app).
