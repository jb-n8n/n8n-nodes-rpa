# One bot, many accounts

Many bots sign in to the same site with one account after another: one per branch, store or client, read from a
database. One **RPA Site Login**, one approved step list and one workflow do this. The Site Login's username and
password are expressions that read each account from the item, so every item signs in as its own account.

## The shape

```
Get active steps → Get accounts (one row per account) → Run steps → Data / error output
```

- **Get accounts** is your database, spreadsheet or Data Table node. Each row is one item: the user name, the password,
  and the TOTP Secret when the account uses an authenticator app. The column names are yours.
- **Run steps** runs the items one after the other, each with its own account. Read the approved steps with an
  expression that does not depend on the item, for example `{{ $('Get active steps').first().json.steps }}`.
- Set **Run steps → Settings → On Error** to **Continue (using error output)**. Without it, the first account that
  fails stops the node, and the accounts after it do not run.

## The Site Login, with expressions

In n8n, create an **RPA Site Login** as for one account (Login Page URL, sites and pages), then:

1. Point at **Username**. Click **Expression** on the **Fixed / Expression** switch at the right of its name, and
   type `{{ $json.username }}`.
2. Do the same for **Password** (`{{ $json.password }}`) and, when accounts use one-time codes, **TOTP Secret**
   (`{{ $json.totpSecret }}`). An empty TOTP Secret means that account gets no code.
3. Under each field the window shows `[ERROR: No path back to node]`. That is expected: the values exist only while
   a workflow runs. Click **Save**.

Keep the sites and pages fixed. They decide what the approved steps may open and post to, and only the credential's
owner should set them.

## Approving the steps

One approval covers every account. A signature binds the Site Login's credential ID, not the values it holds. To
import or repair the steps, give **Import Steps** (or the first run of **Run steps**) one account's item, so that it
can sign in. **Sign steps** needs no account: on the approval item the expressions are empty, and it signs anyway.

## When one account fails

The login breaker and the run lock are kept per account: the Site Login and the user name (compared without case and
surrounding spaces).

- A wrong password fails that item `login_failed` and opens that account's breaker. The other items run as usual.
- Later runs skip that account with `locked_out` and try no login for it. Correct its password in your data and the
  next run tries once. If the password was right, or the account is unlocked now (`account_locked`), type a new
  **Options → Login Breaker Reset Key**: that reopens every account of this Site Login that the breaker stopped.
- Two runs of the same account at the same time: the second fails `busy`. Different accounts may run at the same time.
- A breaker that opened in version 0.2.0 or earlier is kept under the Site Login alone. It stops every account until
  you type a new reset key.

## Rotating passwords

Keep the next password in its own column, say `newPassword`, and add it in **Options → Variables** as `newPassword`
with the value `{{ $json.newPassword }}`. A `signIn` with `changePassword` ([Steps](../reference/steps.md#sign-in))
types it when the site asks for a new password. That item then says `passwordChanged: true` (on the error output, in
`details`). Store it for that account only:

1. An **If** node on both outputs of **Run steps**: `{{ $json.passwordChanged === true || $json.details?.passwordChanged === true }}`.
2. On its true branch, update that account's row: match `username` to `{{ $('Get accounts').item.json.username }}`,
   set the password to `{{ $('Get accounts').item.json.newPassword }}` and empty `newPassword`.

Until the row is updated, later items of the same account in that execution fail `locked_out`. The other accounts
are not affected. Keep the old password somewhere until a run has signed in with the new one.

## What it means for secrets

The passwords travel through the workflow's items. Whoever can open this workflow's executions can read them in the
output of the node that reads the accounts, and on the error output of **Run steps**, where n8n copies the input
item's fields into each failed item. The RPA node masks them in its own outputs, errors, logs, traces and
screenshots, but it cannot hide the items it is given. To limit who sees them:

- Do not save execution data for this workflow. In its **Settings**, set **Save failed production executions** and
  **Save successful production executions** to **Do not save**, and turn off **Save manual executions**.
- Keep the passwords in a secrets store or a database that few people can read, not in a sheet that many people
  open. On n8n Enterprise, external secrets may let the Password expression read each account's secret by name, so
  that no password sits in an item. We have not tried this.
- Keep the workflow, the Site Login and the account data in a project that only the bot's owners can open.
- Send alerts with the fields you need, never the whole failed item: it carries the password.

Anyone who can edit the workflow or the account data can make the bot sign in with any user name and password they
choose. They still reach only the sites the Site Login allows, with the approved steps.
