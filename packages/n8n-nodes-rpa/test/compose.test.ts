// The compose stacks as files: what a live proof showed and no other test reads (audit 2026-11-16, F7: behaviours 53 and
// 54). Read as text, the way readme.test.ts reads docker-compose.yml; no Docker is started.
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const STACKS = ['docker-compose.yml', 'docker-compose.queue.yml'] as const;

/** One service's block: from `  <name>:` to the next line indented by two spaces or less. */
function service(compose: string, name: string): string {
  const block = new RegExp(`^ {2}${name}:\\n(?:(?: {4}.*)?\\n)+`, 'm').exec(compose)?.[0];
  expect(block, `service ${name}`).toBeDefined();
  return block ?? '';
}

/** Compose's own substitution for the forms used here: ${VAR:-default} and ${VAR}. */
function substitute(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] || (fallback ?? ''));
}

/** The n8n editor's published port mapping and N8N_WEBHOOK_URL of a stack file, as written. */
function n8nAddress(compose: string) {
  const urls = [...compose.matchAll(/^\s*N8N_WEBHOOK_URL:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const ports = [...service(compose, 'n8n').matchAll(/^\s*- "([^"]*):5678"/gm)].map((m) => m[1]);
  return { urls, ports };
}

describe('the compose stacks', () => {
  it('the compose stacks set N8N_WEBHOOK_URL to the address they publish n8n at', () => {
    const variables: string[] = [];
    for (const [file, fallback] of [['docker-compose.yml', '5678'], ['docker-compose.queue.yml', '35678']] as const) {
      const compose = read(file);
      const { urls, ports } = n8nAddress(compose);
      expect(urls.length, `${file}: N8N_WEBHOOK_URL`).toBeGreaterThan(0);
      expect(ports, `${file}: one published editor port`).toHaveLength(1);
      // Never WEBHOOK_URL alone: n8n 2.45 prefers N8N_WEBHOOK_URL, and an override that sets only the old name is ignored.
      expect(compose, file).not.toMatch(/^\s*WEBHOOK_URL:/m);
      // One variable, with today's value as its default, in the published port and in every N8N_WEBHOOK_URL.
      const port = /^127\.0\.0\.1:\$\{([A-Z0-9_]+):-(\d+)\}$/.exec(ports[0]);
      expect(port, `${file}: the published port comes from one variable (${ports[0]})`).not.toBeNull();
      const [, variable, byDefault] = port ?? [];
      expect(byDefault, file).toBe(fallback);
      for (const url of urls) expect(url, file).toBe(`http://localhost:\${${variable}:-${fallback}}/`);
      variables.push(variable);
      // As compose resolves them: unset, set in .env, set to an empty value. The URL's port is the published port every time.
      for (const env of [{}, { [variable]: '48510' }, { [variable]: '' }] as Record<string, string>[]) {
        const published = substitute(ports[0], env);
        const at = new URL(substitute(urls[0], env));
        expect(['localhost', '127.0.0.1'], `${file} ${JSON.stringify(env)}`).toContain(at.hostname);
        expect(published, `${file} ${JSON.stringify(env)}`).toBe(`127.0.0.1:${at.port}`);
      }
    }
    // The queue stack runs beside the default one from the same folder and .env: a port set for one leaves the other's alone.
    expect(new Set(variables).size).toBe(2);
    expect(read('.env.example')).toMatch(new RegExp(`^# ${variables[0]}=5678$`, 'm'));
    expect(read('.env.example')).toContain(variables[1]);
    expect(read('docs/guides/browser-bot.md')).toContain(`set \`${variables[0]}\` in \`.env\``);
    // No other compose file of the repository publishes n8n or names its webhook address: nothing can disagree with these two.
    for (const file of readdirSync(new URL('.', root)).filter((f) => /^docker-compose.*\.ya?ml$/.test(f) && !(STACKS as readonly string[]).includes(f))) {
      const compose = read(file);
      expect(compose, file).not.toMatch(/WEBHOOK_URL/);
      expect(compose, file).not.toMatch(/:5678"/);
    }
  });

  it('the compose stacks keep Mailpit\'s mail in a volume', () => {
    const compose = read('docker-compose.yml');
    const mailpit = service(compose, 'mailpit');
    const database = /^\s*MP_DATABASE:\s*(\S+)\s*$/m.exec(mailpit)?.[1];
    expect(database, 'MP_DATABASE under mailpit').toBeDefined();
    const directory = posix.dirname(database ?? '');
    const mount = /^\s*- ([a-z0-9_]+):(\/\S*)\s*$/m.exec(mailpit);
    expect(mount, 'a named volume mounted in mailpit').not.toBeNull();
    const [, volume, target] = mount ?? [];
    expect(target, `the volume is mounted at ${directory}`).toBe(directory);
    expect(/^volumes:\n(?:(?: {2}.*)?\n)+/m.exec(compose)?.[0], `${volume} is a named volume`).toMatch(new RegExp(`^ {2}${volume}:`, 'm'));
    // The queue file is used on top of docker-compose.yml: its mailpit changes only the port, so it keeps the same database
    // and volume (an `environment` or `volumes` there would replace or reset them).
    const queue = read('docker-compose.queue.yml');
    expect(queue).toContain('-f docker-compose.yml');
    const queueMailpit = service(queue, 'mailpit');
    expect(queueMailpit).not.toMatch(/^\s{4}(environment|volumes):/m);
    expect(queueMailpit).toMatch(/^\s{4}ports:/m);
  });
});
