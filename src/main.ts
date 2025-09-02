import { App, Notice, Plugin } from 'obsidian';
import moment from 'moment';
import { OAuth2Client } from 'google-auth-library';
import { calendar_v3 } from 'googleapis';
import * as net from 'net';

// モジュール化されたコンポーネントをインポート
import { GoogleCalendarTasksSyncSettings } from './types';
import { DEFAULT_SETTINGS, GoogleCalendarSyncSettingTab } from './settings';
import { AuthService } from './auth';
import { HttpServerManager } from './httpServer';
import { TaskParser } from './taskParser';
import { GCalMapper } from './gcalMapper';
import { GCalApiService } from './gcalApi';
import { SyncLogic } from './syncLogic';
import { validateMoment } from './utils'; // ユーティリティ関数をインポート
import { encryptWithPassphrase, decryptWithPassphrase, obfuscateToBase64, deobfuscateFromBase64, deobfuscateLegacyFromBase64 } from './security';
import { setDevLogging } from './logger';
import { registerCommands as initRegisterCommands } from './init/commands';
import { initializeOAuth as initOAuth } from './init/oauth';
import { setupAutoSyncTimer as initAutoSyncTimer } from './init/autoSync';

export default class GoogleCalendarTasksSyncPlugin extends Plugin {
	settings: GoogleCalendarTasksSyncSettings;
	oauth2Client: OAuth2Client | null = null; // Nullable に変更
	calendar: calendar_v3.Calendar | null = null;
	syncIntervalId: number | null = null;
	httpServerManager: HttpServerManager;
	authService: AuthService;
	taskParser: TaskParser;
	gcalMapper: GCalMapper;
	gcalApi: GCalApiService;
	syncLogic: SyncLogic;
	private passphraseCache: string | null = null;
	private isSyncing: boolean = false;

	constructor(app: App, manifest: any) {
        super(app, manifest);
        // 設定より先にインスタンス化が必要なものを初期化
        this.httpServerManager = new HttpServerManager(this);
        this.authService = new AuthService(this);
        this.taskParser = new TaskParser(this.app);
        this.gcalApi = new GCalApiService(this);
        // 設定に依存するものは loadSettings 後に初期化
        // this.gcalMapper と this.syncLogic は settings が必要
    }


        async onload() {
                console.log('Google Calendar Sync プラグインをロード中');
                await this.loadSettings();
                setDevLogging(!!this.settings.devLogging);

                // 設定がロードされた後に、設定に依存するクラスをインスタンス化
                this.syncLogic = new SyncLogic(this);

                await this.initializeOAuth();
                this.registerCommands();
                // 設定タブの追加
                this.addSettingTab(new GoogleCalendarSyncSettingTab(this.app, this));
                // 自動同期のセットアップ
                this.setupAutoSyncTimer();

                console.log('Google Calendar Sync プラグインがロードされました。');
        }

        async onunload() {
                console.log('Google Calendar Sync プラグインをアンロード中');
                this.clearAutoSync();
                await this.httpServerManager.stopServer();
                console.log('Google Calendar Sync プラグインがアンロードされました。');
        }

        async loadSettings() {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
                this.validateSettings();
                await this.decryptStoredTokens();
                // syncLogic はコンストラクタで plugin インスタンスを受け取るだけなので再インスタンス化不要
        }

        private validateSettings(): void {
                // 設定値の検証と修正
                if (!this.settings.taskMap || typeof this.settings.taskMap !== 'object') {
                        this.settings.taskMap = {};
                }
                this.settings.useLoopbackServer = true; // 強制
                if (
                        typeof this.settings.loopbackPort !== 'number' ||
                        !Number.isInteger(this.settings.loopbackPort) ||
                        this.settings.loopbackPort < 1024 ||
                        this.settings.loopbackPort > 65535
                ) {
                        console.warn(`無効なループバックポート "${this.settings.loopbackPort}"。デフォルト ${DEFAULT_SETTINGS.loopbackPort} にリセット。`);
                        this.settings.loopbackPort = DEFAULT_SETTINGS.loopbackPort;
                }
                if (
                        typeof this.settings.defaultEventDurationMinutes !== 'number' ||
                        !Number.isInteger(this.settings.defaultEventDurationMinutes) ||
                        this.settings.defaultEventDurationMinutes < 5
                ) {
                        console.warn(`無効なデフォルト期間 "${this.settings.defaultEventDurationMinutes}"。デフォルト ${DEFAULT_SETTINGS.defaultEventDurationMinutes} にリセット。`);
                        this.settings.defaultEventDurationMinutes = DEFAULT_SETTINGS.defaultEventDurationMinutes;
                }
                if (
                        typeof this.settings.syncIntervalMinutes !== 'number' ||
                        !Number.isInteger(this.settings.syncIntervalMinutes) ||
                        this.settings.syncIntervalMinutes < 1
                ) {
                        console.warn(`無効な同期間隔 "${this.settings.syncIntervalMinutes}"。デフォルト ${DEFAULT_SETTINGS.syncIntervalMinutes} にリセット。`);
                        this.settings.syncIntervalMinutes = DEFAULT_SETTINGS.syncIntervalMinutes;
                }
                if (
                        this.settings.lastSyncTime &&
                        !validateMoment(this.settings.lastSyncTime, [moment.ISO_8601 as any, 'YYYY-MM-DDTHH:mm:ssZ'], 'lastSyncTime')
                ) {
                        console.warn(`無効な lastSyncTime "${this.settings.lastSyncTime}"。クリアします。`);
                        this.settings.lastSyncTime = undefined;
                }
        }

        private async decryptStoredTokens(): Promise<void> {
                // 暗号化/難読化トークン（refresh_tokenのみ）の復号
                try {
                        if (this.settings.tokensEncrypted && !this.settings.tokens?.refresh_token) {
                                let json: string | null = null;
                                if (this.settings.tokensEncrypted.startsWith('aesgcm:')) {
                                        const pass = this.passphraseCache || this.settings.encryptionPassphrase || null;
                                        if (pass) {
                                                const inner = decryptWithPassphrase(this.settings.tokensEncrypted, pass);
                                                json = deobfuscateFromBase64(inner, this.settings.obfuscationSalt!);
                                        } else {
                                                console.warn('暗号化トークンが存在しますが、パスフレーズが未設定のため復号できません。');
                                                new Notice('暗号化されたトークンを復号できません。設定でパスフレーズを入力し、再試行してください。', 10000);
                                        }
                                } else if (this.settings.tokensEncrypted.startsWith('obf1:')) {
                                        json = deobfuscateFromBase64(this.settings.tokensEncrypted, this.settings.obfuscationSalt!);
                                } else if (this.settings.tokensEncrypted.startsWith('obf:')) {
                                        // レガシー形式: 旧XORで復号 → 新形式へ再保存
                                        json = deobfuscateLegacyFromBase64(this.settings.tokensEncrypted, this.settings.obfuscationSalt || '');
                                        try {
                                                const { refresh_token } = JSON.parse(json);
                                                if (refresh_token) await this.persistTokens({ refresh_token });
                                        } catch {}
                                }
                                if (json) {
                                        const { refresh_token } = JSON.parse(json);
                                        if (refresh_token) this.settings.tokens = { refresh_token } as any;
                                }
                        }
                } catch (e) {
                        console.error('暗号化トークンの復号に失敗:', e);
                }
        }

        private async initializeOAuth(): Promise<void> {
                await initOAuth(this);
        }

        private registerCommands(): void {
                initRegisterCommands(this);
        }

        private setupAutoSyncTimer(): void {
                initAutoSyncTimer(this);
        }

	// saveData をオーバーライドし、平文トークンをディスクに書き込まない
	async saveData(data: any): Promise<void> {
		const clone = JSON.parse(JSON.stringify(data ?? {}));
		if (clone && 'tokens' in clone) clone.tokens = null; // 平文は保存しない
		return await super.saveData(clone);
	}

    // トークンを難読化で保存（既定）。パスフレーズがあればAES-GCMで二重ラップ。
    async persistTokens(tokens: any | null): Promise<void> {
        this.settings.tokens = tokens && tokens.refresh_token ? ({ refresh_token: tokens.refresh_token } as any) : null;
        if (tokens && tokens.refresh_token) {
            // obfuscationSalt の確保（初回や移行直後などで未設定の場合に生成）
            if (!this.settings.obfuscationSalt) {
                try {
                    const r = (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues)
                        ? (()=>{ const a=new Uint8Array(16); window.crypto.getRandomValues(a); return Buffer.from(a); })()
                        : Buffer.from(require('crypto').randomBytes(16));
                    this.settings.obfuscationSalt = r.toString('base64');
                    await super.saveData({ ...this.settings, tokens: null });
                } catch {}
            }
            const json = JSON.stringify({ refresh_token: tokens.refresh_token });
            const obf = obfuscateToBase64(json, this.settings.obfuscationSalt || '');
            const pass = this.passphraseCache || this.settings.encryptionPassphrase || null;
            if (pass && pass.length > 0) {
                try {
                    this.settings.tokensEncrypted = encryptWithPassphrase(obf, pass);
                    await super.saveData({ ...this.settings, tokens: null });
                } catch (e) {
                    console.error('AES二重ラップに失敗:', e);
                    new Notice('パスフレーズ暗号化に失敗しました。パスフレーズを見直してください。', 8000);
                    this.settings.tokensEncrypted = obf;
                    await super.saveData({ ...this.settings, tokens: null });
                }
            } else {
                this.settings.tokensEncrypted = obf;
                await super.saveData({ ...this.settings, tokens: null });
            }
        } else {
            this.settings.tokensEncrypted = null;
            await super.saveData({ ...this.settings, tokens: null });
        }
    }


    // 現在の暗号化/保存モードを文字列で返す
    getEncryptionModeLabel(): string {
        const enc = this.settings.tokensEncrypted || '';
        if (enc.startsWith('aesgcm:')) return `AES-GCM（二重ラップ） — ${this.settings.rememberPassphrase ? 'パス保存あり' : '一時パス'}`;
        if (enc.startsWith('obf1:') || enc.startsWith('obf:')) return '難読化 + 永続保存（既定）';
        return '未保存（メモリのみ）';
    }

	async saveSettings() {
		await this.saveData(this.settings);
		console.log("設定が保存されました。再設定をトリガーします...");
        // 設定変更後に必要な再設定を実行
		await this.reconfigureAfterSettingsChange();
        // 設定タブが開いている場合、UIを更新
        this.refreshSettingsTab();
	}

    /** 設定変更後にプラグインコンポーネントを再設定 */
    async reconfigureAfterSettingsChange() {
        console.log("設定変更後にプラグインコンポーネントを再設定中...");
        const serverIsRunning = !!this.httpServerManager.runningServer && this.httpServerManager.runningServer.listening;
        const currentServerPort = serverIsRunning ? (this.httpServerManager.runningServer?.address() as net.AddressInfo)?.port : null;

        // 1. OAuth と API クライアントの再設定
        this.authService.reconfigureOAuthClient();
        this.authService.initializeCalendarApi();

        // 2. 自動同期タイマーのリセット/セットアップ
this.setupAutoSyncTimer();

        // 3. HTTP サーバー状態の管理 (ポート変更時のみ再起動)
        const configuredPort = this.settings.loopbackPort;
        const needsRestartForPortChange = serverIsRunning && currentServerPort !== configuredPort;

        if (needsRestartForPortChange) {
             console.log(`HTTP サーバーは再起動が必要です (設定ポート: ${configuredPort}, 実行中ポート: ${currentServerPort})。`);
             await this.httpServerManager.stopServer();
             this.httpServerManager.startServer(); // 新しいポートで起動試行
        } else if (!serverIsRunning) {
             console.log(`HTTP サーバーが停止していたため、起動します。`);
             this.httpServerManager.startServer();
        }
        console.log("再設定が完了しました。");
    }

    /** 設定タブが開いている場合、UIを更新するヘルパー */
    refreshSettingsTab(): void {
        // @ts-ignore // private プロパティへのアクセス
        const settingTab = this.app.setting?.settingTabs?.find(tab => tab.id === this.manifest.id);
        if (settingTab && settingTab.display) {
            settingTab.display(); // 設定タブの display() を再実行
        }
    }

    // --- アクセサと状態管理 ---
    isCurrentlySyncing(): boolean { return this.isSyncing; }
    setSyncing(syncing: boolean): void { this.isSyncing = syncing; }

    // --- 外部モジュールから呼び出される可能性のあるメソッド ---
    getRedirectUri(): string { return this.authService.getRedirectUri(); }
    reconfigureOAuthClient(): void { this.authService.reconfigureOAuthClient(); }
    initializeCalendarApi(): void { this.authService.initializeCalendarApi(); }
    authenticate(): void { this.authService.authenticate(); }
    isTokenValid(checkRefresh: boolean = false): boolean { return this.authService.isTokenValid(checkRefresh); }

    /** ポート変更の適用（保存・再起動・UI更新を一括） */
    async applyPortChange(port: number) {
        this.settings.loopbackPort = port;
        await this.saveData(this.settings);
        try { await this.httpServerManager?.stopServer(); } catch {}
        this.httpServerManager?.startServer();
        this.authService.reconfigureOAuthClient();
        this.refreshSettingsTab();
    }

    /** 手動同期をトリガー */
    async triggerSync(): Promise<void> {
        if (!this.settings.tokens || (!this.isTokenValid(false) && !this.isTokenValid(true))) {
            new Notice("認証されていないか、トークンが期限切れ/無効です。設定から認証/再認証してください。");
            return;
        }
        if (this.isSyncing) {
            new Notice("同期は既に進行中です。");
            return;
        }
        new Notice('手動同期を開始しました...');
        // FIX: 設定のスナップショットを渡して競合状態を防止
        await this.syncLogic.runSync(JSON.parse(JSON.stringify(this.settings)));
    }

    /** 強制同期 (リセット) をトリガー */
    async forceSync(): Promise<void> {
        if (!this.settings.tokens || (!this.isTokenValid(false) && !this.isTokenValid(true))) {
            new Notice("認証されていないか、トークンが期限切れ/無効です。設定から認証/再認証してください。");
            return;
        }
        if (this.isSyncing) {
            new Notice("同期は既に進行中です。");
            return;
        }
        new Notice('強制リセット同期を開始しました...');
        // FIX: 設定のスナップショットを渡して競合状態を防止
        await this.syncLogic.runSync(JSON.parse(JSON.stringify(this.settings)), { force: true });
    }

        /** 自動同期を停止 */
        clearAutoSync() {
                if (this.syncIntervalId !== null) {
                        window.clearInterval(this.syncIntervalId);
                        this.syncIntervalId = null;
                        console.log("自動同期タイマーが停止されました。");
                }
        }
}
