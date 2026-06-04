import type { SlashCommand } from '../InputArea';
import { AtMentionMenu } from './AtMentionMenu';
import { AttachedFilesBar } from './AttachedFilesBar';
import { QuotedSelectionCard } from './QuotedSelectionCard';
import { SlashCommandMenu } from './SlashCommandMenu';
import { TodoDisplay } from './TodoDisplay';
import styles from './InputArea.module.css';

type AttachedFile = { path: string; name: string; isDirectory?: boolean };
type TodoItem = { text: string; done: boolean };
type AtMentionFile = { name: string; path: string; rel: string; isDir: boolean };

export function InputContextOverlays({
  attachedFiles,
  atMenuOpen,
  atQuery,
  atResults,
  atSelected,
  filteredCommands,
  onAtHover,
  onAtResultsChange,
  onAtSelect,
  onAttachmentRemove,
  onSlashHover,
  onSlashSelect,
  quotedSelection,
  sessionTodos,
  slashBusy,
  slashMenuOpen,
  slashSelected,
}: {
  attachedFiles: AttachedFile[];
  atMenuOpen: boolean;
  atQuery: string;
  atResults: AtMentionFile[];
  atSelected: number;
  filteredCommands: SlashCommand[];
  onAtHover: (index: number) => void;
  onAtResultsChange: (results: AtMentionFile[]) => void;
  onAtSelect: (file: AtMentionFile) => void;
  onAttachmentRemove: (index: number) => void;
  onSlashHover: (index: number) => void;
  onSlashSelect: (cmd: SlashCommand) => void;
  quotedSelection: unknown;
  sessionTodos: TodoItem[];
  slashBusy: string | null;
  slashMenuOpen: boolean;
  slashSelected: number;
}) {
  return (
    <>
      {(quotedSelection || sessionTodos.length > 0) && (
        <div className={styles['input-context-row']}>
          <div className={styles['input-context-left']}>
            <QuotedSelectionCard />
          </div>
          <TodoDisplay todos={sessionTodos} />
        </div>
      )}
      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu
          commands={filteredCommands}
          selected={slashSelected}
          busy={slashBusy}
          onSelect={onSlashSelect}
          onHover={onSlashHover}
        />
      )}
      {atMenuOpen && (
        <AtMentionMenu
          query={atQuery}
          selected={atSelected}
          onSelect={onAtSelect}
          onHover={onAtHover}
          onResultsChange={onAtResultsChange}
        />
      )}
      {attachedFiles.length > 0 && (
        <AttachedFilesBar files={attachedFiles} onRemove={onAttachmentRemove} />
      )}
    </>
  );
}
