// Where the values of the run's secret variables may be typed (in n8n, the RPA Secret Variables credential's May Be
// Typed Into). The owner of the secrets sets it in the credential; it is not part of the steps, so no signed step widens it.

/** TaskInput.secretTargets and DesktopTaskInput.secretTargets. Absent: anywhere the steps reach, as before. */
export interface SecretTargets {
  /** Program file names (ErpDemo.exe), compared without case to the file name of a desktop run's app.exe. */
  apps: string[];
  /** Exact hosts as URL.host gives them (lowercase, no default port), compared to the host of the page and of the field's frame. */
  hosts: string[];
}

/** The program file name of app.exe as the runner compares it (Path.GetFileName): after the last \, / or drive colon. */
export const appFileName = (exe: string): string => exe.split(/[\\/:]/).pop() ?? '';

/** Whether a desktop run of `exe` may start with these secret variables: its file name is listed, compared without case. */
export function appListed(targets: SecretTargets, exe: string): boolean {
  const name = appFileName(exe).toLowerCase();
  return name !== '' && targets.apps.some((a) => a.toLowerCase() === name);
}

/** A browser run's limit (StepContext.secretTyping): the secret variables' values, and the hosts they may be typed on. */
export interface SecretTypingLimit {
  values: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
}

/**
 * The limit for a browser run, undefined without targets. The values are those of the secret variables themselves, so a
 * secret fill is checked by what it would type, whatever variable name the step uses for it.
 */
export function secretTypingLimit(targets: SecretTargets | undefined, names: readonly string[] | undefined, vars: Record<string, string>): SecretTypingLimit | undefined {
  if (!targets) return undefined;
  const values = new Set<string>();
  for (const name of names ?? []) {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (typeof value === 'string' && value !== '') values.add(value);
  }
  return { values, hosts: new Set(targets.hosts.map((h) => h.toLowerCase())) };
}

/** URL.host of an address; '' for one without a host (about:blank, about:srcdoc, data:). */
export const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : '');
