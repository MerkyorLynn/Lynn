/**
 * task-mode-slice.ts — 当前激活的任务模式状态
 *
 * 用户通过 TaskModePicker 选择模式（自动/小说/社媒/代码/...），
 * 发送消息时 persona 注入到系统提示里。
 */

const TASK_MODE_KEY = 'hana-task-mode';

export interface TaskModeSlice {
  taskModeId: string;                      // 默认 'auto'
  taskModePickerOpen: boolean;             // 下拉面板打开状态
  setTaskModeId: (id: string) => void;
  setTaskModePickerOpen: (open: boolean) => void;
}

function readInitialMode(): string {
  try {
    const stored = localStorage.getItem(TASK_MODE_KEY);
    return stored || 'auto';
  } catch {
    return 'auto';
  }
}

export const createTaskModeSlice = (
  set: (partial: Partial<TaskModeSlice> | ((s: TaskModeSlice) => Partial<TaskModeSlice>)) => void
): TaskModeSlice => ({
  taskModeId: readInitialMode(),
  taskModePickerOpen: false,
  setTaskModeId: (id) => {
    set({ taskModeId: id, taskModePickerOpen: false });
    try { localStorage.setItem(TASK_MODE_KEY, id); } catch { /* ignore */ }
  },
  setTaskModePickerOpen: (open) => set({ taskModePickerOpen: open }),
});
