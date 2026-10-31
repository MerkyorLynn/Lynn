import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
it('opens generated HTML inside an opaque sandbox rather than the application origin', async () => {
  const dom = new JSDOM('<!doctype html><html></html>', { url: 'http://localhost:4321/' });
  let captured: Blob | undefined;
  const open = vi.fn(), revokeObjectURL = vi.fn(), schedule = vi.fn();
  const fakeWindow = { open, history: { replaceState() {} } } as any;
  class FakeURL extends URL { static createObjectURL(blob: Blob) { captured = blob; return 'blob:fixture'; } static revokeObjectURL = revokeObjectURL; }
  const context = vm.createContext({ window: fakeWindow, location: dom.window.location, localStorage: dom.window.localStorage, document: dom.window.document, URLSearchParams, URL: FakeURL, Blob, setTimeout: schedule, fetch: vi.fn() });
  vm.runInContext(fs.readFileSync(new URL('../desktop/src/modules/platform.js', import.meta.url), 'utf8'), context);
  const html = '</iframe><script>localStorage.getItem("hana-token")</script><p title="quote">data & text</p>';
  await fakeWindow.platform.openHtmlInBrowser(html);
  const preview = new JSDOM(await captured!.text());
  const frame = preview.window.document.querySelector('iframe')!;
  expect(preview.window.document.querySelectorAll('script')).toHaveLength(0);
  expect(frame.getAttribute('srcdoc')).toBe(html);
  expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(open).toHaveBeenCalledWith('blob:fixture', '_blank', 'noopener,noreferrer');
  expect(schedule).toHaveBeenCalledOnce();
  fakeWindow.platform.openExternal('javascript:alert(1)');
  fakeWindow.platform.openExternal('file:///private/file');
  expect(open).toHaveBeenCalledTimes(1);
  fakeWindow.platform.openExternal('https://example.test/');
  expect(open).toHaveBeenLastCalledWith('https://example.test/', '_blank', 'noopener,noreferrer');
  preview.window.close(); dom.window.close();
});
