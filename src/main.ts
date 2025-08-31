import { App, Notice, Plugin, TFile } from 'obsidian';
import moment from 'moment';
import { OAuth2Client } from 'google-auth-library';
import { calendar_v3 } from 'googleapis';
import * as http from 'http';
import * as net from 'net';

// モジュール化されたコンポーネントをインポート
import { ObsidianTask, GoogleCalendarTasksSyncSettings } from './types';
import { DEFAULT_SETTINGS, GoogleCalendarSyncSettingTab } from './settings';
import { AuthService } from './auth';
import { HttpServerManager } from './httpServer';
import { TaskParser } from './taskParser';
import { GCalMapper } from './gcalMapper';
import { GCalApiService } from './gcalApi';
import { SyncLogic } from './syncLogic';
import { validateMoment } from './utils'; // ユーティリティ関数をインポート
import { GoogleTasksService } from './tasksApi';
import { TasksSync } from './tasksSync';

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
	tasksService?: GoogleTasksService;
	tasksSync?: TasksSync;
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

        // 設定がロードされた後に、設定に依存するクラスをインスタンス化
        this.syncLogic = new SyncLogic(this);

		// useLoopbackServer の強制 (現在は不要だが念のため)
		if (!this.settings.useLoopbackServer) {
			console.log("'useLoopbackServer' を true に強制します (唯一のサポート方法)。");
			this.settings.useLoopbackServer = true;
		}

		// OAuth クライアントと API クライアントの初期化
		this.authService.reconfigureOAuthClient();
		this.authService.initializeCalendarApi();

		// HTTP サーバーの起動
		await this.httpServerManager.stopServer(); // 念のため既存を停止
		this.httpServerManager.startServer();

		// コマンド登録
		this.addCommand({
			id: 'authenticate-with-google',
			name: 'Google で認証する',
			callback: () => this.authService.authenticate(),
		});

		this.addCommand({
			id: 'sync-tasks-now',
			name: 'Google Calendar と今すぐタスクを同期する',
			callback: async () => this.triggerSync(),
		});

		this.addCommand({
			id: 'sync-nested-to-google-tasks',
			name: 'ネストタスクを Google Tasks に同期する',
			callback: async () => {
				if (!this.settings.enableGoogleTasksSync) { new Notice('設定で Google Tasks 同期を有効にしてください。'); return; }
				if (!this.tasksService || !this.tasksSync) { this.tasksService = new GoogleTasksService(this); this.tasksSync = new TasksSync(this.app, this, this.tasksService); }
				await this.syncNestedToGoogleTasks();
			}
		});

		// 重複整理（ドライラン）
		this.addCommand({
			id: 'dedupe-cleanup-dry-run',
			name: '重複イベントを整理（ドライラン）',
			callback: async () => {
				if (this.isCurrentlySyncing()) { new Notice('処理中のため実行できない。'); return; }
				await this.syncLogic.runDedupeCleanup(true);
			}
		});

		// 重複整理（実行）
		this.addCommand({
			id: 'dedupe-cleanup-exec',
			name: '重複イベントを整理（実行）',
			callback: async () => {
				if (this.isCurrentlySyncing()) { new Notice('処理中のため実行できない。'); return; }
				const ok = confirm('重複イベントの削除を実行しますか？ この操作は元に戻せません。');
				if (!ok) return;
				await this.syncLogic.runDedupeCleanup(false);
			}
		});

		// 設定タブの追加
		this.addSettingTab(new GoogleCalendarSyncSettingTab(this.app, this));

		// 自動同期のセットアップ
		this.setupAutoSync();

		// Google Tasks 連携の初期化
		if (this.settings.enableGoogleTasksSync) {
			this.tasksService = new GoogleTasksService(this);
			this.tasksSync = new TasksSync(this.app, this, this.tasksService);
		}

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
		// 設定値の検証と修正
		if (!this.settings.taskMap || typeof this.settings.taskMap !== 'object') {
			this.settings.taskMap = {};
		}
		this.settings.useLoopbackServer = true; // 強制
		if (typeof this.settings.loopbackPort !== 'number' || !Number.isInteger(this.settings.loopbackPort) || this.settings.loopbackPort < 1024 || this.settings.loopbackPort > 65535) {
			console.warn(`無効なループバックポート "${this.settings.loopbackPort}"。デフォルト ${DEFAULT_SETTINGS.loopbackPort} にリセット。`);
			this.settings.loopbackPort = DEFAULT_SETTINGS.loopbackPort;
		}
		if (typeof this.settings.defaultEventDurationMinutes !== 'number' || !Number.isInteger(this.settings.defaultEventDurationMinutes) || this.settings.defaultEventDurationMinutes < 5) {
			console.warn(`無効なデフォルト期間 "${this.settings.defaultEventDurationMinutes}"。デフォルト ${DEFAULT_SETTINGS.defaultEventDurationMinutes} にリセット。`);
			this.settings.defaultEventDurationMinutes = DEFAULT_SETTINGS.defaultEventDurationMinutes;
		}
		if (typeof this.settings.syncIntervalMinutes !== 'number' || !Number.isInteger(this.settings.syncIntervalMinutes) || this.settings.syncIntervalMinutes < 1) {
			console.warn(`無効な同期間隔 "${this.settings.syncIntervalMinutes}"。デフォルト ${DEFAULT_SETTINGS.syncIntervalMinutes} にリセット。`);
			this.settings.syncIntervalMinutes = DEFAULT_SETTINGS.syncIntervalMinutes;
		}
		if (this.settings.lastSyncTime && !validateMoment(this.settings.lastSyncTime, [moment.ISO_8601 as any, "YYYY-MM-DDTHH:mm:ssZ"], "lastSyncTime")) {
            console.warn(`無効な lastSyncTime "${this.settings.lastSyncTime}"。クリアします。`);
			this.settings.lastSyncTime = undefined;
        }

        // syncLogic はコンストラクタで plugin インスタンスを受け取るだけなので再インスタンス化不要
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
        this.setupAutoSync();

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
        // Google Tasks 同期（同時実行の代わりに直列で安全に）
        if (this.settings.enableGoogleTasksSync) {
            await this.syncNestedToGoogleTasks();
        }
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

	/** 自動同期を設定 */
	setupAutoSync() {
		this.clearAutoSync();
		if (this.settings.autoSync && this.settings.syncIntervalMinutes >= 1) {
			const intervalMillis = this.settings.syncIntervalMinutes * 60 * 1000;
			console.log(`自動同期を ${this.settings.syncIntervalMinutes} 分ごとに設定します。`);
			this.syncIntervalId = window.setInterval(async () => {
				const timestamp = moment().format('HH:mm:ss');
				console.log(`[${timestamp}] 自動同期トリガー`);
                if (this.isSyncing) {
					console.warn(`[${timestamp}] 自動同期スキップ: 実行中`);
					return;
				}
                if (!this.settings.tokens) {
                    console.warn(`[${timestamp}] 自動同期スキップ: 未認証`);
                    return; // トークンがなければ同期しない
                }
                // トークンの有効性を確認し、必要ならリフレッシュを試みる
                const tokenReady = await this.authService.ensureAccessToken();
                if (!tokenReady) {
                     console.warn(`[${timestamp}] 自動同期スキップ: トークン取得失敗`);
                     // ensureAccessToken内でNotice表示や自動同期停止が行われる
                     return;
                }
                // 同期実行
				console.log(`[${timestamp}] 自動同期実行中...`);
                // FIX: 設定のスナップショットを渡して競合状態を防止
				await this.syncLogic.runSync(JSON.parse(JSON.stringify(this.settings)));
                console.log(`[${timestamp}] 自動同期完了`);
			}, intervalMillis);
            console.log(`自動同期タイマー開始 (ID: ${this.syncIntervalId})。初回実行は約 ${moment().add(intervalMillis, 'ms').format('HH:mm')}。`);
		} else {
            console.log(`自動同期は無効です (有効: ${this.settings.autoSync}, 間隔: ${this.settings.syncIntervalMinutes} 分)。`);
        }
	}

	/** 自動同期を停止 */
	clearAutoSync() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			console.log("自動同期タイマーが停止されました。");
		}
	}

	// Google Tasks 連携（設定タブからも呼び出される）
	async syncNestedToGoogleTasks(): Promise<void> {
		if (!this.settings.enableGoogleTasksSync) { new Notice('Google Tasks 同期は無効です。'); return; }
		if (!this.oauth2Client) { new Notice('未認証です。設定から認証してください。'); return; }
		if (!this.tasksService || !this.tasksSync) { this.tasksService = new GoogleTasksService(this); this.tasksSync = new TasksSync(this.app, this, this.tasksService); }
		try {
			await this.tasksSync!.syncNestedToGoogleTasks();
			new Notice('ネストタスクを Google Tasks に同期しました。');
		} catch (e: any) {
			console.error('Google Tasks 同期でエラー:', e);
			new Notice('Google Tasks 同期でエラーが発生しました。コンソールを確認してください。');
		}
	}
}
