/**
 * completion.ts — Tab completion for slash commands in the interactive REPL.
 * Pure + testable. A unique prefix completes to the full command; an ambiguous
 * prefix extends to the longest common prefix and returns the candidate list.
 */

export function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

export function completeSlash(input: string, commands: string[]): { completed: string; matches: string[] } {
  if (!input.startsWith("/")) return { completed: input, matches: [] };
  const matches = commands.filter((command) => command.startsWith(input));
  if (matches.length === 0) return { completed: input, matches: [] };
  if (matches.length === 1) return { completed: matches[0], matches };
  const prefix = commonPrefix(matches);
  return { completed: prefix.length > input.length ? prefix : input, matches };
}

export function normalizeSlashInput(input: string): string {
  const trimmed = input.trimStart();
  return trimmed.startsWith("／") ? `/${trimmed.slice(1)}` : trimmed;
}

/**
 * Extract the @-mention token currently being typed at the end of the input.
 * Triggers only when '@' opens the token (preceded by start-of-line or whitespace)
 * and the token holds no whitespace, so "user@host" emails never false-trigger.
 * Returns the token text and the index of the '@', or null when not in a mention.
 */
export function extractMentionPrefix(input: string): { token: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(input);
  if (!match) return null;
  return { token: match[2], start: match.index + match[1].length };
}

/**
 * Complete an @-mention against a list of candidate repo-relative paths (pure +
 * testable; the fs walk lives in mentions.ts). A single match completes fully —
 * directories keep their trailing '/' so the next Tab descends, files get a
 * trailing space. Multiple matches extend to the longest common prefix and return
 * the candidate list for display. Mirrors completeSlash for a consistent feel.
 */
export function completeAtMention(input: string, candidates: string[]): { completed: string; matches: string[] } {
  const mention = extractMentionPrefix(input);
  if (!mention) return { completed: input, matches: [] };
  const matches = candidates.filter((candidate) => candidate.startsWith(mention.token));
  if (matches.length === 0) return { completed: input, matches: [] };
  const head = input.slice(0, mention.start);
  if (matches.length === 1) {
    const suffix = matches[0].endsWith("/") ? "" : " ";
    return { completed: `${head}@${matches[0]}${suffix}`, matches };
  }
  const prefix = commonPrefix(matches);
  const completed = prefix.length > mention.token.length ? `${head}@${prefix}` : input;
  return { completed, matches };
}
