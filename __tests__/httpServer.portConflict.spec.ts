import { describe, it, expect, vi } from 'vitest';
import * as net from 'net';
import { HttpServerManager } from '../src/httpServer';

class PluginStub {
  settings: any;
  constructor(port: number) {
    this.settings = { loopbackPort: port };
  }
  async saveData(data: any) {
    this.settings = { ...this.settings, ...data };
  }
  reconfigureOAuthClient() {}
  refreshSettingsTab() {}
}

describe('HttpServerManager', () => {
  it('cleans up failed servers and leaves only one instance after port conflict', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) =>
      blocker.listen(0, '127.0.0.1', () => resolve())
    );
    const occupiedPort = (blocker.address() as net.AddressInfo).port;

    const plugin = new PluginStub(occupiedPort);
    const manager = new HttpServerManager(plugin as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager.startServer();
    await new Promise((r) => setTimeout(r, 300));

    const runningServer = manager.runningServer;
    expect(runningServer).not.toBeNull();
    const runningPort = (runningServer!.address() as net.AddressInfo).port;
    expect(runningPort).toBe(occupiedPort + 1);

    const serverHandles = (process as any)
      ._getActiveHandles()
      .filter((h: any) => h instanceof net.Server);
    // The HttpServerManager unrefs its server instance, so only the blocking
    // test server remains referenced in the active handle list. This ensures
    // that the failed server was cleaned up properly and no additional
    // references are left behind.
    expect(serverHandles.length).toBe(1);

    expect(logSpy).toHaveBeenCalledWith(
      `サーバーをクリーンアップしました: ポート ${occupiedPort}`
    );

    runningServer!.close();
    blocker.close();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
