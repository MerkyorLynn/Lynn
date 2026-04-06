import type { SlashCommand } from '../InputArea';
import styles from './InputArea.module.css';

export function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashCommand[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className={styles['slash-menu']}>
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`${styles['slash-menu-item']}${i === selected ? ` ${styles.selected}` : ''}${busy === cmd.name ? ` ${styles.busy}` : ''}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => !busy && onSelect(cmd)}
          disabled={!!busy}
        >
          <span className={styles['slash-menu-icon']} dangerouslySetInnerHTML={{ __html: cmd.icon }} />
          <span className={styles['slash-menu-label']}>{cmd.label}</span>
          <span className={styles['slash-menu-desc']}>{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
