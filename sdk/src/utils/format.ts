/** Format a USD price with enough decimals to show meaningful digits.
 *  $80.60, $0.0061, $0.00000012 — never shows $0.0000 for non-zero prices. */
export function fmtPrice(price: number): string {
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  // For tiny prices, show 2 significant digits
  if (price > 0) {
    const digits = -Math.floor(Math.log10(price)) + 1;
    return price.toFixed(Math.min(digits, 12));
  }
  return '0.00';
}

export function timed<T>(fn: () => T | Promise<T>): Promise<{ result: T; elapsed_ms: number }> {
  const start = performance.now();
  const maybePromise = fn();
  if (maybePromise instanceof Promise) {
    return maybePromise.then(result => ({
      result,
      elapsed_ms: Math.round(performance.now() - start),
    }));
  }
  return Promise.resolve({
    result: maybePromise,
    elapsed_ms: Math.round(performance.now() - start),
  });
}
