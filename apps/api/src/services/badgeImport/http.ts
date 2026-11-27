/**
 * The network and the clock for the badge import, in one place so tests can swap them: no test
 * ever talks to garminbadges.com or Anthropic, and backoff waits can be shrunk to milliseconds.
 */
type FetchFn = typeof fetch;

let fetchImpl: FetchFn | null = null;
let backoffMs = 1000;

export const importFetch: FetchFn = (input, init) => (fetchImpl ?? fetch)(input, init);

/** Tests: use this fetch instead of the real one (null restores it). */
export function setImportFetch(fn: FetchFn | null) {
  fetchImpl = fn;
}

/** Tests: base wait before retrying a busy API (doubles each try). */
export function setImportBackoff(ms: number) {
  backoffMs = ms;
}
export const getImportBackoff = () => backoffMs;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
