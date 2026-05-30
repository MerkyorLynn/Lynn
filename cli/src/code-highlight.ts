/**
 * code-highlight.ts — dependency-free, single-line syntax highlighter for fenced
 * code blocks in the TUI. Returns colored segments (Ink color names) so the Ink
 * renderer can emit one <Text> per token. Stateless / per-line: it does not track
 * multi-line strings or block comments across lines (a pragmatic trade-off — most
 * code lines tokenize correctly on their own). Comment style is chosen from the
 * fence language; everything else is language-agnostic (strings, numbers,
 * keywords, literals).
 */
export type CodeSegment = { text: string; color?: string };

const KEYWORDS = new Set([
  "function", "fn", "func", "def", "lambda", "return", "yield", "await", "async",
  "if", "else", "elif", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "const", "let", "var", "val", "mut", "new", "delete", "class", "struct",
  "enum", "interface", "type", "trait", "impl", "extends", "implements", "public",
  "private", "protected", "static", "final", "abstract", "override", "virtual",
  "import", "export", "from", "as", "use", "package", "module", "namespace", "using",
  "try", "catch", "finally", "throw", "throws", "raise", "with", "in", "of", "is",
  "not", "and", "or", "match", "when", "where", "then", "end", "void", "this", "self",
  "super", "pub", "unsafe", "defer", "go", "chan", "range", "pass", "global", "del",
  "assert", "typeof", "instanceof", "debugger", "echo", "print", "println", "fmt",
]);

const LITERALS = new Set([
  "true", "false", "null", "undefined", "none", "nil", "True", "False", "None",
  "nan", "inf", "NaN", "Infinity", "void",
]);

function commentToken(lang?: string): string {
  const l = (lang || "").toLowerCase();
  if (/^(py|python|rb|ruby|sh|bash|zsh|shell|yaml|yml|toml|ini|conf|r|perl|pl|makefile|make|dockerfile|elixir|ex)$/.test(l)) {
    return "#";
  }
  if (/^(sql|lua|hs|haskell|ada|elm)$/.test(l)) return "--";
  return "//";
}

const STRING_RE = /^("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/;
const NUMBER_RE = /^\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** Tokenize one code line into colored segments. */
export function highlightCodeLine(line: string, lang?: string): CodeSegment[] {
  const comment = commentToken(lang);
  const segments: CodeSegment[] = [];
  let i = 0;
  const push = (text: string, color?: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.color === color) last.text += text;
    else segments.push({ text, color });
  };

  while (i < line.length) {
    const rest = line.slice(i);
    const ch = rest[0];

    if (comment && rest.startsWith(comment)) {
      push(rest, "gray");
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const m = STRING_RE.exec(rest);
      if (m) {
        push(m[0], "green");
        i += m[0].length;
        continue;
      }
    }
    if (ch >= "0" && ch <= "9") {
      const m = NUMBER_RE.exec(rest);
      if (m) {
        push(m[0], "yellow");
        i += m[0].length;
        continue;
      }
    }
    const idm = IDENT_RE.exec(rest);
    if (idm) {
      const word = idm[0];
      const color = KEYWORDS.has(word) ? "magenta" : LITERALS.has(word) ? "yellow" : undefined;
      push(word, color);
      i += word.length;
      continue;
    }
    push(ch);
    i += 1;
  }

  return segments.length ? segments : [{ text: line }];
}
