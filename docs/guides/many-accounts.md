# One bot, many accounts

Many bots sign in to the same site with one account after another: one per branch, store or client, read from a
database. One **RPA Site Login**, one approved step list and one workflow do this. The Site Login's username and
password are expressions that read each account from the item, so every item signs in as its own account.

## The shape

```
Get active steps (<name>) → Get accounts (one row per account) → <name> (Run Steps) → Data / error output
```

The import form hands over **Get active steps (<name>)** and an RPA node named after the bot. Put your accounts node
between the two. Nothing else changes: the RPA node reads the approved steps, their signature and version from **Get
active steps (<name>)** by its name. **Get accounts** is a database, spreadsheet, Data Table or Code node, one item per
account: the user name, the password, and the TOTP Secret when the account uses an authenticator app. The RPA node runs
the items one after the other. Keep its **Settings → On Error** on **Continue (using error output)**, as it comes.

## The Site Login, with expressions

Create an **RPA Site Login** as for one account. Then point at **Username**, click **Expression** on the **Fixed /
Expression** switch at the right of its name, and type the expression. The same for **Password** and **TOTP Secret**:

- Username `{{ $json.username ?? 'summit-ops' }}`
- Password `{{ $json.password ?? 'demo-password' }}`
- TOTP Secret `{{ $json.totpSecret ?? 'JBSWY3DPEHPK3PXP' }}`

The value after `??` is the **fallback**: the account used when the item has no such field. The import form needs it,
because it signs in once to try the steps and its item has no account. Each field shows `[ERROR: No path back to
node]`. That is expected: there is no item until a workflow runs. Click **Save**. Keep the sites and pages fixed: they
decide what the approved steps may open and post to.

The fallback has two costs. n8n masks a password field only when it holds a plain value, so anyone who can edit this
Site Login can read the fallback password: use an account made for testing. And an item without a `username` field
signs in as the fallback account, so keep the column names exact. Each output item's `account` says which account it
signed in as. An empty TOTP Secret means that account gets no code.

## Approving the steps

One approval covers every account: a signature binds the Site Login's credential ID, not the values it holds. Give this
Site Login an import form of its own, beside the one you have, with one command (here for a Site Login named
**Sample accounts**, in the compose stack, as in step 3 of the [browser bot guide](browser-bot.md), with no API key):

```bash
docker compose exec n8n /opt/n8n-rpa/node_modules/.bin/n8n-nodes-rpa setup --new-workflow --site-login "Sample accounts" --allow-private-network
```

It makes and publishes **RPA: 5 Import a bot (Sample accounts)**, with this Site Login on **Import steps** and **Sign
steps**, and prints its address: `/form/rpa-import-sample-accounts`. Run again, also after the Site Login was renamed,
it finds that form by the Site Login it holds and makes no second one. It signs with the same **RPA Step Signing** key
and leaves your first form as it is. Leave out `--allow-private-network` for a site on the internet. Use this form for
the bots of this Site Login: the workflow it hands over has the Site Login on its RPA node, and its note names this form
and its address. A bot is changed or signed again on the form it was approved on. Every form lists every approved
bot, so a bot opened on another Site Login's form gets a red warning on its review page: change it on its own form.
Approved there, it would run only with that form's Site Login, and its own runs would stop.

## Try it on the sample site

The sample site of [Your first browser bot](browser-bot.md) has three accounts: `summit-ops`, the one of that guide,
`lakeside-ops`, which always asks for a one-time code, and `harbor-ops`, which never does.

1. Make the Site Login above, with the other fields as in step 2 of the browser bot guide, and name it
   **Sample accounts**. Give it its own form with the command above.
2. On that form, upload `docs/samples/sandbox-rows.steps.json` with the name `sandbox-rows-accounts`, and choose
   **Approve and sign**. Import the workflow it hands over (**⋯ → Import → From File**).
3. Hover over the line between **Get active steps (sandbox-rows-accounts)** and **sandbox-rows-accounts**, click **+**,
   search for `Code` and choose **Code in JavaScript**. Name it **Get accounts** and replace its code with this (harbor-ops gets a wrong password):

   ```js
   return [
     { json: { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' } },
     { json: { username: 'lakeside-ops', password: 'lakeside-password', totpSecret: 'LAKESIDE2345ABCD' } },
     { json: { username: 'harbor-ops', password: 'wrong-password', totpSecret: '' } },
   ];
   ```

4. Click **Execute workflow**. The Data output of **sandbox-rows-accounts** has two items, `account` `summit-ops` and
   `lakeside-ops`, each with the notices it read. Its error output has harbor-ops: `login_failed`, with `details.guidance`,
   which says what to do. **Log failed run** writes its row, and the execution ends as failed at **Stop and Error**.
5. Execute it again: harbor-ops fails `locked_out` and tries no login, the other two run. Change its password to
   `harbor-password` in **Get accounts** and execute again: all three run.

## When one account fails

The login breaker and the run lock are kept per account: the Site Login and the user name, without case or spaces.

- A wrong password fails that item `login_failed` and opens that account's breaker. The other items run as usual.
- Later runs skip that account with `locked_out`. Correct its password in your data, and the next run tries once. If the password was right, or the account is unlocked
  now (`account_locked`), type a new **Options → Login Breaker Reset Key**: it reopens every account of this Site Login.
- Two runs of the same account at the same time: the second fails `busy`. Different accounts may run at the same time.
- A breaker from version 0.2.0 or earlier stops every account until you type a new reset key
  ([Operator guide](../reference/operator.md#login-breaker-and-run-lock)).

## Rotating passwords

Keep the next password in a column `newPassword`, and add it in **Options → Variables** as `newPassword` with the value
`{{ $json.newPassword }}`. A `signIn` with `changePassword` ([Steps](../reference/steps.md#sign-in)) types it when the
site asks. The item then says `passwordChanged: true` (in `details` on the error output). Store it for that account:

1. An **If** node on both outputs of the RPA node: `{{ $json.passwordChanged === true || $json.details?.passwordChanged === true }}`.
2. On its true branch, update that account's row: match `username` to `{{ $('Get accounts').item.json.username }}`,
   set the password to `{{ $('Get accounts').item.json.newPassword }}` and empty `newPassword`.

Until the row is updated, later items of that account in that execution fail `locked_out`, and the others run. Keep the
old password until a run has signed in with the new one.

## What it means for secrets

The passwords travel through the items. Whoever can open this workflow's executions can read them in the output of the
node that reads the accounts, and on the RPA node's error output, where n8n copies the input item into each failed item.
The RPA node masks them in its outputs, errors, logs, traces and screenshots, not in the items it is given. To limit this:

- Do not save execution data for this workflow. In its **Settings**, set **Save failed production executions** and
  **Save successful production executions** to **Do not save**, and turn off **Save manual executions**.
- Keep the passwords in a secrets store or a database that few people can read, not in a sheet that many people
  open. On n8n Enterprise, external secrets may let the Password expression read each account's secret by name, so
  that no password sits in an item. We have not tried this.
- Keep the workflow, the Site Login and the account data in a project that only the bot's owners can open.
- Send alerts with the fields you need, never the whole failed item: it carries the password.

Anyone who can edit the workflow or the account data can make the bot sign in with any user name and password they
choose. They still reach only the sites the Site Login allows, with the approved steps.
