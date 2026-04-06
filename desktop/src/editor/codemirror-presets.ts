import {
  EditorView, keymap, highlightActiveLine, drawSelection,
  ViewPlugin, Decoration, WidgetType, lineNumbers,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState, Compartment, RangeSetBuilder, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, syntaxTree,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

export { EditorView, EditorState, Compartment, drawSelection, history, bracketMatching, keymap, lineNumbers, highlightActiveLine, syntaxHighlighting, markdown, markdownLanguage, languages, defaultKeymap, historyKeymap };
export type { Extension };

export const SAVE_DELAY = 600;

export const codeTheme = EditorView.theme({
  '&': {
    fontSize: '0.84rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
});

export const markdownTheme = EditorView.theme({
  '&': {
    fontSize: '0.92rem',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-serif)',
    lineHeight: '1.75',
    padding: 'var(--space-md, 1rem) 0',
  },
  '.cm-content': {
    padding: '0 var(--space-lg, 1.5rem)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text)',
  },
});

export const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.2em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.1em', fontWeight: '600' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.heading5, fontWeight: '600' },
  { tag: tags.heading6, fontWeight: '600' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)', opacity: '0.4' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', backgroundColor: 'var(--overlay-light)', borderRadius: '3px' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--text-muted)', fontSize: '0.85em' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--text)' },
  { tag: tags.meta, color: 'var(--text-muted)' },
]);

export const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8959a8' },
  { tag: tags.string, color: '#718c00' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.number, color: '#f5871f' },
  { tag: tags.operator, color: '#3e999f' },
  { tag: tags.definition(tags.variableName), color: '#4271ae' },
  { tag: tags.function(tags.variableName), color: '#4271ae' },
  { tag: tags.typeName, color: '#c82829' },
]);

const CONCEAL_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark',
  'LinkMark', 'URL',
]);

const hideMark = Decoration.replace({});
const centerLineDeco = Decoration.line({ class: 'cm-center-line' });

class HrWidget extends WidgetType {
  toDOM() {
    // eslint-disable-next-line no-restricted-syntax -- CodeMirror widgets must return raw DOM nodes outside the React tree
    const el = document.createElement('span');
    el.className = 'cm-hr-widget';
    return el;
  }
  eq() { return true; }
}

const hrDecoration = Decoration.replace({ widget: new HrWidget() });

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const activeLines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let i = startLine; i <= endLine; i++) activeLines.add(i);
  }

  const ranges: { from: number; to: number; deco: Decoration }[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const line = view.state.doc.lineAt(node.from);
        const isActive = activeLines.has(line.number);

        if (node.name === 'ATXHeading1') {
          ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          return;
        }

        if (node.name === 'HorizontalRule') {
          if (!isActive) {
            ranges.push({ from: node.from, to: node.to, deco: hrDecoration });
            ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
          }
          return;
        }

        if (isActive || !CONCEAL_MARKS.has(node.name)) return;

        let hideTo = node.to;
        if (node.name === 'HeaderMark') {
          const next = view.state.doc.sliceString(hideTo, hideTo + 1);
          if (next === ' ') hideTo += 1;
        }
        ranges.push({ from: node.from, to: hideTo, deco: hideMark });
      },
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

export const markdownDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function createBaseEditorExtensions(opts: {
  isMarkdown: boolean;
  onDocChange?: (text: string) => void;
  onSelectionChange?: (view: EditorView) => void;
}): Extension[] {
  const { isMarkdown, onDocChange, onSelectionChange } = opts;
  const langComp = new Compartment();
  const highlightComp = new Compartment();
  const gutterComp = new Compartment();
  const concealComp = new Compartment();
  const themeComp = new Compartment();

  const extensions: Extension[] = [
    drawSelection(),
    history(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onDocChange) {
        onDocChange(update.state.doc.toString());
      }
      if (update.selectionSet && onSelectionChange) {
        onSelectionChange(update.view);
      }
    }),
    gutterComp.of(isMarkdown ? [] : lineNumbers()),
    langComp.of(isMarkdown ? markdown({ base: markdownLanguage, codeLanguages: languages }) : []),
    highlightComp.of(syntaxHighlighting(isMarkdown ? markdownHighlight : codeHighlight)),
    concealComp.of(isMarkdown ? markdownDecoPlugin : []),
    themeComp.of(isMarkdown ? markdownTheme : codeTheme),
  ];

  if (!isMarkdown) {
    extensions.push(highlightActiveLine());
  }

  return extensions;
}
