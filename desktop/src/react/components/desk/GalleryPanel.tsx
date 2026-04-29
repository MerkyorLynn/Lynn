/**
 * GalleryPanel — 插件生成图片画廊（v0.77）
 *
 * 扫描书桌 gallery/ 目录，展示 flux-studio 生成的图片。
 */

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Desk.module.css';

interface GalleryImage {
  name: string;
  path: string;
  mtime: string;
  size: number;
}

export function GalleryPanel() {
  const deskBasePath = useStore(state => state.deskBasePath);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(false);
  const t = window.t ?? ((key: string) => key);

  const loadGallery = useCallback(async () => {
    if (!deskBasePath) return;
    setLoading(true);
    try {
      // Use desk API to list gallery folder
      const res = await hanaFetch(`/api/desk/files?path=${encodeURIComponent(deskBasePath + '/gallery')}`);
      const data = await res.json();
      const list = Array.isArray(data.files)
        ? data.files.filter((f: { name?: string }) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name || ''))
        : [];
      setImages(list);
    } catch {
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, [deskBasePath]);

  useEffect(() => {
    loadGallery();
  }, [loadGallery]);

  if (!deskBasePath) {
    return <div className={s.galleryEmpty}>{t('desk.noDeskRoot')}</div>;
  }

  return (
    <div className={s.galleryPanel}>
      <div className={s.galleryHeader}>
        <span className={s.galleryTitle}>{t('desk.gallery') || '画廊'}</span>
        <button className={s.galleryRefreshBtn} onClick={loadGallery} disabled={loading} title={t('common.refresh')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
      {images.length === 0 ? (
        <div className={s.galleryEmpty}>{t('desk.galleryEmpty') || '暂无图片，使用 generate_image 工具生成。'}</div>
      ) : (
        <div className={s.galleryGrid}>
          {images.map(img => (
            <div key={img.path} className={s.galleryItem}>
              <img
                src={`/api/desk/file?path=${encodeURIComponent(img.path)}`}
                alt={img.name}
                className={s.galleryThumb}
                onClick={() => window.platform?.showInFinder?.(img.path)}
                title={img.name}
              />
              <span className={s.galleryName}>{img.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
