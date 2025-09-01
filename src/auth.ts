// auth.ts

import { Notice } from 'obsidian';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { google } from 'googleapis';
import { randomBytes, createHash } from 'crypto';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート
import { DEFAULT_SETTINGS } from './settings'; // DEFAULT_SETTINGS をインポート

export class AuthService {
    private plugin: GoogleCalendarTasksSyncPlugin;
    private activeOAuthState: string | null = null;
    private activePkceVerifier: string | null = null;
    private activeOAuthStateIssuedAt: number | null = null;
    private lastPersistAt = 0;

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
            const hasSecret = !!this.plugin.settings.clientSecret;
            this.plugin.oauth2Client = new OAuth2Client({
                clientId: this.plugin.settings.clientId,
                ...(hasSecret ? { clientSecret: this.plugin.settings.clientSecret } : {}),
                redirectUri: redirectUri,
            } as any);
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

            try {
                 const now = Date.now();
                 if (now - this.lastPersistAt < 3000 && !newRefreshToken) {
                    // 3秒以内の重複保存（refresh_token 変化なし）はスキップ
                    return;
                 }
                 await this.plugin.persistTokens(updatedTokens);
                 this.lastPersistAt = now;
                 console.log("更新されたトークンは正常に保存されました（暗号化）。");
                 // 再初期化は不要（oauth2Client を calendar に渡しているため自動で反映）
            } catch (saveError) {
                 console.error("更新されたトークンの保存に失敗しました:", saveError);
                 new Notice("更新された Google トークンの保存中にエラーが発生しました。コンソールを確認してください。", 5000);
            }
        });
    }

    /**
     * Google Calendar API サービスクライアントを初期化します。
     * OAuth クライアントがあれば常に作成し、自動リフレッシュに委ねる。
     */
    initializeCalendarApi(): void {
        const client = this.plugin.oauth2Client;
        if (!client) {
            console.warn("Calendar API を初期化できません: OAuth クライアント未設定。");
            this.plugin.calendar = null;
            return;
        }
        try {
            this.plugin.calendar = google.calendar({ version: 'v3', auth: client });
            console.log('Google Calendar API クライアントを初期化しました。');
        } catch (e) {
            console.error('Google Calendar API クライアントの初期化に失敗:', e);
            this.plugin.calendar = null;
        }
    }

    /**
     * Google OAuth 認証フローを開始します。
     * ブラウザウィンドウを開き、ユーザーに承認を求めます。
     */
    authenticate(): void {
        // クライアントIDのみ必須（デスクトップ/ループバックでは secret 省略可）
        if (!this.plugin.settings.clientId) {
            new Notice('認証失敗: クライアント ID を設定する必要があります。', 7000);
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
            this.activeOAuthStateIssuedAt = Date.now();
            console.log("生成された OAuth state:", this.activeOAuthState);

            // 認証URLを生成
            // PKCE (S256) を使用
            const codeVerifier = this.generatePkceVerifier();
            this.activePkceVerifier = codeVerifier;
            const codeChallenge = this.pkceChallenge(codeVerifier);

            const needsRefreshToken = !this.plugin.settings.tokens?.refresh_token;
            const authUrl = this.plugin.oauth2Client.generateAuthUrl({
                access_type: 'offline',
                include_granted_scopes: true,
                prompt: needsRefreshToken ? 'consent' : undefined,
                scope: ['https://www.googleapis.com/auth/calendar.events'],
                state: this.activeOAuthState!,
                redirect_uri: currentRedirectUri,
                code_challenge_method: 'S256' as any,
                code_challenge: codeChallenge as any,
            } as any);

            // 認証URLを既定ブラウザで開く（Obsidian/Electron 環境に対応）
            console.log('Google 認証 URL を開いています...');
            try {
                // Obsidianの実行環境ではElectronが利用可能
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                require('electron').shell.openExternal(authUrl);
            } catch {
                window.open(authUrl, '_blank');
            }
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
        const issuedAt = this.activeOAuthStateIssuedAt;
        const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10分

        // 1. State パラメータの検証 (CSRF 保護)
        if (!currentActiveState) {
            console.warn("アクティブな OAuth state が見つかりません。コールバックを無視します。重複または予期しない可能性があります。");
            throw new Error('アクティブな認証試行が見つかりません。Obsidian の設定から再度認証を開始してください。');
        }
        if (!issuedAt || (Date.now() - issuedAt) > MAX_STATE_AGE_MS) {
            this.activeOAuthState = null; this.activeOAuthStateIssuedAt = null;
            throw new Error('認証フローがタイムアウトしました。再度お試しください。');
        }
        if (!state || state !== currentActiveState) {
            this.activeOAuthState = null; this.activeOAuthStateIssuedAt = null; // 無効な state を直ちにクリア
            console.error('OAuth エラー: 無効な state パラメータを受信しました。', '受信:', state, '期待値:', currentActiveState);
            new Notice('認証失敗: セキュリティトークンの不一致 (無効な state)。再度認証を試みてください。', 10000);
            throw new Error('無効な state パラメータ。認証フローが侵害されたか、タイムアウトした可能性があります。');
        }
        console.log("OAuth state の検証に成功しました。");
        this.activeOAuthState = null; this.activeOAuthStateIssuedAt = null; // 検証成功後にクリア

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
            const hasSecret = !!this.plugin.settings.clientSecret;
            const tokenExchangeClient = new OAuth2Client({
                clientId: this.plugin.settings.clientId,
                ...(hasSecret ? { clientSecret: this.plugin.settings.clientSecret } : {}),
                redirectUri: redirectUriForExchange,
            } as any);

            console.log(`リダイレクト URI を使用してトークン交換を試行中: ${redirectUriForExchange}`);
            const tokenParams: any = { code, codeVerifier: this.activePkceVerifier, redirect_uri: redirectUriForExchange };
            const { tokens } = await tokenExchangeClient.getToken(tokenParams);
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
            await this.plugin.persistTokens(finalTokens);

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
        } finally {
            this.activePkceVerifier = null;
            this.activeOAuthState = null;
            this.activeOAuthStateIssuedAt = null;
        }
    }

    /**
     * OAuth トークンが有効かどうかを確認します。
     * @param checkRefresh true の場合、リフレッシュトークンの存在のみを確認します。false の場合、アクセストークンの有効期限を確認します。
     * @returns トークンが有効な場合は true、そうでない場合は false。
     */
    isTokenValid(checkRefresh: boolean = false): boolean {
        if (checkRefresh) {
            return !!(this.plugin.settings.tokens?.refresh_token || this.plugin.settings.tokensEncrypted);
        }
        const c = this.plugin.oauth2Client?.credentials;
        if (!c?.access_token) return false;
        if (c.expiry_date) return c.expiry_date > Date.now() + 5 * 60 * 1000;
        return true;
    }

    /**
     * アクセストークンが必要な場合にリフレッシュを試みます。
     * @returns {Promise<boolean>} リフレッシュが成功したか、または不要だった場合は true、失敗した場合は false。
     */
    async ensureAccessToken(): Promise<boolean> {
        // 現在のアクセストークンが有効なら何もしない
        if (this.isTokenValid(false)) return true;

        // リフレッシュ可能でない場合は再認証を促す
        if (!this.isTokenValid(true)) {
            console.warn("アクセストークンが必要ですが、リフレッシュトークンがありません。");
            new Notice("認証トークンの更新が必要です。設定から再認証してください。", 7000);
            this.plugin.clearAutoSync();
            await this.plugin.persistTokens(null);
            return false;
        }

        const client = this.plugin.oauth2Client;
        if (!client) {
            console.error("トークン確認を実行できません: OAuth クライアントがありません。");
            return false;
        }

        // クレデンシャルを適用し、getAccessToken() で更新をトリガー
        try {
            if (this.plugin.settings.tokens) client.setCredentials(this.plugin.settings.tokens);
            await client.getAccessToken(); // 期限切れなら自動リフレッシュ
            return true;
        } catch (error: any) {
            console.error("アクセストークン取得/更新に失敗:", error);
            const respErr = error?.response?.data?.error;
            const respErrDesc = error?.response?.data?.error_description;
            let noticeMsg = `トークンの更新に失敗しました (${respErr || '不明なエラー'})。`;
            if (respErrDesc) noticeMsg += ` ${respErrDesc}`;
            if (respErr === 'invalid_grant') {
                noticeMsg = 'トークンが無効です。再認証してください。';
                await this.plugin.persistTokens(null);
                this.plugin.clearAutoSync();
            }
            new Notice(noticeMsg, 15000);
            return false;
        }
    }

    /** 完全サインアウト: トークン取り消しとクリア */
    async revokeAndClear(): Promise<void> {
        try {
            const token = this.plugin.oauth2Client?.credentials?.access_token || this.plugin.settings.tokens?.access_token;
            if (token && this.plugin.oauth2Client) {
                await this.plugin.oauth2Client.revokeToken(token);
            }
        } catch (e) {
            console.warn('トークン取り消しに失敗:', e);
        } finally {
            await this.plugin.persistTokens(null);
            this.plugin.clearAutoSync();
            this.initializeCalendarApi();
        }
    }

    // ------------------------------------------------------------------
    // PKCE ユーティリティ
    // ------------------------------------------------------------------
    private generatePkceVerifier(): string {
        // 43〜128文字の英数+[-._~]
        const buf = randomBytes(32);
        return this.base64url(buf);
    }

    private pkceChallenge(verifier: string): string {
        const hash = createHash('sha256').update(verifier).digest();
        return this.base64url(hash);
    }

    private base64url(input: Buffer): string {
        return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
}
