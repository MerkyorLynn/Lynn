/**
 * security-slice.ts — 安全模式 Zustand 状态
 */

export type SecurityMode = 'authorized' | 'plan' | 'safe';

export interface SecuritySlice {
  securityMode: SecurityMode;
  setSecurityMode: (mode: SecurityMode) => void;
}

export const createSecuritySlice = (
  set: (partial: Partial<SecuritySlice>) => void
): SecuritySlice => ({
  securityMode: 'authorized',
  setSecurityMode: (mode) => set({ securityMode: mode }),
});
