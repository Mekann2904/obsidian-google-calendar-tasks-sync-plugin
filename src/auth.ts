// auth.ts

import { Notice } from 'obsidian';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { google, calendar_v3 } from 'googleapis';
import { randomBytes } from 'crypto';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート
import { DEFAULT_SETTINGS } from './settings'; // DEFAULT_SETTINGS をインポート

export class AuthService {
    private plugin: GoogleCalendarTasksSyncPlugin;
    private activeOAuthState: string | null = null;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
    }

    /**
     * Google OAuth 認証フローでリダイレクト先として使用される URI を取得します。
     * 設定されたポート番号を使用します。
     */
    getRedirectUri(): string {
        const port = this.plugin.settings.loopbackPort;
        if (port >= 1024 && port <= 65535) {
            return `http://127.0.0.1:${port}/oauth2callback`;
        } else {
            console.warn(`設定されているループバックポート番号が無効です: ${port}。URI生成にはデフォルトポート ${DEFAULT_SETTINGS.loopbackPort} を使用します。`);
            return `http://127.0.0.1:${DEFAULT_SETTINGS.loopbackPort}/oauth2callback`;
        }
    }

    /**
     * メインの OAuth2 クライアントインスタンスを再設定します。
     * プラグインインスタンスの oauth2Client プロパティを更新します。
     */
    reconfigureOAuthClient(): void {
        const redirectUri = this.getRedirectUri();
        try {
            this.plugin.oauth2Client = new OAuth2Client({
                clientId: this.plugin.settings.clientId,
                clientSecret: this.plugin.settings.clientSecret,
                redirectUri: redirectUri,
            });
        } catch (e) {
            console.error("OAuth2Client インスタンスの作成中にエラー:", e);
            this.plugin.oauth2Client = null; // 作成に失敗した場合は null を割り当てる
            return;
        }
        // トークンが存在する場合は適用
        if (this.plugin.settings.tokens && this.plugin.oauth2Client) {
            try { this.plugin.oauth2Client.setCredentials(this.plugin.settings.tokens); }
            catch (e) { console.error("OAuth クライアント再設定中にクレデンシャル適用エラー:", e); }
        }
        // トークンリスナーをアタッチ
        this.attachTokenListener();
    }

    /**
     * 'tokens' イベントリスナーを OAuth クライアントにアタッチします (トークン更新の処理用)。
     */
    attachTokenListener(): void {
        if (!this.plugin.oauth2Client) {
            console.warn("トークンリスナーをアタッチできません: OAuth クライアントが初期化されていません。");
            return;
        }
        // 既存のリスナーを削除して重複を防ぐ
        this.plugin.oauth2Client.removeAllListeners('tokens');
        // 新しいリスナーを追加
        this.plugin.oauth2Client.on('tokens', async (tokens) => {
            console.log("OAuth クライアントが 'tokens' イベントを発行しました (おそらくトークンリフレッシュ)。");
            const currentRefreshToken = this.plugin.settings.tokens?.refresh_token;
            const newRefreshToken = tokens.refresh_token;

            // 既存のトークンと新しいトークンをマージ (リフレッシュトークンを優先)
            const updatedTokens: Credentials = {
                ...this.plugin.settings.tokens, // 既存のフィールド (リフレッシュトークンなど) を保持
                ...tokens,              // 新しいアクセストークン、有効期限などで上書き
                refresh_token: newRefreshToken || currentRefreshToken // 新しいリフレッシュトークンがあれば使用、なければ既存のものを維持
            };

            if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
                console.log("新しいリフレッシュトークンを受信しました。");
            }

            this.plugin.settings.tokens = updatedTokens;
            try {
                 await this.plugin.saveData(this.plugin.settings); // 更新されたトークンを永続化
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
     * プラグインインスタンスの calendar プロパティを更新します。
     */
    initializeCalendarApi(): void {
        if (!this.plugin.oauth2Client) {
            console.warn("Calendar API を初期化できません: OAuth クライアントが設定されていません。");
            if (this.plugin.calendar) this.plugin.calendar = null; // 既存のクライアントがあればクリア
            return;
        }
        // 認証情報（特にアクセストークン）が存在するか確認
        const credentials = this.plugin.oauth2Client.credentials;
        if (this.plugin.settings.tokens && credentials && credentials.access_token) {
            // calendar インスタンスが存在しないか、認証クライアントが異なる場合にのみ再作成
            // または、認証情報が更新された場合（アクセストークンが変わった場合など）も再作成を検討
             if (!this.plugin.calendar || (this.plugin.calendar as any)._options?.auth !== this.plugin.oauth2Client || (this.plugin.calendar as any)._options.auth.credentials.access_token !== credentials.access_token) {
                 try {
                    this.plugin.calendar = google.calendar({ version: 'v3', auth: this.plugin.oauth2Client });
                    console.log('Google Calendar API クライアントが初期化または更新されました。');
                 } catch(e) {
                     console.error("Google Calendar API クライアントの初期化に失敗しました:", e);
                     this.plugin.calendar = null;
                 }
            }
        } else {
            // トークンがない、またはアクセストークンがない場合は、APIクライアントをクリア
            if (this.plugin.calendar) {
                console.log('Google Calendar API クライアントを解除します (トークン欠落または無効なクライアント)。');
                this.plugin.calendar = null;
            }
        }
    }

    /**
     * Google OAuth 認証フローを開始します。
     * ブラウザウィンドウを開き、ユーザーに承認を求めます。
     */
    authenticate(): void {
        // クライアントIDとシークレットが設定されているか確認
        if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
            new Notice('認証失敗: クライアント ID とクライアントシークレットを設定する必要があります。', 7000);
            return;
        }
        // OAuthクライアントが最新の設定を使用するように再設定
        this.reconfigureOAuthClient();
        if (!this.plugin.oauth2Client) {
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
            const authUrl = this.plugin.oauth2Client.generateAuthUrl({
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
     * Google からのリダイレクト (OAuth コールバック) を処理します。
     * state の検証、エラーの確認、認証コードのトークンとの交換を行います。
     */
    async handleOAuthCallback(params: Record<string, string>): Promise<void> {
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
            const redirectUriForExchange = this.getRedirectUri();
            const tokenExchangeClient = new OAuth2Client({
                clientId: this.plugin.settings.clientId,
                clientSecret: this.plugin.settings.clientSecret,
                redirectUri: redirectUriForExchange,
            });

            console.log(`リダイレクト URI を使用してトークン交換を試行中: ${redirectUriForExchange}`);
            const { tokens } = await tokenExchangeClient.getToken(code);
            console.log('トークンを正常に受信しました。');

            const currentRefreshToken = this.plugin.settings.tokens?.refresh_token;
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
                ...this.plugin.settings.tokens,
                ...tokens,
                refresh_token: newRefreshToken || currentRefreshToken
            };

            // メインプラグインの OAuth クライアントと設定を更新
            if (this.plugin.oauth2Client) {
                (this.plugin.oauth2Client as OAuth2Client).setCredentials(finalTokens);
            } else {
                // oauth2Client が null の場合、再設定を試みる
                this.reconfigureOAuthClient();
                if (this.plugin.oauth2Client) {
                    (this.plugin.oauth2Client as OAuth2Client).setCredentials(finalTokens);
                } else {
                    console.error("トークン交換後、OAuth クライアントを設定できませんでした。");
                }
            }
            this.plugin.settings.tokens = finalTokens;

            // saveData を直接使用して、saveSettings の副作用を回避
            await this.plugin.saveData(this.plugin.settings);

            // 依存コンポーネントを手動で再初期化
            this.initializeCalendarApi(); // API クライアントが新しいトークンを使用するようにする
            this.plugin.setupAutoSync(); // 自動同期を再設定
            this.attachTokenListener(); // リスナーを再アタッチ

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
                 if (responseData.error === 'invalid_grant') {
                    errorMessage += " (考えられる原因: 認証コードの期限切れ/使用済み、クロックスキュー、*トークンリクエスト* に使用されたリダイレクト URI が正しくない)。";
                 } else if (responseData.error === 'redirect_uri_mismatch') {
                     errorMessage += ` (トークン交換中に送信されたリダイレクト URI [${this.getRedirectUri()}] が、Google Cloud Console に登録されたものと完全に一致しない可能性があります)。`;
                 } else if (responseData.error === 'invalid_client') {
                      errorMessage += " (設定のクライアント ID および/またはクライアントシークレットを確認してください)。";
                 }
            } else if (err.message) {
                errorMessage += ` エラー: ${err.message}`;
            }
            new Notice(errorMessage + ' Obsidian コンソールで詳細を確認してください。', 15000);
            throw new Error(errorMessage);
        }
    }

    /**
     * OAuth トークンが有効かどうかを確認します。
     * @param checkRefresh true の場合、リフレッシュトークンの存在のみを確認します。false の場合、アクセストークンの有効期限を確認します。
     * @returns トークンが有効な場合は true、そうでない場合は false。
     */
    isTokenValid(checkRefresh: boolean = false): boolean {
        const tokens = this.plugin.settings.tokens;
        if (!tokens) return false;

        if (checkRefresh) {
            return !!tokens.refresh_token;
        } else {
            if (!tokens.access_token) return false;
            if (tokens.expiry_date) {
                // 有効期限の5分前まで有効とみなす（ネットワーク遅延等を考慮）
                return tokens.expiry_date > Date.now() + (5 * 60 * 1000);
            }
            // 有効期限がない場合 (通常は発生しないはずだが)、有効とみなす
            // API 呼び出し時にエラーになる可能性はある
            return true;
        }
    }

    /**
     * アクセストークンが必要な場合にリフレッシュを試みます。
     * @returns {Promise<boolean>} リフレッシュが成功したか、または不要だった場合は true、失敗した場合は false。
     */
    async ensureAccessToken(): Promise<boolean> {
        if (this.isTokenValid(false)) {
            return true;
        }

        if (!this.isTokenValid(true)) {
            console.warn("アクセストークンが必要ですが、リフレッシュトークンがありません。");
            new Notice("認証トークンの更新が必要です。設定から再認証してください。", 7000);
            this.plugin.clearAutoSync();
            this.plugin.settings.tokens = null;
            await this.plugin.saveData(this.plugin.settings);
            this.initializeCalendarApi();
            return false;
        }

        const client = this.plugin.oauth2Client;
        if (!client) {
            console.error("トークンリフレッシュを試行できません: OAuthクライアントがありません。");
            return false;
        }

        console.log("アクセストークンが期限切れまたは欠落しています。リフレッシュを試行中...");
        try {
            if (this.plugin.settings.tokens) {
                client.setCredentials(this.plugin.settings.tokens);
            }

            const { credentials } = await client.refreshAccessToken();
            console.log("トークンリフレッシュAPI呼び出し成功。");

            // 'tokens' イベントリスナーに頼らず、ここで直接トークンを処理する
            const currentRefreshToken = this.plugin.settings.tokens?.refresh_token;
            const newRefreshToken = credentials.refresh_token;

            const updatedTokens: Credentials = {
                ...this.plugin.settings.tokens,
                ...credentials,
                refresh_token: newRefreshToken || currentRefreshToken,
            };

            if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
                console.log("新しいリフレッシュトークンを受信しました。");
            }

            this.plugin.settings.tokens = updatedTokens;
            // client のクレデンシャルも更新しておく
            client.setCredentials(updatedTokens);

            await this.plugin.saveData(this.plugin.settings);
            console.log("更新されたトークンは正常に保存されました。");

            this.initializeCalendarApi();

            console.log("トークンのリフレッシュ成功。");
            new Notice('Google 認証トークンが更新されました。', 4000);
            return true;

        } catch (error: any) {
            console.error("トークンのリフレッシュに失敗しました:", error);
            const respErr = error?.response?.data?.error;
            const respErrDesc = error?.response?.data?.error_description;
            let noticeMsg = `トークンのリフレッシュに失敗しました (${respErr || '不明なエラー'})。`;
            if (respErrDesc) noticeMsg += ` ${respErrDesc}`;

            if (respErr === 'invalid_grant') {
                noticeMsg = 'トークンリフレッシュ失敗: 認証が無効になりました。再認証してください。';
                this.plugin.settings.tokens = null;
                await this.plugin.saveData(this.plugin.settings);
                this.plugin.clearAutoSync();
                this.initializeCalendarApi();
            }
            new Notice(noticeMsg, 15000);
            return false;
        }
    }
}