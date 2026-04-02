import { describe, it, expect } from 'vitest';
import { readCookieValue, resolveRequestAuthToken } from '../server/auth-token.js';

describe('readCookieValue', () => {
  it('returns the requested cookie value', () => {
    expect(readCookieValue('a=1; hana_token=test-token; b=2', 'hana_token')).toBe('test-token');
  });

  it('decodes encoded cookie values', () => {
    expect(readCookieValue('hana_token=abc%20123', 'hana_token')).toBe('abc 123');
  });

  it('returns empty string when the cookie is missing', () => {
    expect(readCookieValue('a=1; b=2', 'hana_token')).toBe('');
  });
});

describe('resolveRequestAuthToken', () => {
  it('prefers the Authorization header', () => {
    expect(resolveRequestAuthToken({
      authorization: 'Bearer header-token',
      protocolHeader: 'hana-v1, token.protocol-token',
      cookieHeader: 'hana_token=cookie-token',
    })).toBe('header-token');
  });

  it('falls back to Sec-WebSocket-Protocol token', () => {
    expect(resolveRequestAuthToken({
      protocolHeader: 'hana-v1, token.protocol-token',
      cookieHeader: 'hana_token=cookie-token',
    })).toBe('protocol-token');
  });

  it('falls back to the auth cookie', () => {
    expect(resolveRequestAuthToken({
      cookieHeader: 'hana_token=cookie-token',
    })).toBe('cookie-token');
  });
});
