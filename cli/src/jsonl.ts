export function writeJsonLine(value: unknown, out: NodeJS.WritableStream = process.stdout): boolean {
  if (isWritableStreamClosed(out)) return false;
  try {
    out.write(`${JSON.stringify(value)}\n`);
    return !isWritableStreamClosed(out);
  } catch (error) {
    if (isBrokenPipeError(error)) return false;
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isBrokenPipeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EPIPE";
}

export function isWritableStreamClosed(out: NodeJS.WritableStream): boolean {
  const state = out as NodeJS.WritableStream & {
    closed?: boolean;
    destroyed?: boolean;
    writableEnded?: boolean;
    writableDestroyed?: boolean;
  };
  return !!(state.closed || state.destroyed || state.writableEnded || state.writableDestroyed);
}
