// A fake of n8n 2.45's command line for test/setup.test.ts: the commands the setup command uses, on a JSON state file
// (FAKE_N8N_STATE) instead of a database, with n8n's own output lines. It records each call's arguments, which of the setup
// command's secrets its environment held (it must hold none), and the mode of each file it imported from.
import { readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.FAKE_N8N_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const [command, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
state.calls.push({ command, args: rest, secretsInEnv: ['N8N_API_KEY', 'RPA_CONNECTION_LINE', 'RPA_BROWSER_TOKEN'].filter((n) => process.env[n] !== undefined) });
const save = () => writeFileSync(file, JSON.stringify(state, null, 1));
// Written at once: on macOS a pipe is written asynchronously, and process.exit would drop the rest.
const out = (line) => writeSync(1, `${line}\n`);
const done = (code) => {
  save();
  process.exit(code);
};
out('[license SDK] Skipping renewal on init: license cert is not initialized');
if (state.fail === command) {
  out('An error occurred while importing. See log messages for details.');
  out('made-up failure');
  done(1);
}

const project = (id) => state.projects[id];
const credentialItem = (c) => ({ id: c.id, name: c.name, type: c.type, data: 'U2FsdGVkX1+madeUpEncryptedData==', isManaged: false });
const workflowItem = (w) => ({
  id: w.id, name: w.name, active: false, isArchived: false, nodes: w.nodes, connections: w.connections, settings: w.settings, versionId: w.versionId,
  activeVersionId: w.activeVersionId ?? null, updatedAt: w.updatedAt,
  shared: [{ role: 'workflow:owner', workflowId: w.id, projectId: w.projectId, project: project(w.projectId) }],
});
let versions = state.calls.length * 1000;

function readInput() {
  const path = String(flags.input);
  const f = statSync(path);
  const d = statSync(dirname(path));
  state.inputs.push({ path, fileMode: (f.mode & 0o777).toString(8), dirMode: (d.mode & 0o777).toString(8) });
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (command === 'export:credentials') {
  const items = state.credentials.filter((c) => (flags.all ? true : flags.id ? c.id === flags.id : flags.projectId ? c.projectId === flags.projectId : false));
  if (!items.length) {
    out('Error exporting credentials. See log messages for details.');
    out('No credentials found with specified filters');
    done(1);
  }
  out(JSON.stringify(items.map(credentialItem)));
  done(0);
}
if (command === 'export:workflow') {
  const items = state.workflows.filter((w) => (flags.all ? true : flags.id ? w.id === flags.id : false));
  if (!items.length) {
    out('Error exporting workflows. See log messages for details.');
    out('No workflows found with specified filters');
    done(1);
  }
  out(JSON.stringify(items.map(workflowItem)));
  done(0);
}
if (command === 'import:credentials') {
  const list = readInput();
  for (const c of list) {
    const had = state.credentials.find((x) => x.id === c.id);
    if (had) Object.assign(had, { name: c.name, type: c.type, data: c.data, updatedAt: `u${++versions}` });
    else state.credentials.push({ id: c.id, name: c.name, type: c.type, data: c.data, projectId: flags.projectId ?? state.ownerProject, updatedAt: `u${++versions}` });
  }
  out(`Successfully imported ${list.length} credential${list.length === 1 ? '.' : 's.'}`);
  done(0);
}
if (command === 'import:workflow') {
  const w = readInput();
  const had = state.workflows.find((x) => x.id === w.id);
  // n8n's import unpublishes a workflow it imports over.
  if (had) Object.assign(had, { name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings, versionId: `v${++versions}`, activeVersionId: null, updatedAt: new Date().toISOString() });
  else state.workflows.push({ id: w.id, name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings, versionId: `v${++versions}`, activeVersionId: null, projectId: flags.projectId ?? state.ownerProject, updatedAt: new Date().toISOString() });
  out('Importing 1 workflows...');
  out('Successfully imported 1 workflow.');
  done(0);
}
if (command === 'publish:workflow') {
  const w = state.workflows.find((x) => x.id === flags.id);
  out(`Publishing workflow with ID: ${flags.id} (current version)`);
  if (!w) {
    out('Error updating database. See log messages for details.');
    done(1);
  }
  w.activeVersionId = w.versionId;
  out('Note: Changes will not take effect if n8n is running.');
  done(0);
}
out(`Command "${command}" not found`);
done(1);
