import { describe, expect, it } from 'vitest';
import { safeToolValue } from '../core/conversation/safe-tool-value';

describe('public observation defense in depth', () => {
  it.each([
    'refresh_token',
    'token',
    'cookie',
    'Set-Cookie',
    'SECRETACCESSKEY',
    'accesstoken',
    'secret_access_key',
    'Api.Key',
    'clientSecret',
  ])('omits normalized credential field %s', (key) => {
    expect(safeToolValue({[key]: 'super-secret-value', result: 42})).toEqual({
      result: 42,
    });
  });

  it.each([
    'token=super-secret-value',
    'authorization: super-secret-value',
    'clientSecret=super-secret-value',
    'api_key=super-secret-value',
    'refresh_token: super-secret-value',
    'Cookie: sid=super-secret-value',
    '"SECRETACCESSKEY": "super-secret-value"',
    'accesstoken = super-secret-value',
    'Traceback: private stack',
  ])('redacts string credential or diagnostic: %s', (text) => {
    expect(safeToolValue(text)).toBe('[redacted]');
  });

  it.each([
    'https://alice:super-secret-value@example.com/x',
    'http://0.0.0.0/x',
    'http://172.16.1.2/x',
    'https://172.31.255.255',
    'http://[::1]/x',
    'https://[fc00::1]/x',
    'https://[fd00::1]/x',
    'http://127.1/x',
    'http://2130706433/x',
    'http://0x7f000001/x',
    'http://%31%32%37.0.0.1/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[fe80::1]/x',
    'http://10.1.2.3/x',
    'http://192.168.1.1',
    'http://localhost./x',
  ])('redacts private URL in surrounding prose: %s', (url) => {
    expect(safeToolValue(`Request failed (${url}), retry later.`)).toBe('[redacted]');
  });

  it.each([
    'https://example.com/query',
    'https://172.32.1.1/public',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
  ])('retains public URL %s', (url) => {
    expect(safeToolValue(`See (${url}).`)).toBe(`See (${url}).`);
  });
});
