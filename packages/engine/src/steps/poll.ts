export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls fn until it returns a truthy value or the timeout passes. Always calls fn at least once. */
export async function poll<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs: number, intervalMs = 100): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() >= end) return undefined;
    await sleep(intervalMs);
  }
}
