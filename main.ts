import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, moment, parseYaml, Vault, MetadataCache, TextComponent, ExtraButtonComponent, request, RequestUrlParam } from 'obsidian'; // request を追加
import { OAuth2Client, Credentials } from 'google-auth-library';
import { google, calendar_v3 } from 'googleapis';
import { GaxiosError, GaxiosResponse } from 'gaxios'; // GaxiosError をインポート
import { RRule, RRuleSet, rrulestr, Frequency, Options as RRuleOptions } from 'rrule';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import * as net from 'net'; // net.AddressInfo の型付けのためにインポート

// --- インターフェース定義 ---
interface ObsidianTask {
	id: string; // Obsidian 内でのタスクの一意識別子 (例: ファイルパス + 行番号 + 内容ハッシュ)
	rawText: string; // Markdown ファイル内のタスクの元の行テキスト
	summary: string; // タスクの主内容 (日付やタグなどを除いたもの)
	isCompleted: boolean; // タスクが完了しているか
	dueDate: string | null; // 期限日 (YYYY-MM-DD or ISO 8601) (📅 or due:)
	startDate: string | null; // 開始日 (YYYY-MM-DD or ISO 8601) (🛫 or start:)
	scheduledDate: string | null; // 予定日 (YYYY-MM-DD or ISO 8601) (⏳ or scheduled:)
	createdDate: string | null; // 作成日 (YYYY-MM-DD) (➕ or created:)
	completionDate: string | null; // 完了日 (YYYY-MM-DD) (✅ or done:)
	priority: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | null; // 優先度 (🔺⏫🔼🔽⏬)
	recurrenceRule: string | null; // 繰り返しルール (iCalendar RRULE 文字列) (🔁 or repeat:/recur:)
	tags: string[]; // タグ (例: #tag1)
	blockLink: string | null; // ブロックリンク (例: ^abcdef)
	sourcePath: string; // タスクが存在するファイルのパス
	sourceLine: number; // タスクが存在するファイルの行番号 (0-based)
}

// Google Calendar API のイベント入力型
type GoogleCalendarEventInput = calendar_v3.Schema$Event;

interface GoogleCalendarTasksSyncSettings {
	clientId: string; // Google Cloud Console で取得したクライアントID
	clientSecret: string; // Google Cloud Console で取得したクライアントシークレット
	tokens: Credentials | null; // Google から取得した認証トークン (アクセストークン、リフレッシュトークンなど)
	calendarId: string; // 同期対象の Google Calendar ID (通常 'primary' または特定のカレンダーID)
	syncIntervalMinutes: number; // 自動同期の間隔 (分単位)
	autoSync: boolean; // 自動同期を有効にするか
	taskMap: { [obsidianTaskId: string]: string }; // ObsidianタスクIDとGoogle CalendarイベントIDのマッピング
	lastSyncTime?: string; // 最後に同期が成功した時刻 (ISO 8601 形式)
	// Google Calendar イベントの説明欄にどの情報を含めるかの設定
	syncPriorityToDescription: boolean; // 優先度を説明に追加するか
	syncTagsToDescription: boolean; // タグを説明に追加するか
	syncBlockLinkToDescription: boolean; // ブロックリンクを説明に追加するか (注: 現在の実装では Obsidian URI に統合)
	syncScheduledDateToDescription: boolean; // 予定日 (Scheduled Date) を説明に追加するか
	defaultEventDurationMinutes: number; // 開始時刻と終了時刻が指定されているが、終了が開始より前の場合に使用するデフォルトのイベント時間 (分)
	useLoopbackServer: boolean; // 認証にローカルループバックサーバーを使用するか (現在はこの方法のみサポート)
	loopbackPort: number; // ローカルループバックサーバーが使用するポート番号
}

const DEFAULT_SETTINGS: GoogleCalendarTasksSyncSettings = {
	clientId: '',
	clientSecret: '',
	tokens: null,
	calendarId: 'primary',
	syncIntervalMinutes: 15,
	autoSync: true,
	taskMap: {},
	lastSyncTime: undefined,
	syncPriorityToDescription: true,
	syncTagsToDescription: true,
	syncBlockLinkToDescription: false, // デフォルトではオフ (Obsidian URI に統合されるため)
	syncScheduledDateToDescription: true,
	defaultEventDurationMinutes: 60,
	useLoopbackServer: true, // 常に true
	loopbackPort: 3000, // デフォルトポート
};

// バッチリクエスト用のインターフェース
interface BatchRequestItem {
	method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; // HTTPメソッド
	path: string; // APIのパス (例: /calendar/v3/calendars/{calendarId}/events/{eventId})
	headers?: { [key: string]: string }; // リクエストヘッダー (オプション)
	body?: any; // リクエストボディ (JSONなど)
	obsidianTaskId?: string; // どのObsidianタスクに関連するか (結果処理で使用)
	operationType?: 'insert' | 'update' | 'patch' | 'delete'; // 実行した操作の種類 (結果処理で使用)
	originalGcalId?: string; // delete/update/patch 操作の対象となる元のGoogle CalendarイベントID
}

// バッチレスポンスのアイテムインターフェース
interface BatchResponseItem {
	id?: string; // Google のレスポンスID (直接はあまり使わない)
	status: number; // 個別リクエストのHTTPステータスコード
	headers?: { [key: string]: string }; // 個別リクエストのレスポンスヘッダー (オプション)
	body?: any; // 個別リクエストのレスポンスボディ (通常はJSONオブジェクト or エラーメッセージ)
}

// GaxiosError の型ガード関数
function isGaxiosError(error: any): error is GaxiosError {
	return error && typeof error === 'object' && typeof error.message === 'string' && error.response !== undefined;
}


export default class GoogleCalendarTasksSyncPlugin extends Plugin {
	settings: GoogleCalendarTasksSyncSettings;
	oauth2Client!: OAuth2Client; // Google OAuth2 クライアントインスタンス
	calendar: calendar_v3.Calendar | null = null; // Google Calendar API クライアントインスタンス
	syncIntervalId: number | null = null; // 自動同期のインターバルタイマーID
	httpServer: http.Server | null = null; // OAuth認証用のローカルHTTPサーバーインスタンス
	private activeOAuthState: string | null = null; // OAuth認証フロー中のCSRF対策用 state 値
	private isSyncing: boolean = false; // 現在同期処理が実行中かどうかのフラグ
	public isCurrentlySyncing(): boolean { return this.isSyncing; } // 同期中かどうかのゲッター

	// --- 既存のメソッド (onload, onunload, HTTP Server, OAuth関連, Settings, Helper など) ---

	/**
	 * Google OAuth 認証フローでリダイレクト先として使用される URI を取得します。
	 * 設定されたポート番号を使用します。
	 */
	getRedirectUri(): string {
		// 常に設定からポート番号を取得してURIを生成
		const port = this.settings.loopbackPort;
		if (port >= 1024 && port <= 65535) {
			return `http://127.0.0.1:${port}/oauth2callback`;
		} else {
			console.warn(`設定されているループバックポート番号が無効です: ${port}。URI生成にはデフォルトポート ${DEFAULT_SETTINGS.loopbackPort} を使用します。`);
			// 設定が無効な場合は、デフォルトポートをURIに反映
			return `http://127.0.0.1:${DEFAULT_SETTINGS.loopbackPort}/oauth2callback`;
		}
	}

	/**
	 * プラグインがロードされたときに実行される処理
	 */
	async onload() {
		console.log('Google Calendar Sync プラグインをロード中');
		await this.loadSettings();

		// useLoopbackServer が false でロードされた場合、強制的に true にする (現在は唯一のサポート方法)
		if (!this.settings.useLoopbackServer) {
			console.log("'useLoopbackServer' を true に強制します (唯一のサポート方法)。");
			this.settings.useLoopbackServer = true;
			// すぐに保存する必要はない。後続のロジック/保存で処理される。
		}

		// ロードされた設定に基づいて OAuth2 クライアントを初期化
		this.reconfigureOAuthClient();

		// トークンが存在する場合は、トークンリスナーをアタッチし、APIを初期化
		if (this.settings.tokens) {
			try {
				this.oauth2Client.setCredentials(this.settings.tokens);
			} catch (e) {
				console.error("ロード時にクレデンシャルの設定でエラー:", e);
				this.settings.tokens = null; // 無効な可能性のあるトークンをクリア
				await this.saveData(this.settings);
			}
			if(this.settings.tokens) { // トークンがクリアされていないか再確認
				this.attachTokenListener(); // 初期セットアップ後にリスナーをアタッチ
				this.initializeCalendarApi(); // トークンが存在すればAPIクライアントを初期化
			}
		}

		// ループバックサーバーを開始 (常に有効)
		await this.stopHttpServer(); // 以前のインスタンスがクリーンに停止されていることを確認
		this.startHttpServer(); // サーバーの起動を試みる (自動ポート検出付き)


		// --- コマンドの登録 ---
		this.addCommand({
			id: 'authenticate-with-google',
			name: 'Google で認証する',
			callback: () => this.authenticate(),
		});

		this.addCommand({
			id: 'sync-tasks-now',
			name: 'Google Calendar と今すぐタスクを同期する',
			callback: async () => {
				// トークンの存在と有効性 (またはリフレッシュの可能性) を確認
				if (!this.settings.tokens || (!this.isTokenValid(false) && !this.isTokenValid(true))) {
					new Notice("認証されていないか、トークンが期限切れ/無効です。設定から認証/再認証してください。");
					return;
				}
				if (this.isSyncing) {
					new Notice("同期は既に進行中です。");
					return;
				}
				new Notice('手動同期を開始しました...');
				await this.syncTasks();
			},
		});

		// --- 設定タブの追加 ---
		this.addSettingTab(new GoogleCalendarSyncSettingTab(this.app, this));
		// --- 自動同期のセットアップ ---
		this.setupAutoSync();
	}

	/**
	 * プラグインがアンロードされるときに実行される処理
	 */
	async onunload() {
		console.log('Google Calendar Sync プラグインをアンロード中');
		this.clearAutoSync(); // インターバルタイマーをクリア
		await this.stopHttpServer(); // アンロード時にサーバーを停止
	}

	/**
	 * OAuth コールバック用のローカル HTTP サーバーを開始します。
	 * 設定されたポートでリッスンを試み、使用中の場合は次のポートを試します。
	 */
	startHttpServer(): void {
		if (this.httpServer) {
			console.log("HTTP サーバーの開始試行はスキップされました: サーバーインスタンスが既に存在します。");
			return;
		}
		// useLoopbackServer 設定のチェックは不要 (常に true と仮定)

		const configuredPort = this.settings.loopbackPort;
		// 設定されたポートの検証
		if (!(configuredPort >= 1024 && configuredPort <= 65535)) {
			new Notice(`無効なポート番号が設定されています (${configuredPort})。サーバーは起動されません。設定で有効なポート (1024-65535) を設定してください。`, 10000);
			console.error(`無効なポート番号が設定されています (${configuredPort})。サーバーは起動されません。`);
			return;
		}

		const maxAttempts = 10; // 試行するポート数 (設定ポート + 次の9ポート)
		let currentAttempt = 0;

		const attemptListen = (portToTry: number) => {
			if (currentAttempt >= maxAttempts) {
				const lastTriedPort = configuredPort + maxAttempts - 1;
				console.error(`サーバーの起動に失敗しました: ポート ${configuredPort} から ${lastTriedPort} までがすべて使用中か、他のエラーが発生しました。`);
				new Notice(`エラー: サーバーを起動できませんでした。ポート ${configuredPort}-${lastTriedPort} が使用中の可能性があります。実行中のアプリケーションを確認するか、設定で別のポートを選択してください。`, 15000);
				this.httpServer = null; // 全試行失敗時に null を保証
				return;
			}
			currentAttempt++;

			// 各試行で新しいサーバーインスタンスを作成
			const server = http.createServer(this.handleHttpRequest.bind(this));

			// --- サーバーイベントハンドラー ---
			server.on('error', (error: NodeJS.ErrnoException) => {
				// リトライ/失敗時にリークを防ぐため、リスナーを直ちにクリーンアップ
				server.removeAllListeners('error');
				server.removeAllListeners('listening');

				if (error.code === 'EADDRINUSE') {
					console.warn(`ポート ${portToTry} は使用中です。次のポート (${portToTry + 1}) を試します...`);
					// 重要: ここで this.httpServer を割り当てない
					// 次のポートで attemptListen を再帰的に呼び出す
					attemptListen(portToTry + 1);
				} else {
					// 他のサーバーエラー (例: パーミッション拒否 - EACCES) を処理
					console.error(`ポート ${portToTry} でのHTTPサーバーエラー:`, error);
					new Notice(`HTTP サーバーエラー (${error.code}): ${error.message}。サーバーは起動されません。コンソールを確認してください。`, 10000);
					this.httpServer = null; // 致命的なエラー時に null を保証
					// EADDRINUSE 以外のエラーではリトライしない
				}
			});

			server.on('listening', async () => { // listening コールバックを非同期にしてデータ保存を行う
				 // リッスン成功時に error リスナーをクリーンアップ
				server.removeAllListeners('error');

				// 成功! 実行中のサーバーインスタンスを割り当て
				this.httpServer = server;
				// サーバーが実際にバインドしたポートを取得
				const successfulPort = (server.address() as net.AddressInfo).port;
				console.log(`HTTPサーバーは http://127.0.0.1:${successfulPort}/oauth2callback で正常にリッスンしています`);

				// 成功したポートが設定されたポートと異なるか確認
				if (successfulPort !== this.settings.loopbackPort) {
					const oldPort = this.settings.loopbackPort;
					console.warn(`アクションが必要です: 設定されたポート ${oldPort} は使用中でした。サーバーは自動的にポート ${successfulPort} で起動されました。`);
					const newRedirectUri = `http://127.0.0.1:${successfulPort}/oauth2callback`;

					// ユーザーのアクションを要求する、永続的で明確な Notice を表示
					const noticeDuration = 30000; // 30秒間表示
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


					// 設定をメモリ内で更新し、直接保存する
					this.settings.loopbackPort = successfulPort;
					try {
						await this.saveData(this.settings);
						console.log(`プラグイン設定 'loopbackPort' が ${oldPort} から ${successfulPort} に更新され、保存されました。`);
						// ここで saveSettings() を呼び出さない - 再設定をトリガーし、サーバーを不必要に再起動する可能性があるため。
						// ユーザーは Google Console を更新する必要がある。プラグイン自体は、次回設定が保存されるかプラグインがリロードされるときに、正しいポートを認証URL生成に使用する。
						// 設定UIをリフレッシュするのが理想的だが、ここから確実に実行するのは複雑。Notice が主要なフィードバックとなる。

					} catch(saveError) {
						console.error("自動更新されたポート設定の保存に失敗しました:", saveError);
						new Notice(`自動選択されたポート (${successfulPort}) の保存中にエラーが発生しました。設定でポートを ${successfulPort} に手動で更新してください。`, 10000);
						// サーバーは実行中だが、保存に失敗した場合、次の Obsidian 再起動時に設定が元に戻る可能性がある。
					}
				}
				// サーバーは、設定されたポートまたは自動選択されたポートで実行中。
			});

			// --- リッスン試行 ---
			try {
				// console.log(`試行 ${currentAttempt}/${maxAttempts}: 127.0.0.1:${portToTry} でのリッスンを試行中...`);
				server.listen(portToTry, '127.0.0.1'); // localhost のみでリッスン
			} catch (syncListenError) {
				// listen() セットアップ中の同期エラーをキャッチ (非同期の 'error' イベントよりは稀)
				 console.error(`ポート ${portToTry} でのリッスン試行中の同期エラー:`, syncListenError);
				 // 'listening' または 'error' の前に同期エラーが発生した場合、リスナーが削除されていることを確認
				 server.removeAllListeners('error');
				 server.removeAllListeners('listening');
				 // ここではリトライしない; 'error' イベントが EADDRINUSE リトライの主要なメカニズム
				 if ((syncListenError as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
					  new Notice(`サーバー起動中の予期せぬエラー: ${syncListenError instanceof Error ? syncListenError.message : String(syncListenError)}。コンソールを確認してください。`, 10000);
					  this.httpServer = null; // 失敗時に null を保証
					  // EADDRINUSE でなかった場合、さらなる試行を停止
					  currentAttempt = maxAttempts; // ループ条件を満たすことでさらなる試行を防ぐ
				 } else {
					  // 同期的に EADDRINUSE が発生した場合 (稀)、'error' イベントがリトライロジックを処理することを期待する。
					  // 'error' が発生しない場合、attemptListen の再帰がそれを処理するかもしれないが、'error' に依存する。
				 }
			}
		};

		// 設定されたポートで最初の試行を開始
		attemptListen(configuredPort);
	}

	/**
	 * 実行中の HTTP サーバーを停止します。
	 */
	async stopHttpServer(): Promise<void> {
		return new Promise((resolve) => {
			if (this.httpServer && this.httpServer.listening) {
				console.log("HTTP サーバーを停止中...");
				this.httpServer.close((err) => {
					if (err) {
						console.error("HTTP サーバーの停止中にエラー:", err);
					} else {
						console.log("HTTP サーバーは正常に停止しました。");
					}
					this.httpServer = null; // エラーに関わらずインスタンスをクリア
					resolve();
				});
			} else {
				// console.log("HTTP サーバーは既に停止しているか、実行されていません。");
				this.httpServer = null; // null であることを保証
				resolve(); // 既に停止しているか、実行されていない
			}
		});
	}

	/**
	 * ローカル HTTP サーバーへのリクエストを処理します (主に OAuth コールバック用)。
	 */
	private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!req.url || !this.httpServer) { // httpServer の存在チェックを追加
			res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Bad Request: URLが指定されていないか、サーバーが準備できていません');
			return;
		}

		// サーバーが実際にリッスンしているホストとポートを決定
		const serverAddress = this.httpServer.address();
		const host = serverAddress && typeof serverAddress === 'object' ? `127.0.0.1:${serverAddress.port}` : `127.0.0.1:${this.settings.loopbackPort}`; // 万が一のためのフォールバック

		let currentUrl: URL;
		try {
			 // 適切な URL 構築を保証
			 const fullUrl = req.url.startsWith('/') ? `http://${host}${req.url}` : req.url;
			 currentUrl = new URL(fullUrl);
		} catch (e) {
			console.error("リクエスト URL の解析エラー:", req.url, e);
			res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Bad Request: 無効な URL フォーマット');
			return;
		}

		// --- OAuth コールバックパスの処理 ---
		if (currentUrl.pathname === '/oauth2callback' && req.method === 'GET') {
			console.log('HTTP サーバーが OAuth コールバックリクエストを受信しました');
			const queryParams = currentUrl.searchParams;
			const params: Record<string, string> = {};
			queryParams.forEach((value, key) => {
				params[key] = value;
			});

			try {
				await this.handleOAuthCallback(params);
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
					<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>認証成功</title><style>body{font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; padding: 30px; text-align: center; background-color: #f0f9f0; color: #333;} h1{color: #28a745;} p{font-size: 1.1em;}</style></head>
					<body><h1>✅ 認証に成功しました！</h1><p>Google Calendar Sync が接続されました。</p><p>このウィンドウを閉じて Obsidian に戻ることができます。</p><script>setTimeout(() => window.close(), 3000);</script></body></html>`);
			} catch (error: any) {
				console.error("HTTP経由でのOAuthコールバック処理中にエラー:", error);
				res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
					 <!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>認証失敗</title><style>body{font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; padding: 30px; color:#333; background-color: #fff8f8;} h1{color: #dc3545;} p{font-size: 1.1em;} .error {color: #c00; font-weight: bold; white-space: pre-wrap; word-break: break-all; text-align: left; background: #eee; padding: 10px; border-radius: 5px;}</style></head>
					<body><h1>❌ 認証に失敗しました</h1><p>Google 認証を完了できませんでした。</p><p>エラー詳細:</p><pre class="error">${error.message || '不明なエラー'}。</pre><p>Obsidian の開発者コンソール (Ctrl+Shift+I または Cmd+Opt+I) で詳細を確認し、クライアント ID/シークレット、およびリダイレクト URI の設定 (特にポート番号が自動変更された場合) を確認してから、プラグイン設定から再度認証を試みてください。</p></body></html>`);
			}
		// --- ファビコンリクエストの処理 (一般的なブラウザリクエスト) ---
		} else if (currentUrl.pathname === '/favicon.ico' && req.method === 'GET') {
			 res.writeHead(204); // No Content
			 res.end();
		// --- ルートパスの処理 (オプション) ---
		} else if (currentUrl.pathname === '/' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Obsidian Google Calendar Sync Plugin - OAuth 用ローカルサーバーがアクティブです。');
		} else {
			console.log(`不明なパスへのリクエストを受信しました: ${currentUrl.pathname}`);
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('404 Not Found');
		}
	}

	/**
	 * Google からのリダイレクト (OAuth コールバック) を処理します。
	 * state の検証、エラーの確認、認証コードのトークンとの交換を行います。
	 */
	private async handleOAuthCallback(params: Record<string, string>): Promise<void> {
		const { code, error, state } = params;
		const currentActiveState = this.activeOAuthState; // クリアされる前にローカルに保存

		// 1. State パラメータの検証 (CSRF 保護)
		if (!currentActiveState) {
			console.warn("アクティブな OAuth state が見つかりません。コールバックを無視します。重複または予期しない可能性があります。");
			throw new Error('アクティブな認証試行が見つかりません。Obsidian の設定から再度認証を開始してください。');
		}
		if (!state || state !== currentActiveState) {
			this.activeOAuthState = null; // 無効な state を直ちにクリア
			console.error('OAuth エラー: 無効な state パラメータを受信しました。', '受信:', state, '期待値:', currentActiveState);
			new Notice('認証失敗: セキュリティトークンの不一致 (無効な state)。再度認証を試みてください。', 10000);
			throw new Error('無効な state パラメータ。認証フローが侵害されたか、タイムアウトした可能性があります。');
		}
		console.log("OAuth state の検証に成功しました。");
		this.activeOAuthState = null; // 検証成功後に有効な state をクリア

		// 2. Google からのエラーを確認
		if (error) {
			console.error('Google によって報告された OAuth エラー:', error);
			const errorDescription = params.error_description ? decodeURIComponent(params.error_description) : '追加の説明はありません。';
			const errorUri = params.error_uri ? decodeURIComponent(params.error_uri) : null;
			let errMsg = `Google 認証失敗: ${error}。 ${errorDescription}`;
			if (errorUri) errMsg += ` 詳細情報: ${errorUri}`;
			new Notice(errMsg, 15000); // エラーの場合は長めの通知
			throw new Error(errMsg); // エラーの説明をスローされるエラーに含める
		}

		// 3. 認証コードが存在することを確認
		if (!code) {
			console.error('OAuth エラー: Google から認証コードが受信されませんでした。');
			new Notice('Google 認証失敗: 認証コードが受信されませんでした。');
			throw new Error('Google からのコールバックに認証コードがありません。');
		}

		// 4. コードをトークンと交換
		try {
			new Notice('認証コードを Google トークンと交換中...', 4000);
			// 現在の設定を使用して一時的なクライアントインスタンスを作成
			// ここで使用されるリダイレクト URI は、認証 URL の生成に使用されたものと一致する必要がある。
			const redirectUriForExchange = this.getRedirectUri(); // 現在の *設定* に基づく URI を使用
			const tokenExchangeClient = new OAuth2Client({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
				redirectUri: redirectUriForExchange,
			});

			console.log(`リダイレクト URI を使用してトークン交換を試行中: ${redirectUriForExchange}`);
			const { tokens } = await tokenExchangeClient.getToken(code);
			console.log('トークンを正常に受信しました。');

			const currentRefreshToken = this.settings.tokens?.refresh_token;
			const newRefreshToken = tokens.refresh_token;

			if (!newRefreshToken && !currentRefreshToken) {
				console.warn("OAuth 警告: リフレッシュトークンが受信されず、以前にも存在しませんでした。オフラインアクセスには後で再認証が必要になる場合があります。");
				new Notice("認証は成功しましたが、Google からリフレッシュトークンが付与されませんでした。オフラインアクセスが必要な場合、定期的に再認証が必要になることがあります。", 10000);
			} else if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
				 console.log("Google から新しいリフレッシュトークンを受信しました。");
			} else if (!newRefreshToken && currentRefreshToken) {
				 console.log("新しいリフレッシュトークンは受信されませんでした。既存のものを保持します。");
			}

			// 新しいトークンを既存のものとマージ (新しいリフレッシュトークンを優先)
			const finalTokens: Credentials = {
				...this.settings.tokens, // 既存のフィールドを保持
				...tokens, // 新しい access_token, expiry_date, scope などで上書き
				refresh_token: newRefreshToken || currentRefreshToken // 利用可能であれば新しいリフレッシュトークンを使用
			};

			// メインプラグインの OAuth クライアントと設定を更新
			this.oauth2Client.setCredentials(finalTokens); // メインクライアントを更新
			this.settings.tokens = finalTokens;

			// saveData を直接使用して、saveSettings の副作用を回避
			await this.saveData(this.settings);

			// 依存コンポーネントを手動で再初期化
			this.initializeCalendarApi(); // API クライアントが新しいトークンを使用するようにする
			this.setupAutoSync(); // 新しいトークン情報でタイマーをリセットする可能性がある
			this.attachTokenListener(); // リスナーがメインクライアントにアタッチされていることを確認

			new Notice('Google 認証に成功しました！', 6000);

		} catch (err: any) {
			console.error('OAuth トークン交換に失敗しました:', err);
			let errorMessage = 'トークン交換中に Google 認証に失敗しました。';
			const responseData = err?.response?.data;
			if (responseData?.error) {
				 errorMessage += ` 詳細: ${responseData.error}`;
				 if (responseData.error_description) {
					 errorMessage += ` - ${responseData.error_description}`;
				 }
				 // 一般的なエラーのヒントを提供
				 if (responseData.error === 'invalid_grant') {
					errorMessage += " (考えられる原因: 認証コードの期限切れ/使用済み、クロックスキュー、*トークンリクエスト* に使用されたリダイレクト URI が正しくない)。";
				 } else if (responseData.error === 'redirect_uri_mismatch') {
					 // トークン交換中のこのエラーは、通常、リクエスト内の URI が Google Console のクライアント ID に事前登録されたものと一致しないことを意味する。
					 errorMessage += ` (トークン交換中に送信されたリダイレクト URI [${this.getRedirectUri()}] が、Google Cloud Console に登録されたものと完全に一致しない可能性があります)。`;
				 } else if (responseData.error === 'invalid_client') {
					  errorMessage += " (設定のクライアント ID および/またはクライアントシークレットを確認してください)。";
				 }
			} else if (err.message) {
				errorMessage += ` エラー: ${err.message}`;
			}
			new Notice(errorMessage + ' Obsidian コンソールで詳細を確認してください。', 15000);
			throw new Error(errorMessage); // 詳細なメッセージとともに再スロー
		}
	}

	/**
	 * 設定データをロードします。
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// taskMap が存在することを確認
		if (!this.settings.taskMap || typeof this.settings.taskMap !== 'object') {
			this.settings.taskMap = {};
		}
		// 削除されたオプションとの整合性のため、ロード時にループバックサーバー設定を強制
		 this.settings.useLoopbackServer = true;
		// ロード時にループバックポートを検証
		if (typeof this.settings.loopbackPort !== 'number' || !Number.isInteger(this.settings.loopbackPort) || this.settings.loopbackPort < 1024 || this.settings.loopbackPort > 65535) {
			console.warn(`無効なループバックポート "${this.settings.loopbackPort}" がロードされました。デフォルト ${DEFAULT_SETTINGS.loopbackPort} にリセットします。`);
			this.settings.loopbackPort = DEFAULT_SETTINGS.loopbackPort;
		}
		// ロード時に期間を検証
		 if (typeof this.settings.defaultEventDurationMinutes !== 'number' || !Number.isInteger(this.settings.defaultEventDurationMinutes) || this.settings.defaultEventDurationMinutes < 5) {
			 console.warn(`無効なデフォルト期間 "${this.settings.defaultEventDurationMinutes}" がロードされました。デフォルト ${DEFAULT_SETTINGS.defaultEventDurationMinutes} にリセットします。`);
			 this.settings.defaultEventDurationMinutes = DEFAULT_SETTINGS.defaultEventDurationMinutes;
		 }
		// ロード時に同期間隔を検証
		 if (typeof this.settings.syncIntervalMinutes !== 'number' || !Number.isInteger(this.settings.syncIntervalMinutes) || this.settings.syncIntervalMinutes < 1) {
			 console.warn(`無効な同期間隔 "${this.settings.syncIntervalMinutes}" がロードされました。デフォルト ${DEFAULT_SETTINGS.syncIntervalMinutes} にリセットします。`);
			 this.settings.syncIntervalMinutes = DEFAULT_SETTINGS.syncIntervalMinutes;
		 }
		// ロード時に lastSyncTime を検証
		if (this.settings.lastSyncTime && !moment(this.settings.lastSyncTime, moment.ISO_8601, true).isValid()) {
			console.warn(`無効な lastSyncTime "${this.settings.lastSyncTime}" がロードされました。クリアします。`);
			this.settings.lastSyncTime = undefined;
		}

	}

	/**
	 * 設定データを保存し、必要な再設定をトリガーします。
	 */
	async saveSettings() {
		await this.saveData(this.settings);
		console.log("設定が保存されました。再設定をトリガーします...");
		// 設定変更後に必要な再設定を実行
		await this.reconfigureAfterSettingsChange();
	}

	/**
	 * 設定変更後にプラグインコンポーネントを再設定するヘルパー関数。
	 * (サーバーが常に 'オン' であるため簡略化)
	 */
	async reconfigureAfterSettingsChange() {
		console.log("設定変更後にプラグインコンポーネントを再設定中...");
		const serverIsRunning = !!this.httpServer && this.httpServer.listening;
		const currentServerPort = serverIsRunning ? (this.httpServer?.address() as net.AddressInfo)?.port : null;

		// 1. OAuth クライアントの再設定
		this.reconfigureOAuthClient();

		// 2. Google Calendar API クライアントの初期化
		this.initializeCalendarApi();

		// 3. 自動同期タイマーのリセット/セットアップ
		this.setupAutoSync();

		// 4. HTTP サーバー状態の管理
		// サーバーは常に実行されているはず。ポート設定の変更により再起動が必要か確認。
		const configuredPort = this.settings.loopbackPort;
		const needsStarting = !serverIsRunning;
		const needsRestartForConfig = serverIsRunning && currentServerPort !== configuredPort;

		if (needsStarting || needsRestartForConfig) {
			 console.log(`HTTP サーバーは ${needsStarting ? '起動' : `再起動 (設定ポート: ${configuredPort}, 実行中ポート: ${currentServerPort})`} が必要です。`);
			 await this.stopHttpServer();
			 this.startHttpServer(); // 起動/再起動 (設定ポートを使用し、再度自動検出する可能性あり)
		} else {
			 // console.log(`HTTP サーバーの状態は変更なし (実行中: ${serverIsRunning}, ポート: ${currentServerPort}, 設定: ${configuredPort})。`);
		}
		console.log("再設定が完了しました。");
	}


	/**
	 * メインの OAuth2 クライアントインスタンスを再設定します。
	 */
	reconfigureOAuthClient() {
		const redirectUri = this.getRedirectUri(); // 現在の設定に基づくリダイレクト URI を取得
		try {
			this.oauth2Client = new OAuth2Client({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
				redirectUri: redirectUri,
			});
		} catch(e) {
			 console.error("OAuth2Client インスタンスの作成中にエラー:", e);
			 // @ts-ignore // 作成に失敗した場合は null を割り当てる
			 this.oauth2Client = null;
			 return; // 続行不可
		}
		// トークンが存在する場合は適用
		if (this.settings.tokens) {
			try { this.oauth2Client.setCredentials(this.settings.tokens); }
			catch (e) { console.error("OAuth クライアント再設定中にクレデンシャル適用エラー:", e); }
		}
		// トークンリスナーをアタッチ
		this.attachTokenListener();
	}

	/**
	 * 'tokens' イベントリスナーを OAuth クライアントにアタッチします (トークン更新の処理用)。
	 */
	attachTokenListener() {
		if (!this.oauth2Client) { console.warn("トークンリスナーをアタッチできません: OAuth クライアントが初期化されていません。"); return; }
		// 既存のリスナーを削除して重複を防ぐ
		this.oauth2Client.removeAllListeners('tokens');
		// 新しいリスナーを追加
		this.oauth2Client.on('tokens', async (tokens) => {
			console.log("OAuth クライアントが 'tokens' イベントを発行しました (おそらくトークンリフレッシュ)。");
			const currentRefreshToken = this.settings.tokens?.refresh_token;
			const newRefreshToken = tokens.refresh_token;

			// 既存のトークンと新しいトークンをマージ (リフレッシュトークンを優先)
			const updatedTokens: Credentials = {
				...this.settings.tokens, // 既存のフィールド (リフレッシュトークンなど) を保持
				...tokens,              // 新しいアクセストークン、有効期限などで上書き
				refresh_token: newRefreshToken || currentRefreshToken // 新しいリフレッシュトークンがあれば使用、なければ既存のものを維持
			};

			if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
				console.log("新しいリフレッシュトークンを受信しました。");
			}

			this.settings.tokens = updatedTokens;
			try {
				 await this.saveData(this.settings); // 更新されたトークンを永続化
				 console.log("更新されたトークンは正常に保存されました。");
				 // トークンが更新されたので、APIクライアントも再初期化/更新
				 this.initializeCalendarApi();
			} catch (saveError) {
				 console.error("更新されたトークンの保存に失敗しました:", saveError);
				 new Notice("更新された Google トークンの保存中にエラーが発生しました。コンソールを確認してください。", 5000);
			}
		});
	}

	/**
	 * Google Calendar API サービスクライアントを初期化します。
	 * 有効な OAuth クライアントとトークンが必要です。
	 */
	initializeCalendarApi() {
		if (!this.oauth2Client) {
			console.warn("Calendar API を初期化できません: OAuth クライアントが設定されていません。");
			if (this.calendar) this.calendar = null; // 既存のクライアントがあればクリア
			return;
		}
		if (this.settings.tokens && this.oauth2Client.credentials?.access_token) {
			// calendar インスタンスが存在しないか、認証クライアントが異なる場合にのみ再作成
			if (!this.calendar || (this.calendar as any)._options?.auth !== this.oauth2Client) {
				 try {
					this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
					console.log('Google Calendar API クライアントが初期化または更新されました。');
				 } catch(e) {
					 console.error("Google Calendar API クライアントの初期化に失敗しました:", e);
					 this.calendar = null;
				 }
			}
		} else {
			// トークンがない、またはアクセストークンがない場合は、APIクライアントをクリア
			if (this.calendar) {
				console.log('Google Calendar API クライアントを解除します (トークン欠落または無効なクライアント)。');
				this.calendar = null;
			}
		}
	}

	/**
	 * Google OAuth 認証フローを開始します。
	 * ブラウザウィンドウを開き、ユーザーに承認を求めます。
	 */
	authenticate() {
		// クライアントIDとシークレットが設定されているか確認
		if (!this.settings.clientId || !this.settings.clientSecret) {
			new Notice('認証失敗: クライアント ID とクライアントシークレットを設定する必要があります。', 7000);
			return;
		}
		// OAuthクライアントが最新の設定を使用するように再設定
		this.reconfigureOAuthClient();
		if (!this.oauth2Client) {
			new Notice('認証失敗: OAuth クライアントを設定できませんでした。コンソールを確認してください。', 7000);
			return;
		}

		// 現在のリダイレクトURIを取得し、有効か確認
		const currentRedirectUri = this.getRedirectUri();
		if (!currentRedirectUri || !currentRedirectUri.startsWith('http')) {
			new Notice('認証失敗: 無効なリダイレクト URI です。ポート設定を確認してください。', 10000);
			console.error("無効なリダイレクト URI:", currentRedirectUri);
			return;
		}

		// ユーザーにリダイレクトURIをGoogle Cloud Consoleに追加するよう促す
		new Notice(`このリダイレクト URI を Google Cloud Console に追加してください:\n${currentRedirectUri}`, 15000);

		try {
			// CSRF対策のためのランダムなstate値を生成
			this.activeOAuthState = randomBytes(16).toString('hex');
			console.log("生成された OAuth state:", this.activeOAuthState);

			// 認証URLを生成
			const authUrl = this.oauth2Client.generateAuthUrl({
				access_type: 'offline', // リフレッシュトークンを取得するため
				scope: ['https://www.googleapis.com/auth/calendar.events'], // カレンダーイベントへのアクセス権限
				prompt: 'consent', // 常に同意画面を表示 (リフレッシュトークン再取得のため)
				state: this.activeOAuthState, // CSRF対策
				redirect_uri: currentRedirectUri // コールバックを受け取るURI
			});

			// 認証URLをブラウザで開く
			console.log('Google 認証 URL を開いています...');
			window.open(authUrl);
			new Notice('開いたブラウザウィンドウでこのプラグインを承認してください。', 7000);
		} catch (error) {
			this.activeOAuthState = null; // エラー発生時はstateをクリア
			console.error("Google 認証 URL の生成中にエラー:", error);
			new Notice(`認証の開始に失敗しました: ${error instanceof Error ? error.message : '不明なエラー'}。コンソールを参照してください。`, 10000);
		}
	}

	/**
	 * OAuth トークンが有効かどうかを確認します。
	 * @param checkRefresh true の場合、リフレッシュトークンの存在のみを確認します。false の場合、アクセストークンの有効期限を確認します。
	 * @returns トークンが有効な場合は true、そうでない場合は false。
	 */
	isTokenValid(checkRefresh: boolean = false): boolean {
		const tokens = this.settings.tokens;
		if (!tokens) return false; // トークン自体がない

		if (checkRefresh) {
			// リフレッシュトークンの存在を確認
			return !!tokens.refresh_token;
		} else {
			// アクセストークンの有効性を確認
			if (!tokens.access_token) return false; // アクセストークンがない
			// 有効期限を確認 (5分間の猶予を持たせる)
			if (tokens.expiry_date) {
				return tokens.expiry_date > Date.now() + (5 * 60 * 1000);
			}
			// 有効期限がない場合 (稀だが)、有効とみなす (ただし、API呼び出しは失敗する可能性あり)
			return true;
		}
	}

	/**
	 * 自動同期を設定します。設定に基づいてインターバルタイマーを開始します。
	 * 同期処理が既に実行中の場合はスキップします。
	 */
	setupAutoSync() {
		this.clearAutoSync(); // 既存のタイマーがあればクリア

		if (this.settings.autoSync && this.settings.syncIntervalMinutes >= 1) {
			const intervalMillis = this.settings.syncIntervalMinutes * 60 * 1000;
			console.log(`自動同期を ${this.settings.syncIntervalMinutes} 分ごとに設定します。`);

			this.syncIntervalId = window.setInterval(async () => {
				const timestamp = moment().format('HH:mm:ss');
				console.log(`[${timestamp}] 自動同期がトリガーされました。`);

				if (this.isSyncing) { // 同期中フラグを確認
					console.warn(`[${timestamp}] 自動同期: スキップされました。前回の同期がまだ実行中です。`);
					return;
				}

				if (!this.settings.tokens || !this.oauth2Client?.credentials?.access_token) {
					console.warn(`[${timestamp}] 自動同期: スキップします。認証されていません。`);
					return;
				}

				// アクセストークンの有効性を確認
				if (!this.isTokenValid(false)) {
					console.log(`[${timestamp}] 自動同期: アクセストークンが期限切れまたは欠落しています。`);
					// リフレッシュトークンがあるか確認
					if (this.isTokenValid(true)) {
						console.log(`[${timestamp}] 自動同期: トークンリフレッシュを試行中...`);
						try {
							// クライアントが最新であることを確認
							this.reconfigureOAuthClient();
							if (!this.oauth2Client) throw new Error("リフレッシュ用の OAuth クライアントが利用できません。");

							// トークンをリフレッシュ
							await this.oauth2Client.refreshAccessToken();

							// リフレッシュ後にトークンが有効になったか再確認
							if (this.isTokenValid(false)) {
								console.log(`[${timestamp}] 自動同期: トークンのリフレッシュに成功しました。`);
								new Notice('Google トークンが自動的に更新されました。', 4000);
							} else {
								// リフレッシュは成功したが、なぜかトークンがまだ無効
								console.error(`[${timestamp}] 自動同期: トークンのリフレッシュは成功しましたが、トークンはまだ無効です。`);
								new Notice('自動同期: トークンリフレッシュの問題。コンソールを確認してください。', 5000);
								return; // 同期をスキップ
							}
						} catch (error: any) {
							console.error(`[${timestamp}] 自動同期: トークンのリフレッシュに失敗しました:`, error);
							const respErr = error?.response?.data?.error;
							if (respErr === 'invalid_grant') {
								// リフレッシュトークンが無効 (失効、取り消しなど)
								new Notice('自動同期失敗: リフレッシュトークンが無効です。再認証してください。', 15000);
								this.settings.tokens = null; // 無効なトークンをクリア
								await this.saveData(this.settings); // 設定を保存
								this.clearAutoSync(); // 自動同期を停止
								this.initializeCalendarApi(); // APIクライアントをクリア
							} else {
								// その他のリフレッシュエラー (ネットワーク問題など)
								new Notice(`自動同期: トークンのリフレッシュに失敗しました (${respErr || '不明なエラー'})。接続を確認するか、再認証してください。`, 10000);
							}
							return; // リフレッシュ失敗時は同期をスキップ
						}
					} else {
						// アクセストークンが無効で、リフレッシュトークンもない
						console.warn(`[${timestamp}] 自動同期: トークンが期限切れで、リフレッシュトークンが利用できません。`);
						new Notice('自動同期スキップ: トークンが期限切れです。再認証してください。', 10000);
						this.clearAutoSync(); // 自動同期を停止
						this.initializeCalendarApi(); // APIクライアントをクリア
						return;
					}
				}

				// 同期処理を実行
				console.log(`[${timestamp}] 自動同期: タスク同期を実行中...`);
				await this.syncTasks(); // ここで同期処理を呼び出す
				console.log(`[${timestamp}] 自動同期: 同期が完了しました。`);

			}, intervalMillis);

			console.log(`自動同期タイマーが開始されました (ID: ${this.syncIntervalId})。次回の実行は約 ${moment().add(intervalMillis, 'ms').format('HH:mm')} です。`);
		} else {
			console.log(`自動同期は無効です (有効: ${this.settings.autoSync}, 間隔: ${this.settings.syncIntervalMinutes} 分)。`);
		}
	}

	/**
	 * 自動同期のインターバルタイマーをクリアします。
	 */
	clearAutoSync() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			console.log("自動同期タイマーが停止されました。");
		}
	}


	// --- タスク解析ロジック ---

	/**
	 * Vault 内のすべての Markdown ファイルからタスクを抽出します。
	 * 'templates/' パスを含むファイルはスキップします。
	 * @returns {Promise<ObsidianTask[]>} 解析されたタスクの配列
	 */
	async getObsidianTasks(): Promise<ObsidianTask[]> {
		console.time("getObsidianTasks"); // パフォーマンス計測開始
		const tasks: ObsidianTask[] = [];
		const mdFiles = this.app.vault.getMarkdownFiles(); // Vault内の全Markdownファイルを取得

		// 各ファイルを非同期で処理
		const filePromises = mdFiles.map(async (file) => {
			// 'templates/' パスを含むファイルはスキップ
			if (file.path.toLowerCase().includes('templates/')) {
				return [];
			}
			try {
				// ファイルの内容を読み込む (キャッシュではなく最新の内容を取得)
				const content = await this.app.vault.read(file);
				const lines = content.split('\n'); // 行ごとに分割
				const fileTasks: ObsidianTask[] = [];

				// 各行を処理してタスクを解析
				lines.forEach((line, index) => {
					const task = this.parseObsidianTask(line, file.path, index);
					if (task) {
						fileTasks.push(task); // 解析できたタスクを配列に追加
					}
				});
				return fileTasks;
			} catch (e) {
				console.warn(`ファイル "${file.path}" の読み込み/解析ができませんでした`, e);
				return []; // エラー時は空配列を返す
			}
		});

		// すべてのファイルの処理結果を待つ
		const results = await Promise.all(filePromises);
		// 各ファイルから抽出したタスクを統合
		results.forEach(fileTasks => tasks.push(...fileTasks));

		console.timeEnd("getObsidianTasks"); // パフォーマンス計測終了
		console.log(`Vault 内で ${tasks.length} 個のタスクが見つかりました。`);
		return tasks;
	}

	/**
	 * Markdown の1行を解析して ObsidianTask オブジェクトに変換します。
	 * Tasks プラグインの形式 (絵文字またはテキスト) を認識します。
	 * @param {string} line 解析する行のテキスト
	 * @param {string} filePath タスクが含まれるファイルのパス
	 * @param {number} lineNumber タスクが含まれるファイルの行番号 (0-based)
	 * @returns {ObsidianTask | null} 解析されたタスクオブジェクト、またはタスクでない場合は null
	 */
	parseObsidianTask(line: string, filePath: string, lineNumber: number): ObsidianTask | null {
		// 基本的なタスク形式の正規表現: `- [ ] Task content`
		const taskRegex = /^\s*-\s*\[(.)\]\s*(.*)/;
		const match = line.match(taskRegex);
		if (!match) return null; // タスク形式でなければ null

		const checkbox = match[1].trim();
		let taskContent = match[2].trim();
		const isCompleted = checkbox !== ' ' && checkbox !== ''; // チェックボックスが空でないか

		// 日付/時刻の正規表現 (ISO 8601 または YYYY-MM-DD)
		const isoOrSimpleDateRegex = `\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?)?`;
		const simpleDateRegexOnly = `\\d{4}-\\d{2}-\\d{2}`; // YYYY-MM-DD のみ

		// 各種メタデータの正規表現 (絵文字 + テキスト形式)
		const dueDateMatch = taskContent.match(new RegExp(`(?:📅|due:)\\s*(${isoOrSimpleDateRegex})`));
		const startDateMatch = taskContent.match(new RegExp(`(?:🛫|start:)\\s*(${isoOrSimpleDateRegex})`));
		const scheduledDateMatch = taskContent.match(new RegExp(`(?:⏳|scheduled:)\\s*(${isoOrSimpleDateRegex})`));
		const createdDateMatch = taskContent.match(new RegExp(`(?:➕|created:)\\s*(${simpleDateRegexOnly})`));
		const completionDateMatch = taskContent.match(new RegExp(`(?:✅|done:)\\s*(${simpleDateRegexOnly})`));
		const priorityMatch = taskContent.match(/(?:🔺|⏫|🔼|🔽|⏬)/); // 優先度絵文字
		const recurrenceMatch = taskContent.match(/(?:🔁|repeat:|recur:)\s*([^📅🛫⏳➕✅🔺⏫🔼🔽⏬#^]+)/); // 繰り返しルール (絵文字や他のメタデータ区切り文字を含まない部分)
		const tagsMatch = taskContent.match(/#[^\s#]+/g); // タグ (#tag)
		const blockLinkMatch = taskContent.match(/\s+(\^[a-zA-Z0-9-]+)$/); // 行末のブロックリンク (^linkid)

		// マッチ結果から値を取得
		const dueDate = dueDateMatch ? dueDateMatch[1] : null;
		const startDate = startDateMatch ? startDateMatch[1] : null;
		const scheduledDate = scheduledDateMatch ? scheduledDateMatch[1] : null;
		const createdDate = createdDateMatch ? createdDateMatch[1] : null;
		const completionDate = completionDateMatch ? completionDateMatch[1] : null;

		// 優先度をマッピング
		const priorityEmoji = priorityMatch ? priorityMatch[0] : null;
		let priority: ObsidianTask['priority'] = null;
		if (priorityEmoji) {
			switch (priorityEmoji) {
				case '🔺': priority = 'highest'; break;
				case '⏫': priority = 'high'; break;
				case '🔼': priority = 'medium'; break;
				case '🔽': priority = 'low'; break;
				case '⏬': priority = 'lowest'; break;
			}
		}

		// 繰り返しルールを解析 (RRULE 文字列に変換を試みる)
		const recurrenceRuleText = recurrenceMatch ? recurrenceMatch[1].trim() : null;
		// RRULE の DTSTART のヒントとして、開始日、期限日、予定日の順で優先的に使用
		const recurrenceRefDate = startDate || dueDate || scheduledDate;
		const recurrenceRule = recurrenceRuleText ? this.parseRecurrenceRule(recurrenceRuleText, recurrenceRefDate) : null;

		// タグとブロックリンクを取得
		const tags = tagsMatch ? tagsMatch.map(t => t.substring(1)) : []; // #を除去
		const blockLink = blockLinkMatch ? blockLinkMatch[1] : null;

		// タスク内容からメタデータを除去してサマリーを生成
		let summary = taskContent;
		const patternsToRemove = [ // 除去する絵文字/キーワード
			/(?:📅|due:)\s*/, /(?:🛫|start:)\s*/, /(?:⏳|scheduled:)\s*/,
			/(?:➕|created:)\s*/, /(?:✅|done:)\s*/, /(?:🔁|repeat:|recur:)\s*/,
			/[🔺⏫🔼🔽⏬]\s*/,
		];
		// 抽出した値 (日付、ルールテキスト、ブロックリンク) を除去
		[dueDate, startDate, scheduledDate, createdDate, completionDate, recurrenceRuleText, blockLink].forEach(val => {
			if (val) summary = summary.replace(val, '');
		});
		// パターンを除去
		patternsToRemove.forEach(pattern => summary = summary.replace(pattern, ''));
		// タグを除去
		if (tagsMatch) tagsMatch.forEach(tag => summary = summary.replace(tag, ''));
		// 行末のブロックリンクを除去 (^ をエスケープ)
		if (blockLink) {
			summary = summary.replace(new RegExp(`\\s*${blockLink.replace('^', '\\^')}$`), '');
		}
		// 余分なスペースを整理
		summary = summary.replace(/\s{2,}/g, ' ').trim();

		// タスクIDを生成 (ファイルパス + 行番号 + 行内容のハッシュ)
		// これにより、行内容が少し変わっても別のタスクとして認識される
		const rawTextForHash = line.trim();
		let hash = 0;
		for (let i = 0; i < rawTextForHash.length; i++) {
			const char = rawTextForHash.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash |= 0; // 32bit 整数に変換
		}
		const taskId = `obsidian-${filePath}-${lineNumber}-${hash}`;

		return {
			id: taskId,
			rawText: line,
			summary: summary || "無題のタスク", // サマリーが空ならデフォルト値
			isCompleted: isCompleted,
			dueDate: dueDate,
			startDate: startDate,
			scheduledDate: scheduledDate,
			createdDate: createdDate,
			completionDate: completionDate,
			priority: priority,
			recurrenceRule: recurrenceRule, // 解析された RRULE 文字列
			tags: tags,
			blockLink: blockLink,
			sourcePath: filePath,
			sourceLine: lineNumber
		};
	}

	/**
	 * 繰り返しルールのテキスト (自然言語または RRULE 形式) を解析し、
	 * iCalendar 標準の RRULE 文字列に変換を試みます。
	 * @param {string} ruleText 繰り返しルールのテキスト (例: "every week", "RRULE:FREQ=DAILY;INTERVAL=2")
	 * @param {string | null} dtstartHint RRULE の DTSTART のヒントとなる日付文字列 (YYYY-MM-DD or ISO 8601)
	 * @returns {string | null} 解析された RRULE 文字列、または解析不能な場合は null
	 */
	parseRecurrenceRule(ruleText: string, dtstartHint: string | null): string | null {
		ruleText = ruleText.toLowerCase().trim();
		let finalRruleString: string | null = null;

		// まず、有効な RRULE 文字列かどうかを確認
		if (ruleText.toUpperCase().startsWith('RRULE:') || ruleText.toUpperCase().startsWith('FREQ=')) {
			 try {
				// 'RRULE:' プレフィックスがない場合は追加
				const ruleInput = ruleText.toUpperCase().startsWith('RRULE:') ? ruleText : `RRULE:${ruleText}`;
				// rrulestr でパースを試みる (forceset: true で不足値を補完)
				const rule = rrulestr(ruleInput, { forceset: true });

				// DTSTART が設定されておらず、ヒントがある場合は設定する
				if (!rule.options.dtstart && dtstartHint) {
					const pDate = moment.utc(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true);
					if(pDate.isValid()) {
						rule.options.dtstart = pDate.toDate(); // UTC Date オブジェクト
					} else {
						// ヒントが無効な場合は今日の日付を使用
						console.warn(`RRULE 解析のための無効な dtstartHint "${dtstartHint}"。今日を使用します。`);
						rule.options.dtstart = moment().startOf('day').toDate();
					}
				} else if (!rule.options.dtstart) {
					// DTSTART がなく、ヒントもない場合は今日の日付を使用
					rule.options.dtstart = moment().startOf('day').toDate();
					console.warn(`RRULE "${ruleText}" に DTSTART がありません。今日を使用します。`);
				}
				// RRULE オブジェクトを文字列に変換 (DTSTART が追加されている可能性あり)
				finalRruleString = rule.toString();
			 } catch (e) {
				 console.warn(`直接的な RRULE パースに失敗: "${ruleText}"`, e);
				 // 直接パースが失敗した場合、簡略化された自然言語パースにフォールバック
			 }
			 // 直接パース (および DTSTART の追加) が成功した場合は結果を返す
			 if (finalRruleString) return finalRruleString;
		}

		// --- 簡略化された自然言語パース (直接 RRULE が失敗した場合 or 提供されなかった場合) ---
		let dtstartDate: Date;
		// dtstartHint から Date オブジェクトを生成 (UTC として扱う)
		if (dtstartHint) {
			const pDate = moment.utc(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true);
			dtstartDate = pDate.isValid() ? pDate.toDate() : moment().startOf('day').toDate();
		} else {
			dtstartDate = moment().startOf('day').toDate(); // ヒントがなければ今日
		}

		let options: Partial<RRuleOptions> = { dtstart: dtstartDate }; // RRule オプション
		let freq: Frequency | null = null; // 頻度 (DAILY, WEEKLY, etc.)
		let interval = 1; // 間隔

		// "every X unit" (例: "every 2 days", "every 1 week")
		const intMatch = ruleText.match(/every\s+(\d+)\s+(day|week|month|year)s?/);
		if (intMatch) {
			interval = parseInt(intMatch[1], 10);
			const unit = intMatch[2];
			if (unit === 'day') freq = Frequency.DAILY;
			else if (unit === 'week') freq = Frequency.WEEKLY;
			else if (unit === 'month') freq = Frequency.MONTHLY;
			else if (unit === 'year') freq = Frequency.YEARLY;
		} else {
			// "every unit" (例: "every day", "every week")
			const simpleIntMatch = ruleText.match(/every\s+(day|week|month|year)s?/);
			if (simpleIntMatch) {
				interval = 1;
				const unit = simpleIntMatch[1];
				if (unit === 'day') freq = Frequency.DAILY;
				else if (unit === 'week') freq = Frequency.WEEKLY;
				else if (unit === 'month') freq = Frequency.MONTHLY;
				else if (unit === 'year') freq = Frequency.YEARLY;
			} else {
				// 単純なキーワード (例: "daily", "weekly", "monthly", "yearly", "annually")
				if (ruleText.includes('daily')) freq = Frequency.DAILY;
				else if (ruleText.includes('weekly')) freq = Frequency.WEEKLY;
				else if (ruleText.includes('monthly')) freq = Frequency.MONTHLY;
				else if (ruleText.includes('yearly') || ruleText.includes('annually')) freq = Frequency.YEARLY;

				// "every X weeks" (週次の場合の代替間隔指定)
				const altIntMatch = ruleText.match(/every\s*(\d+)\s*weeks?/);
				if (altIntMatch && freq === Frequency.WEEKLY) {
					interval = parseInt(altIntMatch[1], 10);
				}
			}
		}

		// 修飾子 (BYDAY, BYMONTHDAY) - 今はシンプルに保つ
		if (freq === Frequency.MONTHLY) {
			// "on the 15th" のような形式を認識
			const dMatch = ruleText.match(/on the\s+(\d+)(?:st|nd|rd|th)?/);
			if (dMatch) {
				const day = parseInt(dMatch[1], 10);
				if (day >= 1 && day <= 31) options.bymonthday = [day];
			}
		}
		if (freq === Frequency.WEEKLY) {
			const wdMap: { [k: string]: any } = { mon: RRule.MO, tue: RRule.TU, wed: RRule.WE, thu: RRule.TH, fri: RRule.FR, sat: RRule.SA, sun: RRule.SU };
			const wds: any[] = [];
			if (ruleText.includes('weekday')) wds.push(RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR); // 平日
			else if (ruleText.includes('weekend')) wds.push(RRule.SA, RRule.SU); // 週末
			else {
				// 特定の曜日が言及されているかチェック (例: "on mon, wed, fri")
				ruleText.split(/[\s,]+/).forEach(p => {
					const dMatch = p.match(/^(mon|tue|wed|thu|fri|sat|sun)/);
					if (dMatch && wdMap[dMatch[1]]) {
						const rDay = wdMap[dMatch[1]];
						// 重複を避ける
						if (!wds.some(ex => ex.weekday === rDay.weekday)) {
							wds.push(rDay);
						}
					}
				});
			}
			if (wds.length > 0) options.byweekday = wds; // 曜日指定があればオプションに追加
		}

		// 頻度が決定できれば、RRule オブジェクトを作成し、文字列に変換
		if (freq !== null) {
			options.freq = freq;
			options.interval = interval > 0 ? interval : 1; // 間隔は1以上
			try {
				const rule = new RRule(options as RRuleOptions); // オプションから RRule を生成
				finalRruleString = rule.toString(); // RRULE 文字列に変換
			} catch (e) {
				console.warn(`解析されたオプションからの RRULE 生成に失敗:`, options, e);
				finalRruleString = null; // エラー時は null
			}
		} else {
			console.warn(`ルールテキストから頻度を決定できませんでした: "${ruleText}"`);
			finalRruleString = null; // 頻度が不明なら null
		}
		return finalRruleString;
	}


	// --- タスクマッピングロジック ---

	/**
	 * ObsidianTask オブジェクトを Google Calendar イベントの入力オブジェクトに変換します。
	 * @param {ObsidianTask} task 変換する Obsidian タスク
	 * @returns {GoogleCalendarEventInput} Google Calendar API 用のイベントオブジェクト
	 */
	mapObsidianTaskToGoogleEvent(task: ObsidianTask): GoogleCalendarEventInput {
		const event: GoogleCalendarEventInput = {
			// イベントのタイトル (タスクのサマリー)
			summary: task.summary || '無題のタスク',
			// 拡張プロパティに Obsidian タスク ID とプラグイン識別子を保存
			extendedProperties: {
				private: {
					obsidianTaskId: task.id, // Obsidian タスク ID
					isGcalSync: 'true'        // このプラグインによって作成されたことを示すフラグ
				}
			},
			// イベントの説明欄を生成
			description: this.buildEventDescription(task),
			// ステータス: Obsidian タスクが完了なら 'cancelled', 未完了なら 'confirmed'
			status: task.isCompleted ? 'cancelled' : 'confirmed',
			// `start`, `end`, `recurrence` は後続のロジックで設定される
		};

		// 開始日 (🛫) と 期限日 (📅) を使ってイベントの時間を設定
		// 注意: syncTasks でフィルタリングされるため、通常はこの関数が呼ばれる時点で
		// task.startDate と task.dueDate は両方存在しているはず。
		if (task.startDate && task.dueDate) {
			this.setEventTimeUsingStartDue(event, task);
		} else {
			// startDate または dueDate が欠けている場合 (フィルタリングを通過した場合のエラーケース)
			console.warn(`タスク "${task.summary || task.id}" は開始日または期限日が欠落しているため、デフォルトの終日イベントとして設定されます。`);
			this.setDefaultEventTime(event); // デフォルトの終日イベントを設定
			event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 開始日/期限日の欠落)`;
		}

		// 繰り返しルールが存在し、かつイベントに開始時刻が設定されている場合に設定
		if (task.recurrenceRule && event.start) {
			// ルールの使用を試みる; RRULE: で始まることを確認
			let rruleString = task.recurrenceRule.toUpperCase();
			if (!rruleString.startsWith('RRULE:')) {
				rruleString = `RRULE:${rruleString}`; // RRULE: プレフィックスを追加
			}
			// 基本的な検証
			try {
				rrulestr(rruleString); // パース可能かチェック
				event.recurrence = [rruleString]; // 有効なら設定
			} catch (e) {
				 // 無効な RRULE 文字列の場合は警告し、設定しない
				 console.warn(`タスク "${task.summary || task.id}" の無効な RRULE 文字列: ${task.recurrenceRule}。繰り返しをスキップします。`, e);
				 delete event.recurrence; // 無効なルールが追加されないように削除
			}
		} else {
			delete event.recurrence; // ルールがない、または開始時刻がない場合は削除
		}

		return event;
	}

	/**
	 * Google Calendar イベントの説明欄の内容を生成します。
	 * Obsidian ノートへのリンクや、設定に基づいてメタデータを含めます。
	 * @param {ObsidianTask} task 説明を生成する対象のタスク
	 * @returns {string} 生成された説明文字列
	 */
	private buildEventDescription(task: ObsidianTask): string {
		let descParts: string[] = [];

		// Obsidian URI リンクを追加 (可能な場合)
		try {
			const vaultName = this.app.vault.getName();
			const encodedVault = encodeURIComponent(vaultName);
			const encodedPath = encodeURIComponent(task.sourcePath);
			// ブロックリンクまたは行番号へのリンクを追加 (ブロックリンク優先)
			let linkSuffix = '';
			if (task.blockLink) {
				linkSuffix = `#${task.blockLink}`; // ブロックリンクがあれば追加
			} else if (task.sourceLine !== undefined) {
				// 行番号への直接リンクはブロックリンクほど堅牢ではない可能性があるため、
				// ここでは省略することも検討できる。
				// linkSuffix = `#L${task.sourceLine + 1}`; // 行リンクが必要な場合の例 (1-based)
			}
			// Obsidian URI を生成: obsidian://open?vault=...&file=...#^blockid
			descParts.push(`Obsidian ノート: obsidian://open?vault=${encodedVault}&file=${encodedPath}${linkSuffix}`);
		} catch (e) {
			// URI 生成に失敗した場合のフォールバック
			console.warn("Obsidian URI の生成に失敗しました", e);
			descParts.push(`Obsidian ソース: "${task.sourcePath}" (Line ${task.sourceLine + 1})`);
		}

		let metaParts: string[] = []; // メタデータ部分

		// 設定に基づいて優先度を追加
		if (this.settings.syncPriorityToDescription && task.priority) {
			const priorityMap = { highest: '🔺 最高', high: '⏫ 高', medium: '🔼 中', low: '🔽 低', lowest: '⏬ 最低' };
			metaParts.push(`優先度: ${priorityMap[task.priority] || task.priority}`);
		}
		// 設定に基づいてタグを追加
		if (this.settings.syncTagsToDescription && task.tags.length > 0) {
			metaParts.push(`タグ: ${task.tags.map(t => `#${t}`).join(' ')}`);
		}
		// 作成日を追加 (存在する場合)
		if (task.createdDate) {
			metaParts.push(`作成日: ${task.createdDate}`);
		}
		// 設定に基づいて予定日を追加 (存在する場合)
		if (this.settings.syncScheduledDateToDescription && task.scheduledDate) {
			metaParts.push(`予定日: ${task.scheduledDate}`);
		}
		// 完了日を追加 (完了していて存在する場合)
		if (task.completionDate && task.isCompleted) {
			metaParts.push(`完了日: ${task.completionDate}`);
		}

		// メタデータがあれば区切り線と共に追加
		if (metaParts.length > 0) {
			descParts.push('---'); // 区切り線
			descParts.push(...metaParts);
		}

		// ブロックリンクを説明に追加するオプションは削除 (Obsidian URI に統合)
		// if (this.settings.syncBlockLinkToDescription && task.blockLink) { descParts.push(`Obsidian ブロックリンク: [[${task.sourcePath}#${task.blockLink}]]`); }

		return descParts.join('\n'); // 各部分を改行で結合
	}

	/**
	 * タスクの開始日 (Start Date 🛫) と期限日 (Due Date 📅) を使用して、
	 * Google Calendar イベントの開始時刻と終了時刻を設定します。
	 * この関数は、startDate と dueDate の両方が存在する場合にのみ呼び出されることを前提としています。
	 * @param {GoogleCalendarEventInput} event 設定対象のイベントオブジェクト (参照渡し)
	 * @param {ObsidianTask} task 日付情報を持つタスク
	 */
	 private setEventTimeUsingStartDue(event: GoogleCalendarEventInput, task: ObsidianTask): void {
		const startStr = task.startDate; // YYYY-MM-DD or ISO 8601
		const dueStr = task.dueDate;     // YYYY-MM-DD or ISO 8601

		// startStr と dueStr は null でないはず (syncTasks でフィルタリングされるため)
		if (!startStr || !dueStr) {
			console.error(`タスク "${task.summary || task.id}" が開始日と期限日の両方がない状態で setEventTimeUsingStartDue に到達しました。これは発生すべきではありません。時間をデフォルト設定します。`);
			this.setDefaultEventTime(event); // デフォルト時間を設定
			event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 内部エラー、日付欠落)`;
			return;
		}

		// 日付文字列に 'T' が含まれるかで、時刻情報があるかを判断
		const startIsDateTime = startStr.includes('T');
		const dueIsDateTime = dueStr.includes('T');

		let startMoment: moment.Moment | null = null;
		let dueMoment: moment.Moment | null = null;

		// 日付をパース (検証し、UTCとして扱う)
		// moment.utc を使用し、ISO 8601 と YYYY-MM-DD の両方の形式を許可 (strict モード: true)
		startMoment = moment.utc(startStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);
		if (!startMoment.isValid()) startMoment = null; // パース失敗時は null

		dueMoment = moment.utc(dueStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);
		if (!dueMoment.isValid()) dueMoment = null; // パース失敗時は null

		// パースに失敗した場合 (フィルタリング後だが念のため)
		if (!startMoment || !dueMoment) {
				console.error(`タスク "${task.summary || task.id}" の日付パースが setEventTimeUsingStartDue 内で失敗しました (フィルタリング後)。開始: ${startStr}, 期限: ${dueStr}。時間をデフォルト設定します。`);
				this.setDefaultEventTime(event);
				event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 内部エラー、日付パース失敗)`;
				return;
		}


		// --- イベントタイミングの決定 ---

		// 開始日または期限日のどちらか一方でも時刻情報がない場合 -> 終日イベントとして扱う
		if (!startIsDateTime || !dueIsDateTime) {
			// 終日イベント ( potentially spanning multiple days )
			// start.date は開始日 (YYYY-MM-DD)
			event.start = { date: startMoment.format('YYYY-MM-DD') };
			// end.date は終了日の *翌日* を指定 (GCal API の終日イベントの仕様)
			event.end = { date: dueMoment.add(1, 'day').format('YYYY-MM-DD') };

			// 終日の場合、終了日が開始日より後であることを保証
			if (moment(event.end.date).isSameOrBefore(moment(event.start.date))) {
				console.warn(`タスク "${task.summary || task.id}": 終日イベントの終了日 (${dueMoment.subtract(1, 'day').format('YYYY-MM-DD')}) が開始日 (${startMoment.format('YYYY-MM-DD')}) より前または同じです。終了日を開始日 + 1日に設定します。`);
				event.end = { date: startMoment.clone().add(1, 'day').format('YYYY-MM-DD') };
			}
		} else {
			// 開始日と期限日の両方に時刻情報がある場合 -> 特定時刻のイベントとして扱う
			// start.dateTime は ISO 8601 形式 (UTC オフセットを保持)
			event.start = { dateTime: startMoment.toISOString(true) };
			// end.dateTime は ISO 8601 形式 (UTC オフセットを保持)
			event.end = { dateTime: dueMoment.toISOString(true) };

			// 終了時刻が開始時刻より後であることを保証
			if (dueMoment.isSameOrBefore(startMoment)) {
				console.warn(`タスク "${task.summary || task.id}": 終了時刻 (${dueMoment.toISOString()}) が開始時刻 (${startMoment.toISOString()}) より前または同じです。終了時刻を開始時刻 + デフォルト期間に調整します。`);
				// 終了時刻を開始時刻 + 設定されたデフォルト期間に設定
				event.end = { dateTime: startMoment.clone().add(this.settings.defaultEventDurationMinutes, 'minutes').toISOString(true) };
			}
		}


		// 最終チェック: start/end が適切に定義されているか確認
		if (!event.start || !event.end ||
			(!event.start.date && !event.start.dateTime) || // start に date も dateTime もない
			(!event.end.date && !event.end.dateTime)) {      // end に date も dateTime もない
			 console.error(`タスク "${task.summary || task.id}" は無効な開始/終了時間になりました。デフォルトにフォールバックします。`, event);
			 this.setDefaultEventTime(event); // デフォルト時間を設定
			 event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付処理エラー)`;
		}
	}


	/**
	 * イベントにデフォルトの終日イベント時間 (今日) を設定します。
	 * 主にエラー時のフォールバックとして使用されます。
	 * @param {GoogleCalendarEventInput} event 設定対象のイベントオブジェクト (参照渡し)
	 */
	private setDefaultEventTime(event: GoogleCalendarEventInput): void {
		const today = moment.utc().format('YYYY-MM-DD'); // デフォルト終日イベントには UTC の今日の日付を使用
		event.start = { date: today };
		// 終日イベントの end.date は翌日を指定
		event.end = { date: moment.utc(today).add(1, 'day').format('YYYY-MM-DD') };
		// start や end が既に存在する場合でも上書きする
		delete event.start.dateTime;
		delete event.end.dateTime;
	}


	// --- メイン同期ロジック (バッチリクエスト対応、サイズ制限あり) ---

	/**
	 * Obsidian タスクと Google Calendar イベント間の同期を実行します。
	 * 1. Obsidian タスクを取得
	 * 2. Google Calendar イベントを取得 (プラグインが作成したもの)
	 * 3. タスクとイベントを比較し、作成/更新/削除のバッチリクエストを準備
	 * 4. バッチリクエストをチャンク (最大50件) に分割して実行
	 * 5. バッチ結果を処理し、タスクマップを更新
	 * 6. 結果と最終同期時刻を保存
	 */
	async syncTasks() {
		// 同期処理が既に進行中か確認
		if (this.isSyncing) {
			console.warn("同期はスキップされました: 既に進行中です。");
			new Notice("同期は既に進行中です。");
			return;
		}
		this.isSyncing = true; // 同期開始フラグを設定
		const syncStartTime = moment(); // 同期開始時刻を記録

		// 認証状態を確認
		if (!this.settings.tokens || !this.oauth2Client?.credentials?.access_token) {
			new Notice('同期失敗: 認証されていません。', 7000);
			console.error('同期中止: 認証されていません。');
			this.isSyncing = false; // フラグをリセット
			return;
		}
		// カレンダー ID が設定されているか確認
		if (!this.settings.calendarId) {
			new Notice('同期失敗: 対象のカレンダー ID が設定されていません。', 7000);
			console.error('同期中止: カレンダー ID が設定されていません。');
			this.isSyncing = false; // フラグをリセット
			return;
		}

		console.log(`カレンダー ID: ${this.settings.calendarId} との同期を開始します`);
		new Notice('同期を開始しました...', 3000);
		let createdCount = 0, updatedCount = 0, deletedCount = 0, skippedCount = 0, errorCount = 0;
		const batchRequests: BatchRequestItem[] = []; // 全バッチリクエストを一時的に格納する配列
		// ローカルコピーを作成し、処理中に変更。最後に settings.taskMap に反映。
		const taskMap = { ...this.settings.taskMap };
		let googleEventMap = new Map<string, calendar_v3.Schema$Event>();
		let existingEvents: calendar_v3.Schema$Event[] = []; // prepareDeletionRequests で使うためスコープを上げる

		try {
			// --- 1. Obsidian タスクの取得 ---
			new Notice('同期中: Obsidian タスクを取得しています...', 2000);
			console.time("Sync: Fetch Obsidian Tasks");
			const obsidianTasks = await this.getObsidianTasks();
			console.timeEnd("Sync: Fetch Obsidian Tasks");

			// --- 2. 既存の Google Calendar イベントの取得 ---
			new Notice('同期中: Google Calendar イベントを取得しています...', 3000);
			console.time("Sync: Fetch GCal Events");
			// カレンダーAPIクライアントの初期化 (ここで再確認)
			this.initializeCalendarApi(); // API クライアントが準備できていることを確認
			if (!this.calendar) {
				// initializeCalendarApi 内でエラーログが出るはずなので、ここでは同期を中止
				throw new Error("Calendar API クライアントを初期化できませんでした。");
			}
			existingEvents = await this.fetchGoogleCalendarEvents(); // 取得したイベントを後で使用
			googleEventMap = this.mapGoogleEvents(existingEvents, taskMap); // イベントをマップ化し、taskMap を修正
			console.timeEnd("Sync: Fetch GCal Events");

			// --- 3. タスクの処理とバッチリクエストの準備 ---
			new Notice(`同期中: ${obsidianTasks.length} 個の Obsidian タスクを処理中...`, 3000);
			console.time("Sync: Process Tasks & Prepare Batch");
			const { currentObsidianTaskIds, skipped } = this.prepareBatchRequests(
				obsidianTasks,
				googleEventMap,
				taskMap, // ローカルコピーを渡す
				batchRequests // バッチリクエスト配列 (参照渡しで変更)
			);
			skippedCount += skipped;
			console.timeEnd("Sync: Process Tasks & Prepare Batch");

			// --- 4. 削除リクエストの準備 ---
			console.time("Sync: Prepare Deletions");
			this.prepareDeletionRequests(
				taskMap,                // ローカルコピー
				currentObsidianTaskIds, // 現在存在する Obsidian タスク ID の Set
				existingEvents,         // GCal から取得した全イベント
				batchRequests           // バッチリクエスト配列 (参照渡しで変更)
			);
			console.timeEnd("Sync: Prepare Deletions");

            // --- 5. バッチリクエストの実行 (チャンク分割あり) ---
            const BATCH_SIZE = 1000; // バッチサイズ制限
            let allBatchResults: BatchResponseItem[] = []; // 全バッチ結果を格納
            let combinedBatchRequests: BatchRequestItem[] = []; // 実際に処理されたリクエストを格納 (結果処理用)
            let totalBatches = Math.ceil(batchRequests.length / BATCH_SIZE);

            if (batchRequests.length > 0) {
                console.log(`${batchRequests.length} 件の操作を、最大 ${BATCH_SIZE} 件ずつの ${totalBatches} バッチで実行開始します。`);
                new Notice(`同期中: ${batchRequests.length} 件の変更を Google に送信中...`, 4000);

                console.time("Sync: Execute All Batches");
                for (let i = 0; i < batchRequests.length; i += BATCH_SIZE) {
                    const batchChunk = batchRequests.slice(i, i + BATCH_SIZE); // 現在のチャンクを取得
                    const currentBatchIndex = Math.floor(i / BATCH_SIZE) + 1; // 現在のバッチ番号 (1-based)
                    console.log(`バッチ ${currentBatchIndex}/${totalBatches} (${batchChunk.length} 件の操作) を実行中...`);
                    new Notice(`同期中: バッチ ${currentBatchIndex}/${totalBatches} を送信中...`, 2000);

                    try {
                        console.time(`Sync: Execute Batch ${currentBatchIndex}`);
                        const chunkResults = await this.executeBatchRequest(batchChunk); // チャンクを実行
                        console.timeEnd(`Sync: Execute Batch ${currentBatchIndex}`);

                        allBatchResults = allBatchResults.concat(chunkResults); // 結果を結合
                        combinedBatchRequests = combinedBatchRequests.concat(batchChunk); // 対応するリクエストも保存

                        console.log(`バッチ ${currentBatchIndex}/${totalBatches} が ${chunkResults.length} 件のレスポンスで完了しました。`);

                        // チャンク内のエラー数をチェック (オプション)
                        const chunkErrors = chunkResults.filter(res => res.status < 200 || res.status >= 300).length;
                        if (chunkErrors > 0) {
                            console.warn(`バッチ ${currentBatchIndex} に ${chunkErrors} 件のエラーが含まれていました。`);
                        }

                    } catch (batchError: any) {
                        console.error(`バッチ ${currentBatchIndex}/${totalBatches} の実行中に致命的なエラー:`, batchError);
                        // エラーが発生したチャンクの操作をエラーとして記録
                        const errorResponses: BatchResponseItem[] = batchChunk.map(() => ({
                            status: 500, // または他のエラーコード
                            body: { error: { message: `バッチ実行失敗: ${batchError.message || '不明なエラー'}` } }
                        }));
                        allBatchResults = allBatchResults.concat(errorResponses);
                        combinedBatchRequests = combinedBatchRequests.concat(batchChunk); // 失敗したリクエストも結果処理のために含める

                        new Notice(`同期エラー (バッチ ${currentBatchIndex})。一部の変更が失敗しました。コンソールを確認してください。`, 10000);
                        // 失敗しても次のバッチに進む（エラーは後で集計）
                    }
                }
                console.timeEnd("Sync: Execute All Batches");

                // --- 6. 全バッチ結果の処理 ---
                console.time("Sync: Process All Batch Results");
                const { created, updated, deleted, errors: processErrors, skipped: processSkipped } = this.processBatchResults(
                    allBatchResults,       // 全バッチの結合されたレスポンス
                    combinedBatchRequests, // 全バッチの結合されたリクエスト
                    taskMap                // ローカルの taskMap (参照渡しで変更)
                );
                createdCount += created;
                updatedCount += updated;
                deletedCount += deleted;
                errorCount += processErrors; // processBatchResults からのエラーも加算
                skippedCount += processSkipped; // スキップ数も加算
                console.timeEnd("Sync: Process All Batch Results");

            } else {
                console.log("変更は検出されませんでした。バッチリクエストをスキップします。");
                new Notice("変更は検出されませんでした。", 4000);
            }


			// --- 7. 更新されたタスクマップと最終同期時刻の保存 ---
			const syncEndTime = moment(); // 同期終了時刻
			const finalTaskMap = taskMap; // 変更されたローカルコピーを使用

			// taskMap が実際に変更されたか、または lastSyncTime を更新する必要がある場合にのみ保存
            // エラーがあっても、成功した部分のマッピングや同期時刻は保存する
			if (JSON.stringify(finalTaskMap) !== JSON.stringify(this.settings.taskMap) || this.settings.lastSyncTime !== syncEndTime.toISOString()) {
				console.log("更新されたタスクマップおよび/または同期時刻を保存します。");
				this.settings.taskMap = finalTaskMap;
				this.settings.lastSyncTime = syncEndTime.toISOString(); // 最終同期時刻を更新
				await this.saveData(this.settings); // 両方の変更を保存
			} else {
				console.log("タスクマップと同期時刻は変更されていません。");
			}


			// --- 最終サマリー ---
			const duration = moment.duration(syncEndTime.diff(syncStartTime)).asSeconds();
			const summary = `同期完了 (${duration.toFixed(1)}秒): ${createdCount}件追加, ${updatedCount}件更新/キャンセル, ${deletedCount}件削除, ${skippedCount}件スキップ.${errorCount > 0 ? ` ${errorCount}件エラー。` : ''}`;
			console.log("同期が完了しました。", summary);
			new Notice(summary, errorCount > 0 ? 15000 : 7000); // エラーがあれば長めに表示

		} catch (error: any) {
			console.error('同期中に致命的なエラーが発生しました:', error);
			errorCount++;
			// エラーメッセージを正しく抽出
			const errorMsg = error instanceof Error ? error.message : String(error);
			new Notice(`同期中に致命的なエラーが発生しました: ${errorMsg}。コンソールを確認してください。`, 15000);
		} finally {
			this.isSyncing = false; // 最後に必ずフラグをリセット
			// カウントが数値であることを確認 (undefined/NaN の場合は 0 に)
			const finalCreated = createdCount || 0;
			const finalUpdated = updatedCount || 0;
			const finalDeleted = deletedCount || 0;
			const finalSkipped = skippedCount || 0;
			const finalErrors = errorCount || 0;
			console.log(`同期結果 - 追加: ${finalCreated}, 更新/キャンセル: ${finalUpdated}, 削除: ${finalDeleted}, スキップ: ${finalSkipped}, エラー: ${finalErrors}`);
		}
	}

	/**
	 * このプラグインによって作成された Google Calendar イベントを取得します。
	 * `privateExtendedProperty` を使用してフィルタリングします。
	 * @returns {Promise<calendar_v3.Schema$Event[]>} 取得したイベントの配列
	 * @throws {Error} API クライアントの初期化失敗またはイベント取得エラー時にスロー
	 */
	private async fetchGoogleCalendarEvents(): Promise<calendar_v3.Schema$Event[]> {
		// カレンダー API クライアントが初期化されているか確認 (syncTasks でもチェックされるが念のため)
		if (!this.calendar) {
			this.initializeCalendarApi(); // 初期化を試みる
			if (!this.calendar) { // 再度確認
				throw new Error("Calendar API が初期化されていません。");
			}
		}

		let existingEvents: calendar_v3.Schema$Event[] = [];
		let nextPageToken: string | undefined = undefined;
		const requestParams: calendar_v3.Params$Resource$Events$List = {
			calendarId: this.settings.calendarId,
			// このプラグインが作成したイベントのみを取得するためのプライベート拡張プロパティ
			privateExtendedProperty: ['isGcalSync=true'],
			showDeleted: false, // 削除済みのイベントは取得しない
			maxResults: 250, // API の最大値
			singleEvents: false // 繰り返しイベントのマスターも取得する (インスタンスではなく)
			// timeMin, timeMax は設定しない (過去・未来の全ての管理イベントを取得するため)
		};

		console.log("このプラグインによってマークされた全ての GCal イベントを取得中...");

		try {
			let page = 1;
			do {
				console.log(`GCal イベントページ ${page} を取得中...`);
				requestParams.pageToken = nextPageToken; // 次のページトークンを設定
				// イベントリストを取得
				const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.calendar.events.list(requestParams);

				if (response.data.items) {
					existingEvents = existingEvents.concat(response.data.items); // 結果を結合
				}
				nextPageToken = response.data.nextPageToken ?? undefined; // 次のページトークンを更新
				page++;
			} while (nextPageToken); // 次のページがある限りループ

			console.log(`合計 ${existingEvents.length} 件の GCal イベントを取得しました。`);
			return existingEvents;
		} catch (e: any) {
			// エラーハンドリング
			const errorMsg = isGaxiosError(e)
				? (e.response?.data?.error?.message || e.message) // GaxiosError からメッセージ抽出
				: String(e); // その他のエラー
			console.error('GCal イベントの取得中に致命的なエラー:', e);
			new Notice(`GCal イベントの取得エラー: ${errorMsg}。同期を中止しました。`, 10000);
			throw new Error(`GCal イベントの取得に失敗しました: ${errorMsg}`); // 同期を停止するために再スロー
		}
	}

	/**
	 * 取得した Google イベントを Obsidian タスク ID でマップ化し、
	 * taskMap に不整合があれば修正します (ローカルコピーに対して)。
	 * @param {calendar_v3.Schema$Event[]} existingEvents Google Calendar から取得したイベントの配列
	 * @param {{ [obsidianTaskId: string]: string }} taskMap 修正対象のタスクマップ (ローカルコピー)
	 * @returns {Map<string, calendar_v3.Schema$Event>} Obsidian タスク ID をキー、GCal イベントを値とする Map
	 */
	private mapGoogleEvents(
		existingEvents: calendar_v3.Schema$Event[],
		taskMap: { [obsidianTaskId: string]: string } // ローカルコピーを操作
	): Map<string, calendar_v3.Schema$Event> {
		const googleEventMap = new Map<string, calendar_v3.Schema$Event>();

		existingEvents.forEach(event => {
			// イベントの拡張プロパティから Obsidian タスク ID を取得
			const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
			const gcalId = event.id; // Google Calendar イベント ID

			if (obsId && gcalId) {
				// 同じ Obsidian タスク ID に複数の GCal イベントが紐づいている場合 (通常は発生しないはず)
				// 更新日時が新しい方を優先する
				const existingMapping = googleEventMap.get(obsId);
				if (!existingMapping || (event.updated && existingMapping.updated && moment(event.updated).isAfter(moment(existingMapping.updated)))) {
					googleEventMap.set(obsId, event); // マップに登録 or 更新
				}

				// taskMap と GCal イベントの ID に不整合がないか確認
				if (!taskMap[obsId] || taskMap[obsId] !== gcalId) {
					// taskMap に古い ID が残っている、またはマッピングが存在しない場合
					if (taskMap[obsId] && taskMap[obsId] !== gcalId) {
						console.warn(`タスクマップ修正: ${obsId} のマッピングを ${taskMap[obsId]} から ${gcalId} に更新しました`);
					} else if (!taskMap[obsId]) {
						console.log(`タスクマップ補完: ${obsId} に GCal ID ${gcalId} をマッピングしました`);
					}
					taskMap[obsId] = gcalId; // ローカルの taskMap コピーを修正
				}
			} else if (gcalId && event.extendedProperties?.private?.['isGcalSync'] === 'true') {
				// プラグインによって作成されたが、Obsidian タスク ID が欠落しているイベント (孤児イベント)
				// これは削除フェーズで処理される
				console.warn(`GCal イベント (ID: ${gcalId}) はプラグインによってマークされていますが、'obsidianTaskId' プロパティが欠落しています。`);
			}
		});

		return googleEventMap;
	}


	/**
	 * Obsidian タスクを処理し、フィルタリングを行い、
	 * 作成/更新/パッチ (キャンセル) のためのバッチリクエストを準備します。
	 * @param {ObsidianTask[]} obsidianTasks Vault から取得した全タスク
	 * @param {Map<string, calendar_v3.Schema$Event>} googleEventMap Obsidian タスク ID と GCal イベントのマッピング
	 * @param {{ [obsidianTaskId: string]: string }} taskMap タスク ID と GCal イベント ID のマッピング (ローカルコピー)
	 * @param {BatchRequestItem[]} batchRequests 準備されたリクエストを追加する配列 (参照渡し)
	 * @returns {{ currentObsidianTaskIds: Set<string>, skipped: number }} 現在存在する全 Obsidian タスク ID の Set とスキップされたタスク数
	 */
	private prepareBatchRequests(
		obsidianTasks: ObsidianTask[],
		googleEventMap: Map<string, calendar_v3.Schema$Event>,
		taskMap: { [obsidianTaskId: string]: string }, // ローカルコピーを使用
		batchRequests: BatchRequestItem[] // 参照渡しで変更
	): { currentObsidianTaskIds: Set<string>, skipped: number } {
		const currentObsidianTaskIds = new Set<string>(); // 現在 Vault に存在するタスクの ID を格納
		let skippedCount = 0; // 同期対象外となったタスク数
		const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(this.settings.calendarId)}/events`; // API パス

		for (const task of obsidianTasks) {
			currentObsidianTaskIds.add(task.id); // まず全てのタスク ID を Set に追加 (削除判定用)

			const obsId = task.id;
			const existingEvent = googleEventMap.get(obsId); // GCal から取得したイベント情報
			// taskMap からも ID を取得 (GCal からイベントが見つからなかった場合のフォールバック)
			const googleEventId = existingEvent?.id || taskMap[obsId];

			// **フィルタリング & 処理ロジック 開始**

			// --- 完了済みタスクの処理 ---
			if (task.isCompleted) {
				// 以前同期され、かつ GCal 上でまだ 'cancelled' になっていない場合
				if (googleEventId && existingEvent && existingEvent.status !== 'cancelled') {
					// イベントを 'cancelled' にするための PATCH リクエストを準備
					batchRequests.push({
						method: 'PATCH',
						path: `${calendarPath}/${encodeURIComponent(googleEventId)}`,
						body: { status: 'cancelled' }, // ステータスのみ変更
						obsidianTaskId: obsId,
						operationType: 'patch', // 操作タイプ: パッチ
						originalGcalId: googleEventId
					});
					console.log(`キャンセル準備: "${task.summary || obsId}" (GCal ID: ${googleEventId})`);
				} else {
					// タスクは完了しているが、
					// - 以前同期されていない
					// - GCal で既にキャンセル済み
					// - GCal でイベントが削除されている (taskMap にのみ ID が残っている場合)
					// のいずれかなので、何もしない。
					// taskMap に古い ID が残っていても、後でクリーンアップされる。
					skippedCount++;
				}
				continue; // 次のタスクへ
			}

			// --- アクティブなタスクの処理 (同期可能かのチェック: 開始日 & 期限日) ---
			// **重要:** このプラグインは開始日 (🛫) と 期限日 (📅) の両方を持つタスクのみを同期対象とする
			if (!task.startDate || !task.dueDate) {
				// 同期に必要な日付が欠けているタスクはスキップ
				// console.log(`スキップ: "${task.summary || obsId}" (Obs ID: ${obsId}): 同期基準を満たしていません (開始日と期限日の両方が必要)。`);
				// 以前同期されていたとしても、Obsidian 側で日付が消えた場合は GCal から削除しない。
				// Obsidian タスク自体が削除された場合にのみ GCal イベントが削除される (削除ロジックで処理)。
				skippedCount++;
				continue; // 次のタスクへ
			}

			// --- 同期対象タスクの処理 (作成 or 更新) ---
			// タスクはアクティブで、必要な日付を持っている -> イベントペイロードを準備
			const eventPayload = this.mapObsidianTaskToGoogleEvent(task); // タスク情報を GCal イベント構造に変換

			// GCal に対応するイベントが存在するか？
			if (googleEventId && existingEvent) {
				// **既存イベントの更新**
				// GCal イベントと新しいペイロードを比較し、更新が必要か判断
				if (this.needsUpdate(existingEvent, eventPayload)) {
					// PUT リクエストでイベント全体を更新
					batchRequests.push({
						method: 'PUT',
						path: `${calendarPath}/${encodeURIComponent(googleEventId)}`,
						body: eventPayload, // 更新後の完全なイベントデータ
						obsidianTaskId: obsId,
						operationType: 'update', // 操作タイプ: 更新
						originalGcalId: googleEventId
					});
					console.log(`更新準備: "${task.summary || obsId}" (GCal ID: ${googleEventId})`);
				} else {
					// 変更がない場合はスキップ
					skippedCount++;
				}
			} else {
				// **新規イベントの作成**
				if (googleEventId && !existingEvent) {
					// taskMap に ID があるが、GCal からイベントが見つからなかった場合
					// (例: GCal で手動削除された後、Obsidian タスクが変更された場合)
					console.warn(`タスク "${task.summary || obsId}" の古いマップエントリ (GCal ID: ${googleEventId})。イベントを再作成します。`);
					// taskMap エントリは、挿入成功時に新しい ID で上書きされるため、ここで削除する必要はない。
					delete taskMap[obsId]; // 再作成するので、古いマップエントリは削除しておくのが安全
				}
				// POST リクエストで新しいイベントを作成
				batchRequests.push({
					method: 'POST',
					path: calendarPath, // イベント作成用のパス (ID なし)
					body: eventPayload, // 新規イベントデータ
					obsidianTaskId: obsId,
					operationType: 'insert' // 操作タイプ: 挿入
				});
				console.log(`挿入準備: "${task.summary || obsId}"`);
			}
			// **フィルタリング & 処理ロジック 終了**
		}
		console.log(`バッチリクエスト準備完了: ${batchRequests.length} 件の操作, ${skippedCount} 件スキップ。`);
		return { currentObsidianTaskIds, skipped: skippedCount };
	}

	/**
	 * Google Calendar からイベントを削除するためのバッチリクエストを準備します。
	 * - Obsidian から削除されたタスクにリンクされたイベント
	 * - プラグインが作成したが Obsidian ID がない、またはリンク切れのイベント (孤児イベント)
	 * を削除対象とします。
	 * @param {{ [obsidianTaskId: string]: string }} taskMap タスク ID と GCal ID のマッピング (ローカルコピー)
	 * @param {Set<string>} currentObsidianTaskIds 現在 Vault に存在する全 Obsidian タスク ID
	 * @param {calendar_v3.Schema$Event[]} existingGCalEvents GCal から取得した全イベントのリスト
	 * @param {BatchRequestItem[]} batchRequests 削除リクエストを追加する配列 (参照渡し)
	 */
	private prepareDeletionRequests(
		taskMap: { [obsidianTaskId: string]: string }, // ローカルコピーを使用
		currentObsidianTaskIds: Set<string>,
		existingGCalEvents: calendar_v3.Schema$Event[], // GCal から取得した全イベント
		batchRequests: BatchRequestItem[] // 参照渡しで変更
	): void {
		const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(this.settings.calendarId)}/events`;
		const processedForDeletion = new Set<string>(); // 同じ GCal ID を複数回削除しようとしないための Set

		// --- Obsidian から削除されたタスクに基づく削除 ---
		// taskMap に存在するが、currentObsidianTaskIds には存在しない Obsidian タスク ID を見つける
		const entriesToDelete = Object.entries(taskMap).filter(([obsId, gId]) =>
			gId && !currentObsidianTaskIds.has(obsId) // GCal ID があり、かつ現在のタスクリストにない
		);

		if (entriesToDelete.length > 0) {
			console.log(`削除された Obsidian タスクに対応する ${entriesToDelete.length} 件の GCal 削除を準備中。`);
			for (const [obsId, gId] of entriesToDelete) {
				// この GCal ID がまだ削除対象として処理されていないことを確認
				if (!processedForDeletion.has(gId)) {
					batchRequests.push({
						method: 'DELETE',
						path: `${calendarPath}/${encodeURIComponent(gId)}`,
						obsidianTaskId: obsId, // 削除理由の追跡用
						operationType: 'delete',
						originalGcalId: gId
					});
					processedForDeletion.add(gId); // 処理済みとしてマーク
					console.log(`削除準備 (Obsidianタスク削除): GCal ID: ${gId} (Obs ID: ${obsId})`);
				} else {
					// これは通常発生しないはずだが、念のためログ
					console.warn(`GCal ID ${gId} (Obs ID: ${obsId}) の削除リクエストは既に準備されています。`);
				}
			}
		}

		// --- 孤児 GCal イベントに基づく削除 ---
		// GCal から取得したイベントのうち、以下の条件を満たすものを探す:
		// 1. プラグインによって作成された (`isGcalSync=true`)
		// 2. まだ削除対象として処理されていない
		// 3. 拡張プロパティに `obsidianTaskId` がない、または
		// 4. `obsidianTaskId` が存在するが、現在の `taskMap` にその ID のエントリがない
		const orphanedGcalEvents = existingGCalEvents.filter(event => {
			if (!event.id || event.extendedProperties?.private?.['isGcalSync'] !== 'true') {
				return false; // プラグインのイベントでない、または GCal ID がない
			}
			if (processedForDeletion.has(event.id)) {
				return false; // 既に削除対象として処理済み
			}
			const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
			// 孤児である条件: (obsId が存在し、かつ taskMap にない) または (obsId が存在しない)
			return (!obsId || !taskMap[obsId]);
		});


		if (orphanedGcalEvents.length > 0) {
			console.log(`孤児イベントに対応する ${orphanedGcalEvents.length} 件の GCal 削除を準備中。`);
			for (const event of orphanedGcalEvents) {
				// 再度、削除対象として処理済みでないか確認 (filter で処理されているはずだが念のため)
				if (event.id && !processedForDeletion.has(event.id)) {
					batchRequests.push({
						method: 'DELETE',
						path: `${calendarPath}/${encodeURIComponent(event.id)}`,
						// 孤児の場合、obsidianTaskId は存在しないかもしれない
						obsidianTaskId: event.extendedProperties?.private?.['obsidianTaskId'] || 'unknown-orphan',
						operationType: 'delete',
						originalGcalId: event.id
					});
					processedForDeletion.add(event.id); // 処理済みとしてマーク
					console.log(`削除準備 (孤児イベント): GCal ID: ${event.id} (Obs ID: ${event.extendedProperties?.private?.['obsidianTaskId'] || 'なし'})`);
				}
			}
		}
		console.log(`削除リクエストの準備完了。`);
	}


	/**
	 * 準備されたバッチリクエストを Obsidian の request 関数を使用して実行します。
	 * Google のバッチエンドポイント (multipart/mixed) を使用します。
	 * @param {BatchRequestItem[]} batchRequests 実行するバッチリクエストの配列 (1チャンク分)
	 * @returns {Promise<BatchResponseItem[]>} 各リクエストに対応するレスポンスの配列
	 * @throws {Error} 認証エラーまたはバッチリクエスト全体が失敗した場合
	 */
	private async executeBatchRequest(batchRequests: BatchRequestItem[]): Promise<BatchResponseItem[]> {
		// 認証トークンの存在を確認
		if (!this.oauth2Client || !this.settings.tokens?.access_token) {
			throw new Error("バッチリクエストを実行できません: 認証されていません。");
		}

		const boundary = `batch_${randomBytes(16).toString('hex')}`; // multipart の境界文字列
		// Google API の標準バッチエンドポイントを使用
		const batchUrl = 'https://www.googleapis.com/batch/calendar/v3';
		let body = ''; // リクエストボディを構築

		// 各リクエストを multipart 形式でボディに追加
		batchRequests.forEach((req, index) => {
			body += `--${boundary}\r\n`; // 境界
			body += `Content-Type: application/http\r\n`; // 各パートの Content-Type
			body += `Content-ID: <item-${index + 1}>\r\n`; // 各パートの ID (レスポンスと対応させるため)
			body += `\r\n`; // ヘッダーとボディの区切り

			// 個別リクエストのヘッダー (メソッドとパス)
			body += `${req.method} ${req.path}\r\n`;
			// 個別リクエストにボディがある場合
			if (req.body) {
				body += `Content-Type: application/json; charset=UTF-8\r\n`;
			}
			// 必要に応じて他のヘッダーを追加 (例: If-Match)
			if (req.headers) {
				for (const key in req.headers) {
					body += `${key}: ${req.headers[key]}\r\n`;
				}
			}
			body += `\r\n`; // 個別リクエストのヘッダー終了

			// 個別リクエストのボディ (JSON 文字列化)
			if (req.body) {
				body += JSON.stringify(req.body);
			}
			body += `\r\n`; // 個別リクエストの終了
		});

		// バッチリクエスト全体の終了境界
		body += `--${boundary}--\r\n`;

		// Obsidian の request 関数用のパラメータを設定
		const requestParams: RequestUrlParam = {
			url: batchUrl,
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.settings.tokens.access_token}`, // 認証ヘッダー
				'Content-Type': `multipart/mixed; boundary=${boundary}`, // バッチリクエストの Content-Type
			},
			body: body, // 構築したリクエストボディ
			throw: false // 2xx 以外のステータスコードでもエラーをスローしない (手動で処理するため)
		};

		try {
			console.log(`${batchRequests.length} 件の操作を含むバッチリクエストを送信中...`);
			// リクエストを実行
			const responseText = await request(requestParams); // レスポンスはテキストとして受け取る

			// レスポンスのステータスコードを推定 (Obsidian の request は直接ステータスを返さない場合がある)
			let responseStatus = 200; // デフォルトは成功と仮定
			try {
				const jsonResponse = JSON.parse(responseText);
				if (jsonResponse && jsonResponse.error) {
					responseStatus = jsonResponse.error.code || 500;
				}
			} catch (e) { /* JSON パース失敗 -> multipart 応答 */ }

			console.log(`バッチ応答ステータス (推定): ${responseStatus}`);

			// バッチリクエスト全体が失敗した場合 (例: 認証エラー 401)
			if (responseStatus < 200 || responseStatus >= 300) {
				console.error("バッチリクエスト全体が失敗しました:", responseStatus, responseText.slice(0, 1000));
				let errorDetails = responseText.slice(0, 500);
				try {
					const errorJson = JSON.parse(responseText);
					errorDetails = errorJson?.error?.message || errorDetails;
				} catch (e) {/* ignore */}
				throw new Error(`バッチリクエストがステータス ${responseStatus} で失敗しました: ${errorDetails}`);
			}

			// multipart/mixed レスポンスをパース (修正後の関数を呼ぶ)
			return this.parseBatchResponse(responseText, boundary);

		} catch (error) {
			console.error("バッチリクエストの実行または処理中にエラー:", error);
			if (error instanceof Error && (String(error).includes('401') || String(error).includes('invalid_grant') || String(error).includes('invalid credential'))) {
				new Notice("同期中の認証エラー。再認証を試みてください。", 10000);
			} else if (error instanceof Error && String(error).includes('403')) {
				new Notice("権限エラー(403)。カレンダーAPIが有効か、権限スコープを確認してください。", 10000);
			}
			throw error; // 元のエラーを再スロー
		}
	}

    /**
     * Google Batch API からの multipart/mixed レスポンスをパースします。
     * 行ベースで処理し、各パートを BatchResponseItem オブジェクトに変換します。
     * @param {string} responseText バッチ API からのレスポンステキスト全体
     * @param {string} boundary multipart の境界文字列
     * @returns {BatchResponseItem[]} パースされたレスポンスアイテムの配列
     */
    private parseBatchResponse(responseText: string, boundary: string): BatchResponseItem[] {
        const results: BatchResponseItem[] = [];
        const boundaryString = `--${boundary}`;
        // レスポンスを行ごとに分割
        const lines = responseText.split(/\r?\n/);

        let currentPartLines: string[] | null = null;

        for (const line of lines) {
            if (line.startsWith(boundaryString)) {
                // 前のパートがあれば処理
                if (currentPartLines) {
                    const partText = currentPartLines.join('\n');
                    const parsedItem = this.parseSingleBatchPart(partText);
                    if (parsedItem) {
                        results.push(parsedItem);
                    } else {
                        console.warn(`バッチレスポンスパートのパースに失敗しました。パート内容:`, partText.substring(0, 200));
                    }
                }
                // 新しいパートの開始
                currentPartLines = [];
                // "--" が境界文字列の後についている場合は、これが最後の境界
                if (line.endsWith('--')) {
                    break; // パース終了
                }
            } else if (currentPartLines !== null) {
                // 現在のパートに行を追加
                currentPartLines.push(line);
            }
        }

        console.log(`${results.length} 件のバッチ応答アイテムを抽出しました。`);
        return results;
    }

    /**
     * 個別のバッチ応答パート (multipart の一部) をパースします。
     * @param {string} partText パースするパートのテキスト
     * @returns {BatchResponseItem | null} パースされたレスポンスアイテム、または失敗時は null
     */
    private parseSingleBatchPart(partText: string): BatchResponseItem | null {
        // 最初の空行を探して、HTTPヘッダ部分とHTTPレスポンス本体を分離
        // partText は既に現在のパートの最初の行から始まっていると仮定
        const lines = partText.split('\n');
        let headerEndIndex = -1;
        let inHttpHeaders = false;

        for (let i = 0; i < lines.length; i++) {
            // "HTTP/" で始まる行を見つけてHTTPレスポンスの開始とする
            if (lines[i].startsWith('HTTP/')) {
                inHttpHeaders = true;
            }
            // HTTPヘッダー内で空行を見つけたら、それがヘッダーの終わり
            if (inHttpHeaders && lines[i].trim() === '') {
                headerEndIndex = i;
                break;
            }
        }

        if (headerEndIndex === -1) {
            console.warn("バッチパート内でHTTPヘッダーの終わりが見つかりません:", lines.slice(0, 5).join('\\n'));
            return null; // 不正な形式
        }

        // HTTPレスポンス部分を抽出
        const httpResponseLines = lines.slice(headerEndIndex + 1); // ヘッダー後の空行の次から
        const httpResponseText = httpResponseLines.join('\n');

        // ステータス行を見つける (通常は headerEndIndex の1つ前の行にあるはずだが、安全のため再度検索)
        let statusLine = '';
        for(let i = headerEndIndex - 1; i >= 0; i--) {
            if (lines[i].startsWith('HTTP/')) {
                statusLine = lines[i];
                break;
            }
        }
        const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

        // ボディを抽出
        const bodyString = httpResponseText.trim();

        let bodyJson: any = null;
        if (bodyString) {
            try {
                if (bodyString.startsWith('{') || bodyString.startsWith('[')) {
                     bodyJson = JSON.parse(bodyString);
                } else if (status !== 204) {
                     bodyJson = { message: `Non-JSON response body: ${bodyString.substring(0, 100)}...` };
                }
            } catch (e: any) {
                console.warn(`バッチ応答パートの JSON ボディのパースに失敗: ${e.message}`, "Status:", status, "Body:", bodyString.substring(0, 200));
                bodyJson = { error: { message: `JSON parse failed: ${e.message}. Body: ${bodyString.substring(0, 100)}...` } };
            }
        } else if (status !== 204 && status < 300) {
             console.warn(`バッチ応答パート (Status: ${status}) にボディがありません。`);
        } else if (status >= 300 && !bodyString) {
             bodyJson = { error: { message: `Error status ${status} with empty body` } };
        }

        return {
            status: status,
            body: bodyJson
        };
    }


	/**
	 * バッチリクエストの結果を処理し、タスクマップを更新し、結果を集計します。
	 * リクエスト数とレスポンス数が一致しない場合はエラーとし、処理を中断します。
	 * @param {BatchResponseItem[]} batchResults バッチ実行からのレスポンスの配列
	 * @param {BatchRequestItem[]} batchRequests 対応するバッチリクエストの配列
	 * @param {{ [obsidianTaskId: string]: string }} taskMap 更新するタスクマップ (ローカルコピー、参照渡し)
	 * @returns {{ created: number, updated: number, deleted: number, errors: number, skipped: number }} 各操作の成功/失敗/スキップ数
	 */
	private processBatchResults(
		batchResults: BatchResponseItem[],
		batchRequests: BatchRequestItem[], // batchResults と同じ順序・要素数である必要がある
		taskMap: { [obsidianTaskId: string]: string } // ローカルコピーを変更
	): { created: number, updated: number, deleted: number, errors: number, skipped: number } {
		let created = 0, updated = 0, deleted = 0, errors = 0, skipped = 0; // 各カウントを初期化

		// リクエスト数とレスポンス数が一致しない場合は致命的なエラーとして処理を中断
		if (batchResults.length !== batchRequests.length) {
			console.error(`致命的エラー: バッチリクエスト数 (${batchRequests.length}) がレスポンス数 (${batchResults.length}) と一致しません。結果処理を中止します。`);
			// 全てのリクエストをエラーとしてカウント
			errors = batchRequests.length;
			new Notice(`同期エラー: サーバーからの応答数がリクエスト数と一致しません (${batchResults.length}/${batchRequests.length})。コンソールを確認してください。`, 15000);
			return { created: 0, updated: 0, deleted: 0, errors, skipped: 0 }; // 0カウントとエラー数を返す
		}

		// ここから先は数が一致している前提で処理
		const count = batchRequests.length;

		for(let i=0; i < count; i++) {
			const req = batchRequests[i]; // 対応するリクエスト
			const res = batchResults[i]; // 対応するレスポンス
			const obsId = req.obsidianTaskId; // このリクエストが関連する Obsidian タスク ID
			const opType = req.operationType; // 実行された操作 (insert, update, patch, delete)
			const originalGcalId = req.originalGcalId; // 更新/削除対象の GCal ID

			try { // 各結果の処理を try-catch で囲む
				// --- 成功した場合 (2xx ステータスコード) ---
				if (res.status >= 200 && res.status < 300) {
					const responseBody = res.body || {}; // ボディがない場合 (204 など) でもエラーにならないように
					// ログ用にイベントのサマリーを取得 (レスポンス、リクエストの順で試す)
					const eventSummary = responseBody?.summary || req.body?.summary || `(ID: ${obsId || 'N/A'})`;

					switch (opType) {
						case 'insert':
							const newGcalId = responseBody?.id; // 新しく作成されたイベントの ID
							if (newGcalId && obsId) {
								console.log(`GCal イベント作成: "${eventSummary}" (Obs ID: ${obsId}, GCal ID: ${newGcalId})`);
								taskMap[obsId] = newGcalId; // taskMap を新しい ID で更新
								created++;
							} else {
								// 成功ステータスだが ID が取得できない場合
								console.error(`バッチ挿入成功 (ステータス ${res.status}) ですが、レスポンスボディに event ID が見つかりません。ObsId: ${obsId || '不明'}, ReqPath: ${req.path}, ResBody:`, JSON.stringify(res.body).slice(0, 500));
								errors++;
							}
							break;
						case 'update':
							const updatedGcalId = responseBody?.id; // 更新されたイベントの ID (通常は変わらないはず)
							if (updatedGcalId && obsId) {
								// 稀に ID が変わる可能性も考慮
								if (originalGcalId && updatedGcalId !== originalGcalId) {
									console.warn(`タスク ${obsId} の更新時に GCal ID が変更されました: ${originalGcalId} -> ${updatedGcalId}`);
								}
								console.log(`GCal イベント更新: "${eventSummary}" (Obs ID: ${obsId}, GCal ID: ${updatedGcalId})`);
								taskMap[obsId] = updatedGcalId; // taskMap を更新 (ID 変更の可能性に対応)
								updated++;
							} else {
                                // 成功ステータスだが ID が取得できない場合
								console.error(`バッチ更新成功 (ステータス ${res.status}) ですが、レスポンスボディに event ID が見つかりません。ObsId: ${obsId || '不明'}, GCalId: ${originalGcalId || '不明'}, ReqPath: ${req.path}, ResBody:`, JSON.stringify(res.body).slice(0, 500));
								errors++;
							}
							break;
						case 'patch': // 現在はキャンセル (status: 'cancelled') に使用
							const patchedGcalId = responseBody?.id || originalGcalId;
							if (patchedGcalId && obsId) {
								console.log(`GCal イベントキャンセル: "${eventSummary}" (Obs ID: ${obsId}, GCal ID: ${patchedGcalId})`);
								taskMap[obsId] = patchedGcalId;
								updated++;
							} else if (patchedGcalId) {
                                // ID はあるが ObsId がない場合（孤児イベントのキャンセルなど、通常はないシナリオ）
                                console.log(`GCal イベントパッチ成功 (キャンセル?): GCal ID ${patchedGcalId}, Obs ID 不明`);
                                updated++;
                            } else {
								console.error(`バッチパッチ (キャンセル) 成功 (ステータス ${res.status}) ですが、GCal ID を特定できませんでした。ObsId: ${obsId || '不明'}, originalGcalId: ${originalGcalId || '不明'}, ResBody:`, JSON.stringify(res.body).slice(0, 500));
								errors++;
							}
							break;
						case 'delete':
							// 成功 (204 No Content)
							if (obsId && originalGcalId) {
								console.log(`GCal イベント削除: ID ${originalGcalId} (Obs ID: ${obsId} にリンクされていました)`);
								delete taskMap[obsId];
								deleted++;
							} else if (originalGcalId) {
								console.log(`孤児 GCal イベント削除: ID ${originalGcalId}`);
								// taskMap にエントリはないはず
								deleted++;
							} else {
								 console.warn(`バッチ削除成功 (ステータス ${res.status}) ですが、削除対象の GCal ID が不明です。`);
							}
							break;
						default:
							console.warn("成功したバッチ応答に不明な操作タイプ:", opType, req, res);
							break;
					}
				} else {
					// --- 失敗した場合 (非 2xx ステータスコード) ---
					const errorBody = res.body || {};
					const errorMsg = errorBody?.error?.message || errorBody?.message || `ステータス ${res.status}`;
					const reqSummary = req.body?.summary || `(Obs ID: ${obsId || '不明'}, Op: ${opType}, GCalID: ${originalGcalId || 'N/A'})`;

					// 特定のエラーコードを処理
					if ((opType === 'delete' || opType === 'patch' || opType === 'update') && (res.status === 404 || res.status === 410)) {
						console.warn(`GCal イベント ${originalGcalId || '(不明 ID)'} (Obs ID: ${obsId || '不明'}) が ${opType} 中に見つかりませんでした (Not Found/Gone)。可能であればマップから削除します。`);
						if (obsId && taskMap[obsId] === originalGcalId) {
							delete taskMap[obsId];
						}
						if (opType === 'delete') {
							deleted++; // 結果的に削除されたとみなす
						} else {
							skipped++; // 更新/パッチはスキップされた
						}
					} else if (res.status === 403) {
						errors++;
						console.error(`バッチ操作失敗 (権限エラー) for "${reqSummary}": ${errorMsg} (Status: ${res.status})`, "Request:", req, "Response:", res);
						new Notice(`権限エラー sync task "${String(reqSummary).slice(0,30)}...": ${errorMsg}`, 10000);
					} else if (res.status === 401) {
						errors++;
						console.error(`バッチ操作失敗 (認証エラー) for "${reqSummary}": ${errorMsg} (Status: ${res.status})`, "Request:", req, "Response:", res);
						new Notice(`認証エラー sync task "${String(reqSummary).slice(0,30)}...": ${errorMsg}`, 10000);
					} else {
						// その他のエラー
						errors++;
						console.error(`バッチ操作失敗 for "${reqSummary}": ${errorMsg} (Status: ${res.status})`, "Request:", req, "Response:", res);
						new Notice(`エラー sync task "${String(reqSummary).slice(0,30)}...": ${errorMsg}`, 10000);
					}
				}
			} catch (processingError) {
				errors++; // 個別結果の処理中の予期せぬエラーもカウント
				console.error(`バッチ結果アイテム ${i} の処理中にエラー:`, processingError, "Request:", req, "Response:", res);
				new Notice(`同期結果の処理中に内部エラーが発生しました。Obs ID: ${obsId || '不明'}`, 7000);
			}
		}
		console.log(`バッチ結果処理完了: ${created} 作成, ${updated} 更新, ${deleted} 削除, ${skipped} スキップ (結果処理中), ${errors} エラー.`);
		return { created, updated, deleted, errors, skipped };
	}



	/**
	 * 既存の Google Calendar イベントと新しいイベントペイロードの関連フィールドを比較し、
	 * 更新が必要かどうかを判断します。
	 * JSON.stringify を避け、パフォーマンスを向上させる可能性があります。
	 * @param {calendar_v3.Schema$Event} existingEvent 既存の Google Calendar イベントオブジェクト
	 * @param {GoogleCalendarEventInput} newPayload 新しく生成されたイベントペイロード
	 * @returns {boolean} 更新が必要な場合は true、不要な場合は false
	 */
	needsUpdate(existingEvent: calendar_v3.Schema$Event, newPayload: GoogleCalendarEventInput): boolean {
		// 1. サマリー (タイトル) の比較
		if ((existingEvent.summary || '') !== (newPayload.summary || '')) return true;

		// 2. 説明欄の比較
		if ((existingEvent.description || '') !== (newPayload.description || '')) return true;

		// 3. ステータス (confirmed / cancelled) の比較
		// デフォルトは 'confirmed' とみなす
		if ((existingEvent.status || 'confirmed') !== (newPayload.status || 'confirmed')) return true;

		// 4. 開始時刻の比較 (date / dateTime / timeZone を考慮)
		const existingStart = existingEvent.start;
		const newStart = newPayload.start;
		// date プロパティが異なるか、または片方にしか存在しない場合
		if ((existingStart?.date || null) !== (newStart?.date || null)) return true;
		// dateTime プロパティが異なるか、または片方にしか存在しない場合
		if ((existingStart?.dateTime || null) !== (newStart?.dateTime || null)) {
			// 両方存在する場合は moment で比較 (タイムゾーンも考慮される)
			if (existingStart?.dateTime && newStart?.dateTime && !moment(existingStart.dateTime).isSame(moment(newStart.dateTime))) {
				return true;
			}
			// 片方しか存在しない場合は true (上でチェック済みだが念のため)
			if ((existingStart?.dateTime && !newStart?.dateTime) || (!existingStart?.dateTime && newStart?.dateTime)) {
				return true;
			}
		}
		// timeZone プロパティが異なる場合 (null/undefined も考慮)
		if ((existingStart?.timeZone || null) !== (newStart?.timeZone || null)) return true;

		// 5. 終了時刻の比較 (開始時刻と同様のロジック)
		const existingEnd = existingEvent.end;
		const newEnd = newPayload.end;
		if ((existingEnd?.date || null) !== (newEnd?.date || null)) return true;
		if ((existingEnd?.dateTime || null) !== (newEnd?.dateTime || null)) {
			if (existingEnd?.dateTime && newEnd?.dateTime && !moment(existingEnd.dateTime).isSame(moment(newEnd.dateTime))) {
				return true;
			}
			if ((existingEnd?.dateTime && !newEnd?.dateTime) || (!existingEnd?.dateTime && newEnd?.dateTime)) {
				return true;
			}
		}
		if ((existingEnd?.timeZone || null) !== (newEnd?.timeZone || null)) return true;

		// 6. 繰り返しルールの比較 (配列の内容を正規化して比較)
		const normalizeRRule = (r: string | undefined | null): string => (r ? (r.toUpperCase().startsWith('RRULE:') ? r.substring(6).trim() : r.trim()) : '');
		const oldRecurrence = (existingEvent.recurrence ?? []).map(normalizeRRule).filter(r => r).sort();
		const newRecurrence = (newPayload.recurrence ?? []).map(normalizeRRule).filter(r => r).sort();
		if (oldRecurrence.length !== newRecurrence.length || oldRecurrence.some((r, i) => r !== newRecurrence[i])) return true;

		// 7. 関連する拡張プロパティの比較 (念のため)
		const oldProps = existingEvent.extendedProperties?.private ?? {};
		const newProps = newPayload.extendedProperties?.private ?? {};
		if ((oldProps['obsidianTaskId'] || '') !== (newProps['obsidianTaskId'] || '')) {
			console.warn(`Obsidian Task ID が GCal イベント間で異なります: ${oldProps['obsidianTaskId']} vs ${newProps['obsidianTaskId']}`);
			return true;
		}
		if ((oldProps['isGcalSync'] || '') !== (newProps['isGcalSync'] || '')) return true;

		// 上記のいずれにも該当しない場合は、更新不要
		return false;
	}

}


// --- 設定タブ UI (最終同期時刻表示追加、ブロックリンクオプション削除、setClass修正) ---
class GoogleCalendarSyncSettingTab extends PluginSettingTab {
	plugin: GoogleCalendarTasksSyncPlugin;

	constructor(app: App, plugin: GoogleCalendarTasksSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty(); // コンテナをクリア
		containerEl.createEl('h2', { text: 'Google Calendar Sync 設定' });

		// --- Google 認証セクション ---
		containerEl.createEl('h3', { text: 'Google 認証' });
		// クライアントID
		new Setting(containerEl)
			.setName('クライアント ID')
			.setDesc('Google OAuth クライアント ID。Google Cloud Console で取得します。')
			.addText(text => text
				.setPlaceholder('クライアント ID を入力')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value.trim();
					await this.plugin.saveData(this.plugin.settings);
					this.plugin.reconfigureOAuthClient();
				}));
		// クライアントシークレット
		new Setting(containerEl)
			.setName('クライアントシークレット')
			.setDesc('Google OAuth クライアントシークレット。Google Cloud Console で取得します。')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('クライアントシークレットを入力')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveData(this.plugin.settings);
						this.plugin.reconfigureOAuthClient();
					});
			});

		// --- 認証リダイレクト (ローカルサーバー) セクション ---
		containerEl.createEl('h4', { text: '認証リダイレクト (ローカルサーバー)' });
		containerEl.createDiv('setting-item-description').append(
			'認証には、Google からの認証コードを受け取るための一時的なローカルウェブサーバー (HTTP ループバック) を使用します。',
			createEl('strong', { text: 'これが現在サポートされている唯一の方法です。' })
		);

		// ポート設定 (常に表示)
		new Setting(containerEl)
			.setName('ローカルサーバーポート (初期試行)')
			.setDesc('プラグインがローカルサーバーに最初に試行するポート (1024-65535)。使用中の場合、後続のポートを自動的に試します。ポートが変更された場合は Google Console の URI を更新してください。')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1024';
				text.inputEl.max = '65535';
				text.setPlaceholder(DEFAULT_SETTINGS.loopbackPort.toString())
					.setValue(this.plugin.settings.loopbackPort.toString())
					.onChange(async (value) => {
						const portNum = parseInt(value, 10);
						const currentPortSetting = this.plugin.settings.loopbackPort;
						if (!isNaN(portNum) && portNum >= 1024 && portNum <= 65535) {
							if (currentPortSetting !== portNum) {
								this.plugin.settings.loopbackPort = portNum;
								await this.plugin.saveSettings();
								this.display();
								new Notice(`ポート設定が ${portNum} に変更されました。`, 5000);
							}
						} else if (value !== currentPortSetting.toString()) {
							new Notice('無効なポート番号です (1024-65535)。', 5000);
							text.setValue(currentPortSetting.toString());
						}
					});
			});

		// 有効なリダイレクト URI (常に表示)
		const effectiveRedirectUri = this.plugin.getRedirectUri();
		new Setting(containerEl)
			.setName('リダイレクト URI (Google Console に必要)')
			.setDesc('この正確な URI を Google Cloud Console の「承認済みのリダイレクト URI」に追加してください。サーバーが異なるポートで自動起動した場合、Google Console の URI を更新する必要があります。')
			.addText(text => {
				text.inputEl.style.width = "100%";
				text.inputEl.readOnly = true;
				text.setValue(effectiveRedirectUri);
				text.setDisabled(true);

				const copyButton = new ExtraButtonComponent(text.inputEl.parentElement!)
					.setIcon('copy')
					.setTooltip('URI をコピー')
					.onClick(() => {
						navigator.clipboard.writeText(effectiveRedirectUri).then(
							() => new Notice('リダイレクト URI がコピーされました！', 2000),
							() => new Notice('コピーに失敗しました。', 3000)
						);
					});
				copyButton.extraSettingsEl.addClass('clickable-icon');
			 });

		// 認証ステータス表示
		const hasTokens = !!this.plugin.settings.tokens;
		const hasAccessToken = !!this.plugin.settings.tokens?.access_token;
		const isTokenCurrentlyValid = this.plugin.isTokenValid(false);
		const canRefreshToken = this.plugin.isTokenValid(true);

		let statusDesc = '未認証です。';
		let statusIcon = 'x-circle';
		let statusColor = 'var(--text-error)';

		if (hasTokens) {
			if (hasAccessToken && isTokenCurrentlyValid) {
				statusDesc = '認証済み。アクセストークンは有効です。';
				statusIcon = 'check-circle';
				statusColor = 'var(--text-success)';
			} else if (canRefreshToken) {
				statusDesc = '認証済みですが、アクセストークンが期限切れ/欠落しています。自動更新が有効です。';
				statusIcon = 'refresh-cw';
				statusColor = 'var(--text-warning)';
			} else {
				statusDesc = '認証が期限切れまたは不完全です (リフレッシュトークンなし)。再認証が必要です。';
				statusIcon = 'alert-circle';
				statusColor = 'var(--text-error)';
			}
		}
		// ステータス表示と認証/再認証ボタン
		new Setting(containerEl)
			.setName('認証ステータス')
			.setDesc(statusDesc)
			.addExtraButton(button => {
				button.setIcon(statusIcon)
					  .setTooltip(statusDesc);
				button.extraSettingsEl.style.color = statusColor;
			})
			.addButton(button => { // 認証/再認証ボタン
				button.setButtonText(hasTokens ? '再認証' : '認証')
					  .setTooltip(hasTokens ? 'Google で再承認する' : 'Google 認証を開始する')
					  .onClick(() => {
						  this.plugin.authenticate();
					  });
                // *** 修正箇所 ***
				// hasTokens が false (未認証) の場合のみ mod-cta クラスを追加
				if (!hasTokens) {
					button.setClass('mod-cta');
				}
                // hasTokens が true の場合はクラスを追加しない（空文字列を渡さない）
			});

		// --- 同期設定セクション ---
		containerEl.createEl('h3', { text: '同期設定' });
		// 同期対象の注意書き
        containerEl.createEl('p', {
            text: '開始日 (🛫 Start Date) と 期限日 (📅 Due Date) の両方を持つタスクのみが同期されます。',
            cls: 'setting-item-description'
        });
		// カレンダーID
		new Setting(containerEl)
			.setName('対象 Google Calendar ID')
			.setDesc('同期する Google Calendar の ID (デフォルトは "primary"、特定のカレンダー ID も指定可能)。')
			.addText(text => text
				.setPlaceholder('primary')
				.setValue(this.plugin.settings.calendarId)
				.onChange(async (value) => {
					this.plugin.settings.calendarId = value.trim() || 'primary';
					await this.plugin.saveSettings();
				}));
		// 自動同期トグル
		new Setting(containerEl)
			.setName('自動バックグラウンド同期')
			.setDesc('定期的にタスクを自動で同期します。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.display();
				}));
		// 同期間隔 (自動同期が有効な場合のみ表示)
		if (this.plugin.settings.autoSync) {
			new Setting(containerEl)
				.setName('同期間隔 (分)')
				.setDesc('同期を実行する頻度 (最小 1 分)。')
				.addText(text => {
					text.inputEl.type = 'number';
					text.inputEl.min = '1';
					text.setValue(this.plugin.settings.syncIntervalMinutes.toString())
						.setPlaceholder(DEFAULT_SETTINGS.syncIntervalMinutes.toString())
						.onChange(async (value) => {
							let minutes = parseInt(value, 10);
							const current = this.plugin.settings.syncIntervalMinutes;
							if (isNaN(minutes) || minutes < 1) {
								minutes = 1;
							}
							if (current !== minutes) {
								this.plugin.settings.syncIntervalMinutes = minutes;
								await this.plugin.saveSettings();
								text.setValue(minutes.toString());
							} else if (value !== minutes.toString()){
								text.setValue(minutes.toString());
							}
						});
				});
		}

		// --- 同期挙動オプションセクション ---
		containerEl.createEl('h3', { text: '同期挙動オプション' });
		// イベントタイミングの説明
		new Setting(containerEl)
			.setName('イベントのタイミング')
			.setDesc('Google Calendar イベントは、Obsidian の開始日 (🛫) をイベント開始、期限日 (📅) をイベント終了として使用します。(両方の日付を持つタスクのみ同期)。時刻の有無による終日/時間指定イベントの扱いは README を参照してください。');
		// デフォルトイベント期間
		new Setting(containerEl)
			.setName('デフォルトイベント期間 (分)')
			.setDesc('開始日と期限日の両方に時刻があるが、期限時刻が開始時刻より前の場合に使用される期間 (最小 5 分)。')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '5';
				const current = this.plugin.settings.defaultEventDurationMinutes;
				text.setValue(current.toString())
					.setPlaceholder(DEFAULT_SETTINGS.defaultEventDurationMinutes.toString())
					.onChange(async (value) => {
						const dur = parseInt(value, 10);
						let newDur = current;
						if (isNaN(dur) || dur < 5) {
							newDur = 5;
						} else {
							newDur = dur;
						}
						if (current !== newDur) {
							this.plugin.settings.defaultEventDurationMinutes = newDur;
							await this.plugin.saveSettings();
							text.setValue(newDur.toString());
						} else if(value !== newDur.toString()){
							text.setValue(newDur.toString());
						}
					});
			});
		// --- Google イベント説明欄の内容 ---
		containerEl.createEl('h4', { text: 'Google イベント説明欄の内容' });
		containerEl.createDiv({cls: 'setting-item-description', text: '同期されたタスクのイベント説明に含める詳細を選択します。'});
		// 優先度を追加
		new Setting(containerEl)
			.setName('優先度を追加')
			.setDesc('タスクの優先度 (例: "優先度: 🔼 中") を含めます。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncPriorityToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncPriorityToDescription = value;
					await this.plugin.saveSettings();
				}));
		// タグを追加
		new Setting(containerEl)
			.setName('タグを追加')
			.setDesc('Obsidian の #タグ を含めます。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncTagsToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncTagsToDescription = value;
					await this.plugin.saveSettings();
				}));
		// 予定日を追加
		new Setting(containerEl)
			.setName('予定日 (⏳) を追加')
			.setDesc('予定日を説明に含めます (同期タイミングには影響しません)。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncScheduledDateToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncScheduledDateToDescription = value;
					await this.plugin.saveSettings();
				}));

		// --- 手動アクション & デバッグセクション ---
		containerEl.createEl('h3', { text: '手動アクション & デバッグ' });
		// 強制同期ボタン
		new Setting(containerEl)
			.setName('今すぐ強制同期')
			.setDesc('手動で同期サイクルを実行します。')
			.addButton(button => button
				.setButtonText('今すぐ同期')
				.setIcon('sync')
				.setTooltip('すぐに同期を実行する')
				.onClick(async () => {
					if (this.plugin.isCurrentlySyncing()) {
						new Notice("同期は既に進行中です。", 3000);
						return;
					}
					new Notice('手動同期をトリガーしました...', 2000);
					await this.plugin.syncTasks();
					this.display();
				}));

		// 最終同期時刻の表示
		const lastSyncDesc = this.plugin.settings.lastSyncTime
			? `最終成功同期: ${moment(this.plugin.settings.lastSyncTime).calendar()} (${moment(this.plugin.settings.lastSyncTime).fromNow()})`
			: 'まだ正常に同期されていません。';
		containerEl.createEl('p', { text: lastSyncDesc, cls: 'setting-item-description' });

		// タスクマップキャッシュのクリアボタン
		new Setting(containerEl)
			.setName('タスクマップキャッシュをクリア')
			.setDesc('⚠️ タスクとイベント間の保存済みリンクをリセットします。次回の同期で重複イベントが発生する可能性があります。同期が壊れている場合に使用してください。')
			.addButton(button => button
				.setButtonText('タスクマップをクリア')
				.setIcon('trash-2')
				.setWarning()
				.onClick(async () => {
					if (confirm('本当にタスクマップキャッシュをクリアしますか？ この操作は元に戻せず、次回の同期で重複イベントが発生する可能性があります。')) {
						this.plugin.settings.taskMap = {};
						this.plugin.settings.lastSyncTime = undefined;
						await this.plugin.saveData(this.plugin.settings);
						new Notice('タスクマップと最終同期時刻がクリアされました。');
						this.display();
					}
				}));
		// 現在のマップキャッシュのエントリ数を表示
		const taskCount = Object.keys(this.plugin.settings.taskMap).length;
		containerEl.createEl('p', {
			text: `キャッシュ内で ${taskCount} 件のタスクのリンクを追跡中。`,
			cls: 'setting-item-description'
		});
	}
}