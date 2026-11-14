// The setup command's other way in: n8n's own command line, run where n8n runs (inside its container), with no API key.
// n8n 2.45's commands used: export:credentials and export:workflow (lists, never --decrypted), import:credentials and
// import:workflow (from a file this module writes and removes), publish:workflow. Each call starts a whole n8n (about
// 1 to 2 seconds) that works on n8n's database directly; the running n8n picks a publish up by itself within seconds.
//
// What n8n's command line does not check, and this module does before any write:
// - The database. Run as another user, or with another HOME or N8N_USER_FOLDER, n8n's command line quietly makes and
//   uses a new empty database. checkSameN8n proves that the database the command line opens is the running n8n's.
// - Overwrites. import:credentials and import:workflow replace a credential or workflow of the same id without asking
//   (and an import over a published workflow takes its form down). New ids are random and checked to be free first.
//
// - Who owns what. export:credentials does not say which project owns a credential, and --projectId lists those shared
//   into a project too. Cli.ownership reads it from n8n's own tables instead (see there).
//
// Secrets: a credential reaches n8n only through a file of mode 0600 in a directory of mode 0700 made for it, on a memory
// file system when there is one (/dev/shm), removed right after the import, also when it fails or the process is
// stopped. No secret is ever in a command's arguments, and the children get this process's environment without the
// setup command's own secrets (the API key, a Connection Line, the browser token).
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';

/** The setup command's own secrets: never handed on to n8n's command line. */
const OWN_SECRETS = ['N8N_API_KEY', 'RPA_CONNECTION_LINE', 'RPA_BROWSER_TOKEN'];
/** Settings that choose n8n's database, its encryption key and its folder: the command line must see the running n8n's. */
const SAME_SETTINGS = /^(DB_[A-Z0-9_]+|N8N_ENCRYPTION_KEY(_FILE)?|N8N_USER_FOLDER(_FILE)?|HOME|N8N_CONFIG_FILES|EXECUTIONS_MODE|N8N_MULTI_MAIN_SETUP_ENABLED)$/;
const CALL_TIMEOUT_MS = 180_000;

/** The n8n command on PATH: the first executable file named n8n, or undefined. */
export function findN8n(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, process.platform === 'win32' ? 'n8n.cmd' : 'n8n');
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** This process's environment for n8n's command line, without the setup command's own secrets. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!OWN_SECRETS.includes(name) && value !== undefined) out[name] = value;
  return out;
}

export type SameN8n =
  | { ok: true; database: string }
  | { ok: false; why: string };

/** n8n's folder as n8n computes it (@n8n/config getN8nFolder): N8N_USER_FOLDER, else HOME, else the working directory, then .n8n. */
export const n8nFolderOf = (env: Record<string, string | undefined>, cwd: string) => join(env.N8N_USER_FOLDER ?? env.HOME ?? cwd, '.n8n');

function readEnviron(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readFileSync(file).toString('utf8').split('\0')) {
    const at = entry.indexOf('=');
    if (at > 0) out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

/**
 * Proves, reading only, that n8n's command line here works on the database of the n8n that runs here. What it proves:
 * 1. exactly one n8n main process runs on this machine (Linux /proc: its title is "n8n" or "n8n start");
 * 2. it runs as the same user as this command;
 * 3. the settings that choose the database, the encryption key and n8n's folder (every DB_* variable,
 *    N8N_ENCRYPTION_KEY, N8N_USER_FOLDER, HOME, N8N_CONFIG_FILES, EXECUTIONS_MODE, N8N_MULTI_MAIN_SETUP_ENABLED and
 *    their _FILE forms) have the same values in its environment as in this one, and n8n's folder is the same;
 * 4. with SQLite (n8n's default), the running process has the very file open that the command line will open (the same
 *    device and inode). With Postgres, the same DB_POSTGRESDB_* settings are the proof: same host, port, database,
 *    schema and user.
 * Values are compared, never shown: a difference is named by its variable only.
 * procRoot is /proc; the tests give a made-up one (a Linux /proc cannot be made on another system).
 */
export function checkSameN8n(env: NodeJS.ProcessEnv, cwd: string, procRoot = '/proc'): SameN8n {
  if (procRoot === '/proc' && process.platform !== 'linux') return { ok: false, why: `this command runs on ${process.platform}, and the check that it works on the running n8n's database needs Linux` };
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  } catch {
    return { ok: false, why: 'this command cannot see the processes of this machine' };
  }
  const mains: number[] = [];
  for (const pid of pids) {
    let title: string;
    try {
      title = readFileSync(join(procRoot, pid, 'cmdline')).toString('utf8').split('\0').filter(Boolean).join(' ').trim();
    } catch {
      continue;
    }
    // n8n's bin sets its title to "n8n <command>" (packages/cli/bin/n8n): the main is "n8n" or "n8n start".
    if (title === 'n8n' || title === 'n8n start') mains.push(Number(pid));
  }
  if (!mains.length) return { ok: false, why: 'no running n8n is visible here' };
  if (mains.length > 1) return { ok: false, why: `${mains.length} n8n processes run here (process ids ${mains.join(', ')}), and this command cannot tell which one serves your n8n` };
  const pid = mains[0];
  const dir = join(procRoot, String(pid));
  let uid: number | undefined;
  try {
    const line = /^Uid:\s+(\d+)\s+(\d+)/m.exec(readFileSync(join(dir, 'status'), 'utf8'));
    if (line && line[1] === line[2]) uid = Number(line[1]);
  } catch {
    // unknown
  }
  const myUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined || myUid === undefined || uid !== myUid) {
    return { ok: false, why: `n8n runs here as another user${uid !== undefined ? ` (user id ${uid})` : ''} than this command${myUid !== undefined ? ` (user id ${myUid})` : ''}` };
  }
  let theirs: Record<string, string>;
  let theirCwd: string;
  try {
    theirs = readEnviron(join(dir, 'environ'));
    theirCwd = readlinkSync(join(dir, 'cwd'));
  } catch {
    return { ok: false, why: "this command may not read the running n8n's settings" };
  }
  const mine = env as Record<string, string | undefined>;
  const names = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])].filter((n) => SAME_SETTINGS.test(n)).sort();
  const differ = names.filter((n) => (theirs[n] ?? undefined) !== (mine[n] ?? undefined));
  if (differ.length) return { ok: false, why: `the running n8n and n8n's command line here would differ in ${differ.join(', ')}` };
  if (resolve(n8nFolderOf(theirs, theirCwd)) !== resolve(n8nFolderOf(mine, cwd))) return { ok: false, why: "the running n8n and n8n's command line here would use different n8n folders" };
  if (/^queue$/i.test(theirs.EXECUTIONS_MODE ?? '') || /^true$/i.test(theirs.N8N_MULTI_MAIN_SETUP_ENABLED ?? '')) {
    return { ok: false, why: 'n8n runs in queue mode, and the way through n8n\'s command line is not built for queue mode' };
  }
  const type = (theirs.DB_TYPE ?? 'sqlite').toLowerCase();
  if (type === 'postgresdb') {
    return { ok: true, database: `Postgres database ${theirs.DB_POSTGRESDB_DATABASE ?? 'n8n'} on ${theirs.DB_POSTGRESDB_HOST ?? 'localhost'}` };
  }
  if (type !== 'sqlite') return { ok: false, why: `n8n uses the database type ${type.replace(/[^\w-]/g, '').slice(0, 20)}, and the way through n8n's command line is built for SQLite and Postgres only` };
  const file = resolve(n8nFolderOf(mine, cwd), mine.DB_SQLITE_DATABASE ?? 'database.sqlite');
  let want;
  try {
    want = statSync(file);
  } catch {
    return { ok: false, why: `there is no database at ${file}, the one n8n's command line here would use` };
  }
  let fds: string[] = [];
  try {
    fds = readdirSync(join(dir, 'fd'));
  } catch {
    return { ok: false, why: "this command may not see which files the running n8n has open" };
  }
  for (const fd of fds) {
    try {
      const s = statSync(join(dir, 'fd', fd));
      if (s.dev === want.dev && s.ino === want.ino) return { ok: true, database: file };
    } catch {
      // closed meanwhile, or not a file
    }
  }
  return { ok: false, why: `the running n8n does not have ${file} open, so n8n's command line here would use another database` };
}

/** Directories holding a secret file right now: removed on every way out, also when the process is stopped. */
const secretDirs = new Set<string>();
export function removeSecretDirs() {
  for (const dir of secretDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing more can be done here
    }
    secretDirs.delete(dir);
  }
}
// On 'exit' too: the setup command's signal handlers end with process.exit, which runs this.
let guarded = false;
function guardExit() {
  if (guarded) return;
  guarded = true;
  process.on('exit', removeSecretDirs);
}

/** A memory file system when there is one (Linux /dev/shm), else the system's temporary folder. */
function secretBase(): string {
  try {
    if (statSync('/dev/shm').isDirectory()) {
      accessSync('/dev/shm', constants.W_OK);
      return '/dev/shm';
    }
  } catch {
    // none here
  }
  return tmpdir();
}

/**
 * Writes text to a file only this user can read (0600, in a new directory of mode 0700), runs use(path), and removes the
 * directory afterwards, whatever happens.
 */
export async function withSecretFile<T>(text: string, use: (path: string, dir: string) => Promise<T>): Promise<T> {
  guardExit();
  const dir = mkdtempSync(join(secretBase(), 'rpa-setup-'));
  secretDirs.add(dir);
  try {
    const file = join(dir, 'import.json');
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return await use(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    secretDirs.delete(dir);
  }
}

/** n8n's AES-256-CBC with a passphrase (n8n-core CipherAes256CBC: "Salted__", an 8-byte salt, MD5 key derivation). */
function decryptCbc(data: string, passphrase: string): string {
  const input = Buffer.from(data, 'base64');
  const salt = input.subarray(8, 16);
  const password = Buffer.concat([Buffer.from(passphrase, 'binary'), salt]);
  const h1 = createHash('md5').update(password).digest();
  const h2 = createHash('md5').update(Buffer.concat([h1, password])).digest();
  const iv = createHash('md5').update(Buffer.concat([h2, password])).digest();
  const decipher = createDecipheriv('aes-256-cbc', Buffer.concat([h1, h2]), iv);
  return Buffer.concat([decipher.update(input.subarray(16)), decipher.final()]).toString('utf8');
}

/** Who owns what in n8n, as its own tables say. */
export interface Ownership {
  owner: { id: string; email?: string };
  /** The owner's personal project: where import:credentials and import:workflow put what they import by default. */
  ownerProject: { id: string; name: string; type: string; creatorId: string | null };
  projects: Map<string, { id: string; name: string; type: string; creatorId: string | null }>;
  /** Each credential's projects with the role there (credential:owner, credential:user). */
  credentials: Map<string, { projectId: string; role: string }[]>;
  workflows: Map<string, { projectId: string; role: string }[]>;
}

/** An id as n8n makes them: 16 letters and digits. */
export function newId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(16)].map((b) => abc[b % abc.length]).join('');
}

/** A problem n8n's command line reported: its words, redacted and cut, never a raw dump. */
export class CliError extends Error {}

export interface Cli {
  /** Every credential, by id, name and type only (n8n lists them encrypted; the encrypted data is dropped at once). */
  listCredentials(): Promise<{ id: string; name: string; type: string }[]>;
  /** Who owns what (see createCli's ownership). */
  ownership(): Promise<Ownership>;
  credentialExists(id: string): Promise<boolean>;
  /** Every workflow, with its nodes, whether it is published, and the project that owns it (shared[].project). */
  listWorkflows(): Promise<any[]>;
  workflow(id: string): Promise<any | undefined>;
  importCredential(credential: { id: string; name: string; type: string; data: Record<string, unknown> }, projectId?: string): Promise<void>;
  importWorkflow(workflow: Record<string, unknown>, projectId?: string): Promise<void>;
  publish(id: string): Promise<void>;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function createCli({ command, env, redact, clean }: { command: string; env: NodeJS.ProcessEnv; redact: (text: unknown) => string; clean: (text: unknown, fallback?: unknown) => string }): Cli {
  const childEnvironment = childEnv(env);

  function call(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((done, fail) => {
      const child = spawn(command, args, { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => chunks.push(c));
      const timer = setTimeout(() => child.kill('SIGTERM'), CALL_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        fail(new CliError(`n8n's command line did not start (${clean(redact(err.message))}).`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, out: Buffer.concat(chunks).toString('utf8').replace(ANSI, '') });
      });
    });
  }

  /** What n8n said, for a message: its last lines that are not its own start-up notes, redacted and cut. */
  const said = (out: string) => clean(redact(out.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[license SDK\]|^Permissions 0644 for n8n settings file|See log messages for details/.test(l) && !l.startsWith('[{')).slice(-3).join(' ')), 'no message');

  /** The JSON list an export printed (one line, through n8n's logger), or undefined. */
  function exported(out: string): any[] | undefined {
    for (const line of out.split('\n')) {
      const text = line.trim();
      if (!text.startsWith('[{') || !text.endsWith(']')) continue;
      try {
        const value = JSON.parse(text);
        if (Array.isArray(value)) return value;
      } catch {
        // another line
      }
    }
    return undefined;
  }

  async function list(args: string[], none: RegExp, what: string): Promise<any[]> {
    const r = await call(args);
    const items = r.code === 0 ? exported(r.out) : undefined;
    if (items) return items;
    if (none.test(r.out)) return [];
    throw new CliError(`n8n's command line could not list the ${what} (${said(r.out)})`);
  }

  const NO_CREDENTIALS = /No credentials found with specified filters/;
  const NO_WORKFLOWS = /No workflows found with specified filters/;

  return {
    async listCredentials() {
      const items = await list(['export:credentials', '--all'], NO_CREDENTIALS, 'credentials');
      return items.map((c) => ({ id: String(c?.id ?? ''), name: String(c?.name ?? ''), type: String(c?.type ?? '') }));
    },
    /**
     * Who owns what: n8n's own tables user, project, project_relation, shared_credentials and shared_workflow, from
     * export:entities, the command line's export of every table. The export goes to a directory of mode 0700 made for it,
     * encrypted with a random key this run makes (--keyFile, a 0600 file beside it), and is removed right after. Only the
     * five tables are opened and decrypted with that key, and only these columns kept: a user's id, email and role, a
     * project's id, name, type and creator, each sharing's credential or workflow, project and role. No credential's data
     * is decrypted (n8n keeps it encrypted with its own key inside the export, and this run never opens that table).
     */
    async ownership() {
      const key = randomBytes(32).toString('hex');
      const tables = await withSecretFile(key, async (keyFile, dir) => {
        const out = join(dir, 'export');
        const r = await call(['export:entities', `--outputDir=${out}`, `--keyFile=${keyFile}`, '--includeDataTableRows=false']);
        let zip: Buffer;
        try {
          zip = readFileSync(join(out, 'entities.zip'));
        } catch {
          throw new CliError(`n8n's command line did not export who owns what (${said(r.out)})`);
        }
        const wanted = /^(user|project|projectrelation|sharedcredentials|sharedworkflow)(\.\d+)?\.jsonl$/;
        const files = unzipSync(new Uint8Array(zip), { filter: (f) => wanted.test(f.name) });
        const rows: Record<string, any[]> = { user: [], project: [], projectrelation: [], sharedcredentials: [], sharedworkflow: [] };
        for (const [name, bytes] of Object.entries(files)) {
          const table = (wanted.exec(name) as RegExpExecArray)[1];
          for (const line of Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean)) {
            for (const row of decryptCbc(line, key).split('\n').filter(Boolean)) {
              const r0 = JSON.parse(row);
              // Only the columns used here: a user row also holds a password hash and settings, never kept.
              rows[table].push(table === 'user' ? { id: r0.id, email: r0.email, roleSlug: r0.roleSlug } : r0);
            }
          }
        }
        return rows;
      });
      const owners = tables.user.filter((u) => u?.roleSlug === 'global:owner');
      if (owners.length !== 1) throw new CliError(`n8n's tables name ${owners.length} owners, so this run cannot tell whose project n8n's command line imports into`);
      const owner = { id: String(owners[0].id), email: typeof owners[0].email === 'string' ? owners[0].email : undefined };
      const projects = new Map<string, Ownership['ownerProject']>(tables.project.map((p) => [String(p.id), { id: String(p.id), name: String(p.name ?? ''), type: String(p.type ?? ''), creatorId: p.creatorId == null ? null : String(p.creatorId) }]));
      const personal = tables.projectrelation.filter((r) => String(r?.userId) === owner.id && r?.role === 'project:personalOwner').map((r) => projects.get(String(r.projectId))).filter((p) => p?.type === 'personal');
      if (personal.length !== 1) throw new CliError("n8n's tables do not name the owner's personal project");
      const shares = (rows: any[], idKey: string) => {
        const map = new Map<string, { projectId: string; role: string }[]>();
        for (const r of rows) map.set(String(r[idKey]), [...(map.get(String(r[idKey])) ?? []), { projectId: String(r.projectId), role: String(r.role) }]);
        return map;
      };
      return { owner, ownerProject: personal[0] as Ownership['ownerProject'], projects, credentials: shares(tables.sharedcredentials, 'credentialsId'), workflows: shares(tables.sharedworkflow, 'workflowId') };
    },
    async credentialExists(id) {
      const r = await call(['export:credentials', `--id=${id}`]);
      if (r.code === 0 && exported(r.out)?.some((c) => String(c?.id) === id)) return true;
      if (NO_CREDENTIALS.test(r.out)) return false;
      throw new CliError(`n8n's command line could not tell whether the credential ${id} exists (${said(r.out)})`);
    },
    async listWorkflows() {
      return list(['export:workflow', '--all'], NO_WORKFLOWS, 'workflows');
    },
    async workflow(id) {
      const r = await call(['export:workflow', `--id=${id}`]);
      const items = r.code === 0 ? exported(r.out) : undefined;
      if (items) return items.find((w) => String(w?.id) === id);
      if (NO_WORKFLOWS.test(r.out)) return undefined;
      throw new CliError(`n8n's command line could not read the workflow ${id} (${said(r.out)})`);
    },
    async importCredential(credential, projectId) {
      const r = await withSecretFile(JSON.stringify([credential]), (file) => call(['import:credentials', `--input=${file}`, ...(projectId ? [`--projectId=${projectId}`] : [])]));
      if (r.code !== 0 || !/Successfully imported 1 credential/.test(r.out)) throw new CliError(`n8n's command line did not import the credential "${clean(credential.name)}" (${said(r.out)})`);
    },
    async importWorkflow(workflow, projectId) {
      const r = await withSecretFile(JSON.stringify(workflow), (file) => call(['import:workflow', `--input=${file}`, ...(projectId ? [`--projectId=${projectId}`] : [])]));
      if (r.code !== 0 || !/Successfully imported 1 workflow/.test(r.out)) throw new CliError(`n8n's command line did not import the workflow "${clean(workflow.name)}" (${said(r.out)})`);
    },
    async publish(id) {
      const r = await call(['publish:workflow', `--id=${id}`]);
      if (r.code !== 0 || /Error|error/.test(said(r.out)) && !/Publishing workflow/.test(r.out)) throw new CliError(`n8n's command line did not publish the workflow ${id} (${said(r.out)})`);
    },
  };
}

interface Answer { status: number; json: any; text: string }
const answer = (status: number, json: unknown): Answer => ({ status, json, text: '' });

/** A workflow as n8n's public API shows one: published when n8n's command line says it has a published version. */
const asApi = (w: any) => (w ? { ...w, active: w.activeVersionId != null || w.active === true } : w);

/**
 * n8n's command line behind the few public API calls the setup command makes, so that both ways share one flow. A call
 * the command line cannot do (test a credential, delete or archive, read a user) answers 501 with the reason. Writes:
 * - POST /credentials and POST /workflows: a new random id, checked to be free first, then imported.
 * - PATCH /credentials/{id}: only for a credential that exists (a replacement the person asked for), imported over it.
 * - PUT /workflows/{id}: only for one that exists (the setup command does this for a workflow it made in this run, or
 *   one the person agreed to bring up to date), imported over it; n8n's import unpublishes it until it is published again.
 * - POST /workflows/{id}/activate: publish:workflow.
 */
export function cliClient(cli: Cli, own: Ownership, redact: (text: unknown) => string, clean: (text: unknown, fallback?: unknown) => string) {
  /** Credential items, with their projects and roles there from n8n's tables, as n8n's public API lists them (shared[]). */
  let credentials: { id: string; name: string; type: string; shared?: unknown[] }[] | undefined;
  const sharedOf = (id: string) => (own.credentials.get(id) ?? []).map((s) => ({ id: s.projectId, role: s.role }));
  const failed = (err: unknown) => answer(500, { message: err instanceof CliError ? err.message : `n8n's command line failed (${clean(redact((err as Error)?.message))})` });

  async function api(method: string, path: string, body?: any): Promise<Answer> {
    const route = `${method} ${path.replace(/\?.*$/, '')}`;
    let m: RegExpExecArray | null;
    try {
      if ((m = /^GET \/workflows\/([^/]+)$/.exec(route))) {
        const w = await cli.workflow(decodeURIComponent(m[1]));
        return w ? answer(200, asApi(w)) : answer(404, { message: 'Not Found' });
      }
      if (route === 'POST /credentials') {
        let id = newId();
        for (let i = 0; i < 3 && (await cli.credentialExists(id)); i++) id = newId();
        if (await cli.credentialExists(id)) return answer(500, { message: 'no free credential id' });
        await cli.importCredential({ id, name: body.name, type: body.type, data: body.data }, body.projectId);
        // n8n's import makes the project it imports into (the owner's personal project by default) the owner.
        own.credentials.set(id, [{ projectId: body.projectId ?? own.ownerProject.id, role: 'credential:owner' }]);
        credentials?.push({ id, name: body.name, type: body.type, shared: sharedOf(id) });
        return answer(200, { id, name: body.name, type: body.type });
      }
      if ((m = /^PATCH \/credentials\/([^/]+)$/.exec(route))) {
        const id = decodeURIComponent(m[1]);
        // Never a new credential under a made-up id: only one that is there is replaced.
        if (!(await cli.credentialExists(id))) return answer(404, { message: 'Not Found' });
        await cli.importCredential({ id, name: body.name, type: body.type, data: body.data });
        return answer(200, { id, name: body.name, type: body.type });
      }
      if (route === 'POST /workflows') {
        let id = newId();
        for (let i = 0; i < 3 && (await cli.workflow(id)); i++) id = newId();
        if (await cli.workflow(id)) return answer(500, { message: 'no free workflow id' });
        await cli.importWorkflow({ id, name: body.name, nodes: body.nodes, connections: body.connections, settings: body.settings, active: false }, body.projectId);
        const w = await cli.workflow(id);
        return w ? answer(200, asApi(w)) : answer(500, { message: 'the imported workflow is not there' });
      }
      if ((m = /^PUT \/workflows\/([^/]+)$/.exec(route))) {
        const id = decodeURIComponent(m[1]);
        if (!(await cli.workflow(id))) return answer(404, { message: 'Not Found' });
        await cli.importWorkflow({ id, name: body.name, nodes: body.nodes, connections: body.connections, settings: body.settings, active: false });
        const w = await cli.workflow(id);
        return w ? answer(200, asApi(w)) : answer(500, { message: 'the imported workflow is not there' });
      }
      if ((m = /^POST \/workflows\/([^/]+)\/activate$/.exec(route))) {
        const id = decodeURIComponent(m[1]);
        await cli.publish(id);
        const w = await cli.workflow(id);
        return w && w.activeVersionId === w.versionId ? answer(200, asApi(w)) : answer(500, { message: "n8n's command line did not publish it" });
      }
      if (/^POST \/credentials\/[^/]+\/test$/.test(route)) return answer(501, { message: "n8n's command line cannot test a credential" });
      // n8n's owner's address, from its user table (the default approver, as an API key's owner is on that way).
      if ((m = /^GET \/users\/([^/]+)$/.exec(route))) return decodeURIComponent(m[1]) === own.owner.id && own.owner.email ? answer(200, { id: own.owner.id, email: own.owner.email }) : answer(404, { message: 'Not Found' });
      return answer(501, { message: `n8n's command line cannot do this (${route.replace(/\/[^/ ]+$/, '/…')})` });
    } catch (err) {
      return failed(err);
    }
  }

  function reason(r: Answer): string {
    const message = typeof r.json?.message === 'string' ? r.json.message : '';
    return clean(redact(message.replace(/\s+/g, ' ')), `status ${r.status}`);
  }

  async function listAll(path: string): Promise<{ ok: true; items: any[] } | { ok: false; response: Answer }> {
    try {
      if (path === '/credentials') {
        credentials ??= (await cli.listCredentials()).map((c) => ({ ...c, shared: sharedOf(c.id) }));
        return { ok: true, items: credentials };
      }
      if (path === '/workflows') return { ok: true, items: (await cli.listWorkflows()).map(asApi) };
      return { ok: false, response: answer(501, { message: 'not a list n8n\'s command line gives' }) };
    } catch (err) {
      return { ok: false, response: failed(err) };
    }
  }

  return { api, reason, listAll };
}
