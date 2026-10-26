// Amazon ECS support for the gate, both off by default. No dependencies.
//
// Task scale-in protection (BROWSER_GATE_ECS_PROTECTION=on): Fargate gives a container at most 120 s between SIGTERM and
// SIGKILL, shorter than a run. While a session is open the gate asks the ECS agent to protect its task, so scale-in and
// deployments pick other tasks: PUT ${ECS_AGENT_URI}/task-protection/v1/state with {"ProtectionEnabled":true,
// "ExpiresInMinutes":N} when the count goes above 0, again before N runs out, and {"ProtectionEnabled":false} at 0.
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection-endpoint.html
//
// EMF metrics (BROWSER_GATE_EMF=on): every 60 s one CloudWatch embedded-metric-format JSON line on stdout, which the
// awslogs driver ships and CloudWatch Logs turns into the RPA/Browser metrics the service's target tracking reads.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html

export const PROTECTION_PATH = '/task-protection/v1/state';
/** Minutes of protection beyond the drain time; the refresh happens this long before it runs out. */
export const PROTECTION_MARGIN_MINUTES = 5;
/** Each agent call gives up after this long, so neither a session change nor the exit waits on a silent agent. */
export const AGENT_TIMEOUT_MS = 2000;
/** After a failed call, the next attempt (while the wanted state still differs or must be renewed). */
export const RETRY_MS = 30_000;
export const EMF_INTERVAL_MS = 60_000;
export const EMF_NAMESPACE = 'RPA/Browser';

const SYSTEM_TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

/** ExpiresInMinutes for a drain time: the drain in whole minutes plus the margin (6 to 1445, within the agent's 1-2880). */
export const protectionMinutes = (drainSeconds) => Math.ceil(drainSeconds / 60) + PROTECTION_MARGIN_MINUTES;

/** Whether ECS_AGENT_URI is usable: an http(s) URL (on ECS it is a link-local http://169.254.170.2/api/<id>). */
export function validAgentUri(agentUri) {
  if (typeof agentUri !== 'string' || !URL.canParse(agentUri)) return false;
  const { protocol } = new URL(agentUri);
  return protocol === 'http:' || protocol === 'https:';
}

/** A fixed AWS code (AccessDeniedException, TASK_NOT_VALID, ECONNREFUSED) as is; anything else is not logged. */
const code = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined);

/**
 * Keeps the task protected while sessions are open. update(active) after every change of the open-session count;
 * stop() on exit. Calls are made one at a time, and each one is for the latest wanted state, so a slow "on" never lands
 * after the "off" that followed it. Errors are logged (the HTTP status and AWS error code only: never the URI, the
 * agent's message or an ARN) and never thrown.
 *
 * - update(active): resolves once the agent has been told (or the call failed); never rejects.
 * - stop(): no more timers or calls, except one last "off" when no session is open and the agent may still think the
 *   task is protected. Resolves when that call ends (each call times out after timeoutMs).
 */
export function taskProtection({
  agentUri, drainSeconds, fetch = globalThis.fetch, now = Date.now, timers = SYSTEM_TIMERS,
  log = (line) => console.error(line), timeoutMs = AGENT_TIMEOUT_MS, retryMs = RETRY_MS,
}) {
  if (!validAgentUri(agentUri)) throw new Error('ECS_AGENT_URI must be an http URL');
  if (!Number.isInteger(drainSeconds) || drainSeconds < 1 || drainSeconds > 86_400) {
    throw new Error('drainSeconds must be a whole number from 1 to 86400');
  }
  const endpoint = new URL(agentUri);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${PROTECTION_PATH}`;
  endpoint.search = '';
  endpoint.hash = '';
  const minutes = protectionMinutes(drainSeconds);
  const refreshMs = (minutes - PROTECTION_MARGIN_MINUTES) * 60_000;

  let want = false;
  /** What the agent was last told successfully: true, false, or 'unknown' after a failed call. */
  let state = false;
  /** When a protection asked for most recently runs out on its own, whether or not that call succeeded. */
  let expiresAt = 0;
  /** Set by the timer: renew while protection is wanted, even though state === want (a retry differs from state anyway). */
  let due = false;
  let failures = 0;
  let stopped = false;
  let timer;
  let busy = false;
  let current = Promise.resolve();

  const cancel = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (ms) => {
    cancel();
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      due = true;
      kick();
    }, ms);
    timer?.unref?.();
  };

  /** One PUT; resolves { ok } or { ok: false, why }, never rejects. */
  async function put(enable) {
    const body = enable ? { ProtectionEnabled: true, ExpiresInMinutes: minutes } : { ProtectionEnabled: false };
    try {
      const res = await fetch(endpoint, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      let parsed;
      try {
        parsed = await res.json();
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
      }
      // The agent can answer 200 with a "failure" or "error" object instead of "protection".
      const failed = parsed && typeof parsed === 'object' && (parsed.failure || parsed.error);
      if (res.ok && !failed) return { ok: true };
      const reason = code(parsed?.error?.Code) ?? code(parsed?.failure?.Reason);
      return { ok: false, why: `HTTP ${res.status}${reason ? ` ${reason}` : ''}` };
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, why: 'timed out' };
      return { ok: false, why: code(err?.cause?.code) ?? code(err?.code) ?? code(err?.name) ?? 'error' };
    }
  }

  // The single worker. Its exit check and its return run in one synchronous step, so an update() that arrives while it
  // runs is either seen by the loop or starts a new worker; never neither.
  async function work() {
    try {
      for (;;) {
        // A protection nobody could clear has run out on its own by now.
        if (!want && state !== false && now() >= expiresAt) state = false;
        // A due timer means "renew" while on; with nothing wanted, nothing is left to do once the state matches.
        if (state === want && !(due && want)) return;
        if (stopped && want) return;
        const target = want;
        due = false;
        if (target) expiresAt = now() + minutes * 60_000;
        const result = await put(target);
        if (result.ok) {
          if (failures > 0) log(`browser-gate: ECS task protection is ${target ? 'on' : 'off'} again`);
          failures = 0;
          state = target;
          if (target && want) schedule(refreshMs);
          continue;
        }
        failures += 1;
        state = 'unknown';
        const retry = stopped ? '' : `; retrying in ${Math.round(retryMs / 1000)} s`;
        log(`browser-gate: ECS task protection could not be turned ${target ? 'on' : 'off'}: ${result.why}${retry}`);
        if (want !== target) continue; // the count changed meanwhile: act on it now
        if (stopped) return;
        schedule(retryMs);
        return;
      }
    } finally {
      busy = false;
    }
  }
  function kick() {
    if (busy) return current;
    busy = true;
    current = work();
    return current;
  }

  return {
    update(active) {
      want = active > 0;
      if (!want) {
        cancel();
        due = false;
      }
      if (stopped) return Promise.resolve();
      return kick();
    },
    stop() {
      stopped = true;
      cancel();
      due = false;
      if (!want && state !== false) return kick();
      return busy ? current : Promise.resolve();
    },
  };
}

/** Printable ASCII, 1 to 1024 characters, not only spaces: what EMF accepts as a dimension value. */
export const validServiceName = (v) => typeof v === 'string' && /^[\x20-\x7e]{1,1024}$/.test(v) && /\S/.test(v);
export const SERVICE_NAME_RULE = 'BROWSER_GATE_SERVICE_NAME must be 1 to 1024 printable ASCII characters, not only spaces';

/** One CloudWatch EMF document as a single JSON line (no newline): SessionsActive and SessionsCapacity by ServiceName. */
export function emfLine({ namespace = EMF_NAMESPACE, serviceName, active, capacity, now = Date.now() }) {
  if (!validServiceName(serviceName)) throw new Error(SERVICE_NAME_RULE);
  return JSON.stringify({
    _aws: {
      Timestamp: typeof now === 'function' ? now() : now,
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [['ServiceName']],
        Metrics: [{ Name: 'SessionsActive', Unit: 'Count' }, { Name: 'SessionsCapacity', Unit: 'Count' }],
      }],
    },
    ServiceName: serviceName,
    SessionsActive: active,
    SessionsCapacity: capacity,
  });
}

/**
 * Writes an EMF line now and every intervalMs (0 and 0 while stats().draining), each as one whole write (the line plus its newline), so no other output
 * lands inside it. The timer is unref()ed: it never keeps the process alive. Returns stop().
 */
export function startEmf({
  serviceName, stats, namespace = EMF_NAMESPACE, write = (s) => process.stdout.write(s), intervalMs = EMF_INTERVAL_MS,
  now = Date.now, timers = SYSTEM_TIMERS,
}) {
  if (!validServiceName(serviceName)) throw new Error(SERVICE_NAME_RULE);
  let timer;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    // A draining task is leaving: it reports no sessions and no capacity, so target tracking sizes the service on the
    // tasks that stay (the Kubernetes query leaves draining pods out the same way). Prometheus keeps the true numbers.
    const { active, capacity, draining } = stats();
    write(`${emfLine({ namespace, serviceName, active: draining ? 0 : active, capacity: draining ? 0 : capacity, now: now() })}\n`);
    timer = timers.setTimeout(tick, intervalMs);
    timer?.unref?.();
  };
  tick();
  return () => {
    stopped = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
}
