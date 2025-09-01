import { Notice } from 'obsidian';
import * as http from 'http';
import { URL } from 'url';
import * as net from 'net';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート

export class HttpServerManager {
    private plugin: GoogleCalendarTasksSyncPlugin;
    private server: http.Server | null = null;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
    }

    get runningServer(): http.Server | null {
        return this.server;
    }

    /**
     * OAuth コールバック用のローカル HTTP サーバーを開始します。
     * 設定されたポートでリッスンを試み、使用中の場合は次のポートを試します。
     */
    startServer(): void {
        if (this.server) {
            console.log("HTTP サーバーの開始試行はスキップされました: サーバーインスタンスが既に存在します。");
            return;
        }

        const configuredPort = this.plugin.settings.loopbackPort;
        if (!(configuredPort >= 1024 && configuredPort <= 65535)) {
            new Notice(`無効なポート番号が設定されています (${configuredPort})。サーバーは起動されません。設定で有効なポート (1024-65535) を設定してください。`, 10000);
            console.error(`無効なポート番号が設定されています (${configuredPort})。サーバーは起動されません。`);
            return;
        }

        const maxAttempts = 10;
        let currentAttempt = 0;

        const attemptListen = (portToTry: number) => {
            if (currentAttempt >= maxAttempts) {
                const lastTriedPort = configuredPort + maxAttempts - 1;
                console.error(`サーバーの起動に失敗しました: ポート ${configuredPort} から ${lastTriedPort} までがすべて使用中か、他のエラーが発生しました。`);
                new Notice(`エラー: サーバーを起動できませんでした。ポート ${configuredPort}-${lastTriedPort} が使用中の可能性があります。実行中のアプリケーションを確認するか、設定で別のポートを選択してください。`, 15000);
                this.server = null;
                return;
            }
            currentAttempt++;

            const newServer = http.createServer(this.handleHttpRequest.bind(this));

            newServer.on('error', (error: NodeJS.ErrnoException) => {
                newServer.removeAllListeners('error');
                newServer.removeAllListeners('listening');

                if (error.code === 'EADDRINUSE') {
                    console.warn(`ポート ${portToTry} は使用中です。次のポート (${portToTry + 1}) を試します...`);
                    attemptListen(portToTry + 1);
                } else {
                    console.error(`ポート ${portToTry} でのHTTPサーバーエラー:`, error);
                    new Notice(`HTTP サーバーエラー (${error.code}): ${error.message}。サーバーは起動されません。コンソールを確認してください。`, 10000);
                    this.server = null;
                }
            });

            newServer.on('listening', async () => {
                newServer.removeAllListeners('error');
                this.server = newServer; // 成功したらサーバーインスタンスを保持
                const successfulPort = (newServer.address() as net.AddressInfo).port;
                console.log(`HTTPサーバーは http://127.0.0.1:${successfulPort}/oauth2callback で正常にリッスンしています`);

                if (successfulPort !== this.plugin.settings.loopbackPort) {
                    const oldPort = this.plugin.settings.loopbackPort;
                    console.warn(`アクションが必要です: 設定されたポート ${oldPort} は使用中でした。サーバーは自動的にポート ${successfulPort} で起動されました。`);
                    const newRedirectUri = `http://127.0.0.1:${successfulPort}/oauth2callback`;

                    const noticeDuration = 30000;
                    new Notice(
                        `重要: ポート ${oldPort} は使用中でした。\n` +
                        `サーバーは自動的にポート ${successfulPort} で起動しました。\n\n` +
                        `➡️ Google Cloud Console のリダイレクト URI を以下に更新する必要があります:\n` +
                        `${newRedirectUri}\n\n` +
                        `更新するまで認証は失敗します。\n` +
                        `(プラグイン設定は自動的に ${successfulPort} に更新されました)。`,
                        noticeDuration
                    );
                    console.warn(`重要: Google Cloud リダイレクト URI を ${newRedirectUri} に更新してください`);

                    this.plugin.settings.loopbackPort = successfulPort;
                    try {
                        await this.plugin.saveData(this.plugin.settings);
                        console.log(`プラグイン設定 'loopbackPort' が ${oldPort} から ${successfulPort} に更新され、保存されました。`);
                        // OAuth クライアントを新しいリダイレクトURIで再設定
                        this.plugin.reconfigureOAuthClient();
                    } catch (saveError) {
                        console.error("自動更新されたポート設定の保存に失敗しました:", saveError);
                        new Notice(`自動選択されたポート (${successfulPort}) の保存中にエラーが発生しました。設定でポートを ${successfulPort} に手動で更新してください。`, 10000);
                    }
                }
                 // 設定タブが開いている場合、リダイレクトURI表示を更新するために再描画を試みる
                 // (ただし、確実な方法ではない)
                 this.plugin.refreshSettingsTab();
            });

            try {
                newServer.listen(portToTry, '127.0.0.1');
            } catch (syncListenError) {
                 console.error(`ポート ${portToTry} でのリッスン試行中の同期エラー:`, syncListenError);
                 newServer.removeAllListeners('error');
                 newServer.removeAllListeners('listening');
                 if ((syncListenError as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
                      new Notice(`サーバー起動中の予期せぬエラー: ${syncListenError instanceof Error ? syncListenError.message : String(syncListenError)}。コンソールを確認してください。`, 10000);
                      this.server = null;
                      currentAttempt = maxAttempts;
                 }
            }
        };

        attemptListen(configuredPort);
    }

    /**
     * 実行中の HTTP サーバーを停止します。
     */
    async stopServer(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server && this.server.listening) {
                console.log("HTTP サーバーを停止中...");
                this.server.close((err) => {
                    if (err) {
                        console.error("HTTP サーバーの停止中にエラー:", err);
                    } else {
                        console.log("HTTP サーバーは正常に停止しました。");
                    }
                    this.server = null;
                    resolve();
                });
            } else {
                this.server = null;
                resolve();
            }
        });
    }

    /**
     * ローカル HTTP サーバーへのリクエストを処理します (主に OAuth コールバック用)。
     */
    private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!req.url || !this.server) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad Request: URLが指定されていないか、サーバーが準備できていません');
            return;
        }

        const serverAddress = this.server.address();
        const host = serverAddress && typeof serverAddress === 'object' ? `127.0.0.1:${serverAddress.port}` : `127.0.0.1:${this.plugin.settings.loopbackPort}`;

        let currentUrl: URL;
        try {
             const fullUrl = req.url.startsWith('/') ? `http://${host}${req.url}` : req.url;
             currentUrl = new URL(fullUrl);
        } catch (e) {
            console.error("リクエスト URL の解析エラー:", req.url, e);
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad Request: 無効な URL フォーマット');
            return;
        }

        if (currentUrl.pathname === '/oauth2callback' && req.method === 'GET') {
            console.log('HTTP サーバーが OAuth コールバックリクエストを受信しました');
            const queryParams = currentUrl.searchParams;
            const params: Record<string, string> = {};
            queryParams.forEach((value, key) => { params[key] = value; });

            try {
                // AuthService の handleOAuthCallback を呼び出す
                await this.plugin.authService.handleOAuthCallback(params);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Auth Success</title></head><body>認証に成功しました。Obsidian に戻ってください。</body></html>`);
            } catch (error: any) {
                console.error("HTTP経由でのOAuthコールバック処理中にエラー:", error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                const msg = String(error?.message || '不明なエラー')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
                res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Auth Failed</title></head><body>認証に失敗しました: ${msg}</body></html>`);
            }
        } else if (currentUrl.pathname === '/favicon.ico' && req.method === 'GET') {
             res.writeHead(204);
             res.end();
        } else if (currentUrl.pathname === '/' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Obsidian Google Calendar Sync Plugin - OAuth 用ローカルサーバーがアクティブです。');
        } else {
            console.log(`不明なパスへのリクエストを受信しました: ${currentUrl.pathname}`);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
        }
    }
}
