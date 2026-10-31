import type React from 'react';

/** Shared keyboard behavior for menus and listboxes, including portalled panels. */
export function listboxKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  panel: HTMLElement | null,
  close: () => void,
  trigger?: HTMLElement | null,
): void {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); close(); trigger?.focus(); return;
  }
  if (event.key === 'Tab') { close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return;
  const options = Array.from(panel?.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]') || [])
    .filter(option => option.getAttribute('aria-disabled') !== 'true' && !(option as HTMLButtonElement).disabled);
  if (!options.length) return;
  event.preventDefault(); event.stopPropagation();
  const index = options.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % options.length : (index < 0 ? options.length - 1 : (index - 1 + options.length) % options.length);
  options[next].focus();
}
