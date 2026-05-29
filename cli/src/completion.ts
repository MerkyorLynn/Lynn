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
