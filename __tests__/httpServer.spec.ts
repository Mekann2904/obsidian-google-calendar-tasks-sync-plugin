import { describe, it, expect, vi } from 'vitest';
import { promises as dns } from 'dns';
import { HttpServerManager } from '../src/httpServer';

function createManager() {
  const plugin: any = { settings: { loopbackPort: 1234 } };
  const mgr = new HttpServerManager(plugin);
  (mgr as any).server = { address: () => ({ port: 1234 }) } as any;
  return mgr;
}

function createReqRes(host: string) {
  const req: any = { url: '/', method: 'GET', headers: { host } };
  let status: number | undefined;
  const res: any = {
    writeHead: (code: number) => { status = code; },
    end: () => {}
  };
  return { req, res, getStatus: () => status };
}

describe('HttpServerManager host validation', () => {
  it('allows IPv4 loopback requests', async () => {
    const mgr = createManager();
    const { req, res, getStatus } = createReqRes('127.0.0.1:1234');
    await (mgr as any).handleHttpRequest(req, res);
    expect(getStatus()).toBe(200);
  });

  it('allows IPv6 loopback requests', async () => {
    const mgr = createManager();
    const { req, res, getStatus } = createReqRes('[::1]:1234');
    await (mgr as any).handleHttpRequest(req, res);
    expect(getStatus()).toBe(200);
  });

  it('allows localhost when it resolves to loopback', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 } as any]);
    const mgr = createManager();
    const { req, res, getStatus } = createReqRes('localhost:1234');
    await (mgr as any).handleHttpRequest(req, res);
    expect(getStatus()).toBe(200);
    expect(lookup).toHaveBeenCalled();
    lookup.mockRestore();
  });

  it('rejects non-loopback hosts', async () => {
    const mgr = createManager();
    const { req, res, getStatus } = createReqRes('192.168.0.1:1234');
    await (mgr as any).handleHttpRequest(req, res);
    expect(getStatus()).toBe(400);
  });
});
