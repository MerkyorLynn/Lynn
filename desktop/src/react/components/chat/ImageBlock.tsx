/**
 * ImageBlock — 点击放大 Lightbox 组件
 *
 * 缩略图 → 点击全屏 Lightbox → 滚轮缩放 + 拖拽平移
 * 纯 React + CSS，零第三方依赖。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import styles from './Chat.module.css';

interface ImageBlockProps {
  src: string;
  alt?: string;
  className?: string;
}

export const ImageBlock = memo(function ImageBlock({ src, alt, className }: ImageBlockProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  const handleOpen = useCallback(() => {
    setOpen(true);
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, handleClose]);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setScale(prev => Math.min(5, Math.max(0.5, prev - e.deltaY * 0.002)));
  }, []);

  // Track if mouse actually dragged (vs. simple click)
  const didDrag = useRef(false);

  // Drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
  }, [translate]);

  // Drag move
  useEffect(() => {
    if (!open) return;
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      setTranslate({
        x: translateStart.current.x + dx,
        y: translateStart.current.y + dy,
      });
    };
    const handleUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [open]);

  // Touch pinch zoom
  const lastTouchDist = useRef(0);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist.current > 0) {
        const delta = dist / lastTouchDist.current;
        setScale(prev => Math.min(5, Math.max(0.5, prev * delta)));
      }
      lastTouchDist.current = dist;
    }
  }, []);

  return (
    <>
      <img
        className={className || styles.chatImage}
        src={src}
        alt={alt || ''}
        loading="lazy"
        draggable={false}
        onClick={handleOpen}
        style={{ cursor: 'zoom-in' }}
      />
      {open && (
        <div
          className={styles.lightboxOverlay}
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          {/* 右上角关闭按钮 */}
          <button className={styles.lightboxCloseBtn} onClick={handleClose} title="Close (ESC)">✕</button>
          <div className={styles.lightboxToolbar}>
            <button onClick={() => setScale(s => Math.min(5, s + 0.25))} title="Zoom in">+</button>
            <button onClick={() => setScale(s => Math.max(0.5, s - 0.25))} title="Zoom out">−</button>
            <button onClick={() => { setScale(1); setTranslate({ x: 0, y: 0 }); }} title="1:1">1:1</button>
            <a href={src} download title="Download" style={{ color: 'inherit', textDecoration: 'none' }}>↓</a>
            <button onClick={handleClose} title="Close">✕</button>
          </div>
          <img
            className={styles.lightboxImage}
            src={src}
            alt={alt || ''}
            draggable={false}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseUp={() => { if (!didDrag.current && scale === 1) handleClose(); }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              cursor: scale === 1 && !dragging.current ? 'zoom-out' : dragging.current ? 'grabbing' : 'grab',
            }}
          />
        </div>
      )}
    </>
  );
});
