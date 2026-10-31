import { expect, it } from 'vitest';
import { safeHttpUrl } from '../shared/safe-http-url.js';
it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///private/file', 'ms-msdt:foo', '//example.test/path', 'https://user:password@example.test/', '', null])('rejects unsafe source links: %s', value => expect(safeHttpUrl(value)).toBeUndefined());
it.each(['https://example.test/path?q=1', 'http://example.test/path'])('keeps web source links: %s', value => expect(safeHttpUrl(value)).toBe(value));
