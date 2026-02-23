export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
  meta?: { elapsed_ms: number; [key: string]: unknown };
}

export function success<T>(data: T, meta?: Record<string, unknown>): CommandResult<T> {
  return { ok: true, data, meta: { elapsed_ms: 0, ...meta } };
}

export function failure(error: string, message: string, data?: unknown): CommandResult {
  return { ok: false, error, message, ...(data ? { data } : {}) };
}

let jsonMode = false;
let verboseMode = false;

export function setJsonMode(enabled: boolean) { jsonMode = enabled; }
export function setVerboseMode(enabled: boolean) { verboseMode = enabled; }
export function isJsonMode() { return jsonMode; }
export function isVerboseMode() { return verboseMode; }

export function output<T>(result: CommandResult<T>) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    // Human-readable output — handled by individual commands
    // This is a fallback for commands that don't format their own output
    if (result.data !== undefined) {
      if (typeof result.data === 'string') {
        console.log(result.data);
      } else {
        console.log(JSON.stringify(result.data, null, 2));
      }
    }
  } else {
    console.error(`Error: ${result.message || result.error}`);
  }
}

export function outputRaw(text: string) {
  if (!jsonMode) {
    console.log(text);
  }
}

export function warn(message: string) {
  if (!jsonMode) {
    console.error(`Warning: ${message}`);
  }
}

export function verbose(message: string) {
  if (verboseMode && !jsonMode) {
    console.error(`[verbose] ${message}`);
  }
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
