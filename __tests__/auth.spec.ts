import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/auth';
import { DEFAULT_SETTINGS } from '../src/settings';

const mkPlugin = (port: number) => ({
  settings: { ...DEFAULT_SETTINGS, loopbackPort: port },
  oauth2Client: null,
} as any);

describe('AuthService.getRedirectUri', () => {
  it('returns custom port when valid', () => {
    const service = new AuthService(mkPlugin(4321));
    expect(service.getRedirectUri()).toBe('http://127.0.0.1:4321/oauth2callback');
  });

  it('falls back to default when port out of range', () => {
    const service = new AuthService(mkPlugin(70000));
    expect(service.getRedirectUri()).toBe(`http://127.0.0.1:${DEFAULT_SETTINGS.loopbackPort}/oauth2callback`);
  });
});
