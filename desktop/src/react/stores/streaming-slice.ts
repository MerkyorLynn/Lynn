export interface StreamingSlice {
  /** 焦点 session 是否在 streaming（向后兼容） */
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;
  /** 所有正在 streaming 的 session path 集合 */
  streamingSessions: string[];
  addStreamingSession: (path: string) => void;
  removeStreamingSession: (path: string) => void;
  /** 内联错误提示（输入框上方显示，替代 toast） */
  inlineError: string | null;
  setInlineError: (msg: string | null) => void;
  /** 内联通知（与 error 同区，但语义为通知/提示） */
  inlineNotice: string | null;
  setInlineNotice: (msg: string | null) => void;
  /** [PROGRESS-UX v1] 当前正在执行的工具名（用于标题栏活动指示） */
  currentActivity: string | null;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => void
): StreamingSlice => ({
  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  streamingSessions: [],
  addStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.includes(path)
      ? s.streamingSessions
      : [...s.streamingSessions, path],
  })),
  removeStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.filter(p => p !== path),
  })),
  inlineError: null,
  setInlineError: (msg) => set({ inlineError: msg }),
  inlineNotice: null,
  setInlineNotice: (msg) => set({ inlineNotice: msg }),
  currentActivity: null,
});
