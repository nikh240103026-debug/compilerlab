import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, describeError } from './api';

function respondWith(body: string, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
}

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed JSON', async () => {
    respondWith('{"status":"ok"}');
    await expect(api.health()).resolves.toEqual({ status: 'ok' });
  });

  it('sends patches as JSON', async () => {
    respondWith('{}');
    await api.updateSettings({ theme: 'dark' });
    expect(fetch).toHaveBeenCalledWith('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"theme":"dark"}',
    });
  });

  it('surfaces the server error message', async () => {
    respondWith('{"error":{"code":"invalid_input","message":"fontSize: too big"}}', 400);
    await expect(api.settings()).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'fontSize: too big',
      status: 400,
    });
  });

  it('explains a server that cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api.settings()).rejects.toMatchObject({ code: 'offline', status: 0 });
    await expect(api.settings()).rejects.toThrow(/npm start/);
  });

  it('treats an empty 502 from the dev proxy as offline', async () => {
    respondWith('', 502);
    await expect(api.settings()).rejects.toMatchObject({ code: 'offline', status: 502 });
  });

  it('survives a response that is not JSON', async () => {
    respondWith('<html>bad gateway</html>', 500);
    await expect(api.settings()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('describeError', () => {
  it('uses API messages as they are', () => {
    expect(describeError(new ApiError('x', 'Readable', 400))).toBe('Readable');
  });

  it('explains a chunk that failed to load', () => {
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
    expect(describeError(error)).toMatch(/reloading fixes it/);
  });

  it.each([[null], [undefined], ['text'], [{}]])('has a fallback for %j', (value) => {
    expect(describeError(value)).toBe('Something unexpected happened.');
  });
});
