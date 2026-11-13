# Security reference

This page says what a run may do, what signing and approval cover, where secrets live, and the risks the project
accepts. It describes what the software does. It does not promise that nothing can go wrong: read it as the rules you
can check, and report a gap as [`SECURITY.md`](../../SECURITY.md) describes.

**Contents:** [Browser runs](#browser-runs) · [Settings you must type](#settings-you-must-type) ·
[Signing and approval](#signing-and-approval) · [Secret variables](#secret-variables) ·
[If the signing key is lost or changed](#if-the-signing-key-is-lost-or-changed) · [Desktop runs](#desktop-runs) ·
[Accepted risks](#accepted-risks)

## Browser runs

A run can do only what this table says. A POST you list in **Requests That Only Read** on the RPA Site Login is taken on trust: it passes without any check of what it sends (see [Sites that post to read](#sites-that-post-to-read)).

| Operation | Sites the browser may open | What it may send | Secrets |
|---|---|---|---|
| Screenshot, Get Page, Save as PDF, Extract Data, Download File | The URL's site plus **Also Allow These Sites**. Files for the page (images, styles, scripts) may come from any public site when **Also Allow These Sites** is empty and **Allow Private Network** is off. Otherwise only from the allowed sites. | Nothing. Only GET, HEAD and OPTIONS leave the browser. Blocked background writes are listed in `blockedRequests` and do not fail the run. A write that navigates the page fails `policy_violation`. | None. |
| Fill and Submit Form | The URL's site plus **Also Allow These Sites**. Files only from those sites. | At most 3 POST requests during the submit click, each to the URL's site or an allowed site. | The values you typed. Password fields are refused. |
| Run Steps, unsigned, no Site Login | The Start URL's site plus **Also Allow These Sites**. Files for the page may come from any public site when **Also Allow These Sites** is empty and **Allow Private Network** is off. | Nothing, unless the steps declare a `submit` to an allowed site and **Allow Unsigned Writes** is on. That form only while its own step runs, at most 3 times. | None. `signIn` needs a Site Login. |
| Run Steps, signed, no Site Login | As unsigned. | Only the `submit` and `download.via` targets the signed steps declare, on allowed sites, matched exactly, each only while its own step runs. Any other write fails `policy_violation`. | None. |
| Run Steps with a Site Login | Only the sites in the credential (**Sites the Browser May Open**, files from **Sites It May Load Files From**, frames from **Sites Allowed in Embedded Frames**). | Only the forms the steps declare that the credential lists (**Forms It May Submit**), matched exactly, each only while its own step runs. POSTs listed in **Requests That Only Read** pass in every run and are listed in the approval evidence: what they send is not checked. | The username, password and TOTP secret reach the page only through a `signIn` step on a page listed under **Pages Where the Password May Be Typed** (with `next`, both of its pages). |
| Sign Steps | No browser. | Nothing. | The Step Signing key signs. It does not appear in an output. |
| Import Steps | As Run Steps. | Nothing. Imported steps that submit a form or download through a form post are refused before the browser opens, and every write is blocked. Rows and files from these runs are never delivered. | Values typed in the recording are never imported. The Site Login's secrets reach the page only through the imported `signIn` step. |

**What every browser run does.**
- It blocks a site on your own network (loopback, private, link-local, shared address space) as a literal address, as
  a name that resolves to one, and on every redirect hop, unless **Allow Private Network** is on. The checks run in
  n8n's process ([Operator guide](operator.md#address-checks-run-in-n8n)).
- It allows only `http` and `https`, and refuses a URL with a user name or password in it.
- Pages cannot start shared workers or open WebRTC, WebSocketStream or WebTransport connections, so every request goes
  through the checks above.
- It masks every secret of the run (Site Login secrets, secret variables, the endpoint token, the signing key) in text
  outputs, errors, logs and traces, in its raw form and in the usual encodings. With a secret on the page, a
  `screenshot` or `pdf` step fails `policy_violation` (`the page shows a credential`).
- It saves traces on failure with cookies, authorization headers, storage, binaries and login bodies removed. Values
  you type into forms stay in the trace: set **Debug Trace** to Never for sensitive forms.
- Limits: 10,000 rows, screenshots 16,384 px tall and 50 MB, downloads 50 MB by default and 200 MB at most, 250 MB of
  files per item, 100 input items, 600 seconds per run. A limit that is hit fails `incomplete` and names the limit.

### Sites that post to read

Some sites post on every screen, even to read: SAP GUI for HTML and Fiori are examples. List each such endpoint in
**Requests That Only Read** on the RPA Site Login, as `POST host/path`, one per line. A `*` matches letters, digits and `_ . ( ) = ~ -`
(and `%3D`, an encoded `=`) within one part of the path. It does not match `/`, `;`, `\` or another `%` code, so write
an SAP Gateway path such as `ZSRV;v=0002` out in full. Examples: `POST sap.example.com/sap*/bc/gui/sap/its/webgui` and
`POST sap.example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch`.

On SAP these endpoints also carry saves. The web GUI sends every action, Save and Post included, as a POST to the
same `…/its/webgui` URL, and Fiori saves through OData `$batch` change sets on the URL it reads through. Listing an
endpoint leaves no write protection for it, in every run. The real control is on the SAP side: give the RPA Site
Login an SAP user with display-only authorizations, and review every repair before you approve it. Name the exact
OData service: a `*` in place of the service name covers every OData service on the host. The approval evidence lists the read-only entries the proof run used, and Sign Steps checks them against the RPA Site Login selected on it.

The web GUI's own login page belongs in **Pages Where the Password May Be Typed**, as the exact host/path the browser shows.
A login page under a per-session `/sap(…)/` path cannot be listed there. Check this on your own SAP system before you
rely on the sign-in.

### Two-page sign-ins

When a `signIn` step uses `next`, list both the username page and the password page in **Pages Where the Password May Be Typed**:
the username is a secret too. After `next`, the engine checks the new page again and stops before the password is
typed if that page is not listed. Pages that receive a form POST later in the sign-in, such as a code page, a "Stay signed in?" answer
or an identity provider's post back to the site, belong in the list too, or the POST fails `policy_violation`.
The address bar does not show where a form posts: if a run stops with "signIn refused: the username field's form posts to <host/path> ...", add that host/path to the list.
Single-page identity providers may also POST the username in the background when **Next** is clicked (Microsoft
Entra's `GetCredentialType` is one): declare that path as a login page too (or in **Requests That Only Read**), or the run fails `policy_violation`.

## Settings you must type

Seven settings must be set directly on the node. Set with an expression, they are a configuration error, so item data
cannot switch them: **Require Signed Steps**, **Allow Private Network**, **Allow Unsigned Writes**, **Deliver
Unconfirmed Rows**, Run Steps' **Login Breaker Reset Key**, **One-Time Code Workflow**, and Sign Steps' **Approver
Allowlist**. If the whole Options collection is set with one expression, n8n drops it before the node runs, and these
switches stay off. Type the RPA Browser credential's Endpoint URL, Token and Certificate Fingerprint directly too.

## Signing and approval

**Signing.** A signature is an HMAC with the **RPA Step Signing** key over the steps, their name, version and start
site, the RPA Site Login's credential ID, and the approver. Run Steps with **Require Signed Steps** on (the default)
runs a step list only when its signature verifies and its version equals **Expected Version**. An edited row in the
`playwright_steps` Data Table fails `script_untrusted` and nothing runs. Desktop signatures bind the app, not a Site
Login.

**One bot, many accounts.** A Site Login whose username and password are expressions signs in with each item's account under one signature, and the passwords then travel through the workflow's items, where whoever can open its executions can read them ([One bot, many accounts](../guides/many-accounts.md#what-it-means-for-secrets)).

**Who holds the key.** Anyone who knows the signing key can sign steps. `npx n8n-nodes-rpa setup` therefore uses only
an **RPA Step Signing** credential that its own project owns, and never one of the same name made by another user.

**Approval.** Nothing an import or an AI repair makes runs until a person approves it and Sign Steps signs it.
- **On the form (the default).** In **RPA: 5 Import a bot**, the person who imports reviews every step list on the next
  page of the form and chooses **Approve and sign** or **Reject**. Who can approve depends on how the form signs
  people in:
  - **n8n's sign-in (the default).** The form opens only for n8n users who may run the workflow. Every later page
    asks for an n8n sign-in too, but any signed-in n8n user who has a page's address can open and submit it. A later
    page's address, such as the review page's `/form-waiting/<execution>?signature=…`, carries a signature n8n made,
    so the execution number alone does not open it. A signed-in user who has the whole address can read the steps
    there; approving still needs a place on the Approver Allowlist. So the
    approver is the n8n user who submits **Review and approve**, as n8n reports it. Sign Steps signs only when that
    user is on **Sign steps → Approver Allowlist**, and the row records their n8n address. Nobody signed in, or a user
    not on the list, signs nothing. Removing a person from n8n, or from the list, ends their access. An n8n user who
    may not run the workflow gets n8n's own page, "Authorization unavailable. You do not have sufficient permissions to
    authorize this request.", and nothing is imported. To let them import, the owner shares the workflow with them
    (**Share** on the workflow) or moves it to a project they belong to.
  - **Basic Auth (`--form-login basic`, for approvers with no n8n account).** Anyone who has the form's user name and
    password can open the form. The pages after the first are not behind the password: anyone who has a page's
    address can open and submit it, and n8n puts that address in the browser's address bar. The row records the
    address in **Sign steps → Approver Allowlist**, not who approved.
- **The form's address.** The setup command gives the form a readable address, `/form/rpa-import`, so that it can be
  typed on another machine. The address is not a secret: the form's sign-in decides who can open it, in both ways
  above, and the pages after the first keep their own addresses, which n8n signs.
- **Values in the form's address.** n8n fills the fields of every page of a form, the review page too, from the
  address the form was opened with. So the import form refuses an address that carries values, before anything is
  read or imported, and an approval never arrives with its answer chosen by whoever made the link.
- **By email (an option).** Set `approval` to `by email` in template 5's **Settings**, and each step list goes to
  **RPA: 3 Approve steps**, which emails a named approver. The approval link is a bearer link: anyone who receives or
  forwards it can approve. Send it to one person. The AI repairs of **RPA: 2 Data feed** use this path. In both
  approval emails, each `<`, `>` and `&` from the steps or the page is shown as `‹`, `›` and `＆`, so that no text from
  them is read as markup by the email. An address in that text has an invisible space inside `://` and after each dot,
  so most mail programs do not make a link of it. A copied address carries those spaces: read the address on the
  review page, or in the steps in n8n.
- **What each step says.** The review page builds each step's sentence from the step itself: what it does, where, and
  the value it types or chooses. A secret's or a variable's value is never shown. A variable is marked from what the step
  types or chooses, never from its description. A step's description comes from
  whoever wrote the steps. When it says something else than the sentence, it is shown beside it in grey, as `(the
  author calls it: …)`. It is shown in red, as `(described differently as: …)`, when its first word names another kind
  of action than the step does (for example "Read" on a step that clicks), or when it names a site that is not the
  step's own or the start site. The red mark catches a description that names another action or site. It does not
  judge the rest of the words: the sentence built from the step is what will run, whatever the description says. The
  approval emails show the same sentences and the same marks. Sign Steps refuses to sign when the step sentences shown for approval differ from the steps it is asked to sign.
- **Desktop writes.** The review page asks "Which of these steps save, send or submit?". The ticked steps are signed as
  writes. A write mark only matters where the runner's policy lists the control or key (see [Desktop runs](#desktop-runs)).
- **Changing or signing again on the form.** With **Bot file** left empty, the form's next page shows the steps of the
  `active` row of the name typed, and a name it does not find ends on a page that lists every approved bot's name.
  With its box left empty, the steps signed again are the row's own, read in n8n: they do not pass through the browser.
  What comes back from that page is a new import: the same review page, the same checks by Sign Steps, the approver on
  the allowlist, and a new row that supersedes the old one only when it is approved. Nothing is signed again without a
  person's approval. Those pages are later pages of the form, as the review page is:
  - With n8n's sign-in, only n8n users who may run the workflow reach them through the form. Any signed-in n8n user
    who has a page's address can open it and read the steps or the names.
  - With Basic Auth, anyone who has the form's password reaches them, and anyone who has a page's address can open it.

  Sign Steps refuses steps that hold a Site Login secret, and a secret variable appears in steps only by its name.
  Steps still show the sites, apps and fields they use and the other values they type. The page says who can open it.
  The review page's first line, worked out in n8n from the row it read, says whether, where and how the steps submitted
  differ from the approved version, so a slip in the box shows before anyone approves.
- **An old key or an edit.** A row signed with an older key and a row changed in the Data Table after it was approved
  look the same to the current key: neither verifies, and the old key is gone. The row's `hash` column is not keyed,
  so whoever changed the steps could also change it. The form therefore cannot refuse an edited row. It says so on
  the page, and the person approves the steps as the review page shows them, every step in full.

## Secret variables

The **RPA Secret Variables** credential holds name and value pairs for passwords and other secrets that steps type as
`{{var.name}}`. Run Steps masks every value from the start of the run in outputs, errors, traces, screenshots and what
a chat model sees. Only signed steps type one: in the browser a `fill` with `secret: true`, on the desktop a `fill` of
exactly `{{var.name}}`. Any other use of a value is refused. Each value must be at least 4 characters.

**Where its values may be typed.** The credential is not tied to the steps that were approved. A signature binds the
steps, not the secret variables that a workflow attaches.
So whoever can approve steps, and can select this credential on a Run Steps node, chooses where its values go. With
approval on the import form, that is anyone who can open the form. The credential's optional field **May Be Typed
Into** lets the owner of the secrets limit that. List one entry per line:
- an app's program file name for desktop steps, such as `ErpDemo.exe` (compared without case, by file name, as the
  runner compares it),
- a site's exact host for browser steps, such as `erp.example.com` (read as Also Allow These Sites reads a host: no
  wildcards, no path, a port only when it is not the default one).

With the field filled, a desktop run of an app that is not listed is refused before the app starts. A browser step
that would type one of the credential's values is refused before it types, unless the page's host and the host of
the frame that holds the field are both listed. The check looks at the value, not the variable's name, so the same
value under another name is checked too. Both refusals are `policy_violation` and name the field and the app or
host. A line that is neither an app nor a host stops the run before it starts. Empty, the field limits nothing, as
before.

What it does not do:
- A listed app or site gets the values. A field there that saves a value where someone else can read it is still
  reachable by approved steps.
- It does not limit the RPA Site Login. Its password goes only to its own Pages Where the Password May Be Typed.
- Whoever can edit this credential can change the list.

We recommend:
- Fill in May Be Typed Into with the apps and sites the secrets belong to. A site that signs in on another host than
  it works on needs both hosts.
- Share an RPA Secret Variables credential only with people you would trust with its values.
- Keep the import form, and the workflows that run bots, with those people, or turn on approval by email so that a
  second person approves.

## If the signing key is lost or changed

Every signed step list is bound to the key. When the RPA Step Signing key changes, or the credential is lost (for
example with n8n's encryption key), every signed row stops: Run Steps fails `script_untrusted` and runs nothing. The
same happens when workflows move to another n8n, because the Site Login's credential ID changes.

To sign the step lists again with the new key:
1. Make a new key: run `npx n8n-nodes-rpa setup --replace-signing-key` at a terminal and type `REPLACE` when it
   asks. It replaces the key in the **RPA Step Signing** credential and shows the new one once. By hand instead,
   create the credential with a new key of 32 or more random characters, and select it on **Sign steps** in template
   5 (and template 3) and on every **Run steps** node.
2. For each bot, open the **Import a bot** form, leave **Bot file** empty and type the bot's name. The next page
   shows the steps of its `active` row. Leave the box empty and click **Review**: the row's steps go to the import as
   a **Step document**.
3. Read every step on the review page. Browser steps are replayed, desktop steps go to approval as written. Steps
   that were signed as writes come back as candidates: tick them again.
4. Approve. The new row supersedes the old ones under that name, and the bot runs again.

The form cannot tell a row signed with the old key from a row changed in the Data Table since it was approved (see
[An old key or an edit](#signing-and-approval)). Approve only steps you have read.

Keep a copy of the key where you keep other recovery secrets, so that a lost n8n does not mean re-approving every bot.

## Desktop runs

A browser run is held to a list of allowed sites on every request. A desktop app talks to its own back ends, which
the runner cannot filter. What holds is the runner's local policy on the Windows machine
(`C:\ProgramData\RPA Runner\policy.json`, which only administrators can change): the allowed apps, the write controls,
the gated keys and the export folder. n8n cannot switch it off.

- The runner starts only the apps its policy lists, at the path the policy names.
- A step marked `"write": true` may use a write control or gated key. The runner refuses those without the mark. Until
  an app's write controls and keys are in the policy, the runner gates no write in it.
- Whoever holds the RPA Desktop Runner credential can do whatever a marked write could do in the allowed apps. Protect
  it as you would the n8n instance.
- The installer adds the browser beside the runner only with `-WithBrowser`. With it, whoever holds the browser token
  acts as the bot user through the browser, which the runner's policy does not limit. Add it only when your bots need a
  browser on that machine. The [Windows guide](../install/windows.md#who-can-reach-the-ports) says more.
- In the mode where nobody is signed in, the supervisor signs the bot user in when a connection arrives at the
  runner's port (or the browser's, when it is installed). It does not read the connection or check the sender's
  address first, and the token is checked afterwards by the runner or the browser. So anyone who can reach those ports
  can cause a sign-in and keep the session open for a while, but cannot run anything without the token. The firewall
  rule's `-AllowFrom` addresses are the only limit on who can do that. Give it only n8n's address.

## Accepted risks

- **One shared signing key.** Whoever can verify signed steps holds the key and could sign. Share the Step Signing
  credential only with the owners of the workflows that run and approve steps.
- **GET side effects.** A page can change something when it is opened. During AI repair and its proof, an address that
  names a destructive action (`cancel`, `delete`, `pay`, `purge`) ends the run, but an ordinary-looking address is not
  detected.
- **DNS lookups.** A remote browser may look up a host name a page mentions, so the name can reach a DNS server. No
  connection is made to it.
- **Data Table write access** lets someone switch a bot back to an earlier approved version. They cannot create a new
  one. Limit who can edit Data Tables in the project.
- **Secrets drawn inside images or canvas** are not detected. Closed shadow roots, canvas and images cannot be checked
  before a capture. Only text the page shows is checked.
- **Evidence, change lists and step intents are as the run reported them.** Sign Steps recomputes the hosts, forms,
  downloads and pop-up handlers of browser steps, but a Repaired steps item from another workflow can claim evidence
  no proof produced. Approve only items from your own import and data-feed workflows, and read the steps against the
  safety flags.
- **Retries.** A submit is not idempotent: **Retry On Fail** sends it again.
