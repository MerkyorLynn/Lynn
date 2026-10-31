/**
 * ComboInput — 数字输入 + preset 下拉
 * 用于模型编辑面板（context length / max output）
 */
import React, { useState, useRef, useEffect } from 'react';
import styles from '../Settings.module.css';
import { listboxKeyDown } from '../../utils/listbox-keyboard';

interface Preset {
  label: string;
  value: number;
}

interface ComboInputProps {
  presets: Preset[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
}

export function ComboInput({ presets, value, onChange, placeholder }: ComboInputProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = React.useId();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  return (
    <div className={styles['cml-combo']} ref={ref} onKeyDown={event => {
      if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="option"]')?.focus()); }
      else if (open) listboxKeyDown(event, ref.current, () => setOpen(false), triggerRef.current);
    }}>
      <input
        type="number"
        className={styles['cml-edit-panel-input']}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        ref={triggerRef} aria-label={placeholder || 'Presets'} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        className={styles['cml-combo-toggle']}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        ▾
      </button>
      <div id={listId} role="listbox" hidden={!open} className={`${styles['cml-combo-dropdown']}${open  ? ' ' + styles['open'] : ''}`}>
        {presets.map(p => (
          <button
            key={p.value}
            type="button"
            role="option" aria-selected={String(p.value) === value}
            className={styles['cml-combo-option']}
            onClick={(e) => {
              e.stopPropagation();
              onChange(String(p.value));
              setOpen(false);
            }}
          >
            <span>{p.label}</span>
            <span className={styles['cml-combo-value']}>{p.value.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
