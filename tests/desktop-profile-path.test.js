import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
const { resolveDesktopUserDataPath } = createRequire(import.meta.url)('../desktop/profile-path.cjs');
const appData = path.resolve('fixture-app-data');
const defaultHome = path.resolve('fixture-user/.lynn');
const defaultUserData = path.join(appData, 'Lynn');
const resolve = lynnHome => resolveDesktopUserDataPath({ lynnHome, defaultHome, appData, defaultUserData });
it('preserves the real default profile', () => expect(resolve(defaultHome)).toBe(defaultUserData));
it('separates custom homes with the same basename from each other and the default', () => {
  const first = resolve(path.resolve('fixture-first/.lynn'));
  const second = resolve(path.resolve('fixture-second/.lynn'));
  expect(first).not.toBe(second);expect(first).not.toBe(defaultUserData);expect(second).not.toBe(defaultUserData);
  expect(path.dirname(first)).toBe(appData);
});
it('reuses one stable profile for a normalized custom home', () => {
  expect(resolve(path.resolve('fixture-first/.lynn'))).toBe(resolve(path.resolve('fixture-first/child/../.lynn')));
});
