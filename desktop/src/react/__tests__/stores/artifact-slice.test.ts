import { describe, it, expect, beforeEach } from 'vitest';
import { createArtifactSlice, type ArtifactSlice } from '../../stores/artifact-slice';

function makeSlice(): ArtifactSlice {
  let state: ArtifactSlice;
  const set = (partial: Partial<ArtifactSlice> | ((s: ArtifactSlice) => Partial<ArtifactSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createArtifactSlice(set);
  return new Proxy({} as ArtifactSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('artifact-slice tab state', () => {
  let slice: ArtifactSlice;
  beforeEach(() => { slice = makeSlice(); });

  it('初始状态：openTabs 为空，activeTabId 为 null', () => {
    expect(slice.openTabs).toEqual([]);
    expect(slice.activeTabId).toBeNull();
  });
  it('openTab 新增 tab 并激活', () => {
    slice.openTab('a1');
    expect(slice.openTabs).toEqual(['a1']);
    expect(slice.activeTabId).toBe('a1');
  });
  it('openTab 已存在的 id 只切换激活，不重复添加', () => {
    slice.openTab('a1'); slice.openTab('a2'); slice.openTab('a1');
    expect(slice.openTabs).toEqual(['a1', 'a2']);
    expect(slice.activeTabId).toBe('a1');
  });
  it('closeTab 移除 tab，激活前一个', () => {
    slice.openTab('a1'); slice.openTab('a2'); slice.openTab('a3');
    slice.setActiveTab('a2'); slice.closeTab('a2');
    expect(slice.openTabs).toEqual(['a1', 'a3']);
    expect(slice.activeTabId).toBe('a1');
  });
  it('closeTab 移除第一个 tab，激活后一个', () => {
    slice.openTab('a1'); slice.openTab('a2');
    slice.setActiveTab('a1'); slice.closeTab('a1');
    expect(slice.openTabs).toEqual(['a2']);
    expect(slice.activeTabId).toBe('a2');
  });
  it('closeTab 移除最后一个 tab，activeTabId 设为 null', () => {
    slice.openTab('a1'); slice.closeTab('a1');
    expect(slice.openTabs).toEqual([]);
    expect(slice.activeTabId).toBeNull();
  });
  it('setActiveTab 切换激活', () => {
    slice.openTab('a1'); slice.openTab('a2');
    slice.setActiveTab('a1');
    expect(slice.activeTabId).toBe('a1');
  });
  it('saveTabState / restoreTabState 按 session 保存恢复', () => {
    slice.openTab('a1'); slice.openTab('a2');
    slice.saveTabState('/session/1');
    slice.openTab('b1'); slice.closeTab('a1'); slice.closeTab('a2');
    slice.restoreTabState('/session/1');
    expect(slice.openTabs).toEqual(['a1', 'a2']);
    expect(slice.activeTabId).toBe('a2');
  });
  it('restoreTabState 无保存状态时清空', () => {
    slice.openTab('a1');
    slice.restoreTabState('/session/unknown');
    expect(slice.openTabs).toEqual([]);
    expect(slice.activeTabId).toBeNull();
  });
});
