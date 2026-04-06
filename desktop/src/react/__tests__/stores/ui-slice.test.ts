import { beforeEach, describe, expect, it } from 'vitest';
import { createUiSlice, type UiSlice } from '../../stores/ui-slice';

function makeSlice(): UiSlice {
  let state: UiSlice;
  const set = (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createUiSlice(set);
  return new Proxy({} as UiSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('ui-slice', () => {
  let slice: UiSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('右侧工作区默认关闭，避免首次进入遮挡聊天区', () => {
    expect(slice.sidebarOpen).toBe(true);
    expect(slice.jianOpen).toBe(false);
    expect(slice.jianAutoCollapsed).toBe(false);
  });
});
