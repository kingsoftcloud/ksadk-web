import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, postJsonAction } from '../api/client.js';
import { classifyBootstrapFailure } from '../hooks/useBootstrap.js';

describe('hosted UI bootstrap authorization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a non-JSON HTTP authorization status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    })));

    await expect(postJsonAction('GetAgentUiBootstrap', {})).rejects.toMatchObject({
      name: 'ApiError',
      code: 401,
      message: 'Unauthorized',
    });
  });

  it('fails closed for unauthorized bootstrap links', () => {
    expect(classifyBootstrapFailure(new ApiError(401, 'Unauthorized'))).toBe('auth-required');
    expect(classifyBootstrapFailure(new ApiError(403, 'Forbidden'))).toBe('auth-required');
    expect(classifyBootstrapFailure(new ApiError(500, 'Unavailable'))).toBe('error');
  });
});
