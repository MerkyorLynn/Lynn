export function supportsColor(stream: Pick<NodeJS.WriteStream, "isTTY"> | undefined): boolean {
  return !!stream?.isTTY && process.env.NO_COLOR !== "1";
}

export function red(text: string, enabled: boolean): string {
  return enabled ? `\x1b[31m${text}\x1b[0m` : text;
}

export function yellow(text: string, enabled: boolean): string {
  return enabled ? `\x1b[33m${text}\x1b[0m` : text;
}

export function cyan(text: string, enabled: boolean): string {
  return enabled ? `\x1b[36m${text}\x1b[0m` : text;
}

export function green(text: string, enabled: boolean): string {
  return enabled ? `\x1b[32m${text}\x1b[0m` : text;
}

export function dim(text: string, enabled: boolean): string {
  return enabled ? `\x1b[2m${text}\x1b[0m` : text;
}

export function bold(text: string, enabled: boolean): string {
  return enabled ? `\x1b[1m${text}\x1b[0m` : text;
}

export function dangerLine(text: string, enabled: boolean): string {
  return red(`!! ${text}`, enabled);
}
