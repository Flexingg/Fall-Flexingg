/**
 * Lets the WebView paint and handle taps between heavy steps of a Health Connect sync. Parsing and
 * mapping thousands of samples is one long task; awaiting a macrotask now and then splits it so
 * the screen never freezes for long. It only yields once `budgetMs` of work has passed, so a quick
 * sync pays almost nothing.
 */
export function createYielder(
  opts: {
    budgetMs?: number;
    now?: () => number;
    defer?: () => Promise<void>;
  } = {},
): () => Promise<void> {
  const budget = opts.budgetMs ?? 20;
  const now = opts.now ?? (() => Date.now());
  const defer = opts.defer ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let since = now();
  return async () => {
    if (now() - since < budget) return;
    await defer();
    since = now();
  };
}
