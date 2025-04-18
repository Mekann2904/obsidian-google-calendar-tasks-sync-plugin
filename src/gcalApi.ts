import { Notice, request, RequestUrlParam } from 'obsidian';
import { calendar_v3 } from 'googleapis';
import { randomBytes } from 'crypto';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート
import { GoogleCalendarTasksSyncSettings, BatchRequestItem, BatchResponseItem } from './types';
import { isGaxiosError } from './utils';
import { GaxiosResponse } from 'gaxios';

/**
 * Google Calendar との低レベル通信を担うサービスクラス。
 * - **fetchGoogleCalendarEvents** … 拡張プロパティ `isGcalSync=true` が付いたイベントを全て取得
 * - **executeBatchRequest** … Batch API(v3) を使った一括 CRUD 実行
 *   * 409 Conflict を item‑level エラーとして握りつぶし、致命的停止を回避
 *   * 認証エラー時にはアクセストークン再取得を試行
 * - **parseBatchResponse / parseSingleBatchPart** … multipart/mixed をパースして高レベル構造体に変換
 */
export class GCalApiService {
    private plugin: GoogleCalendarTasksSyncPlugin;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
    }

    /**
     * このプラグインによって作成された Google Calendar イベントを取得します。
     */
    async fetchGoogleCalendarEvents(): Promise<calendar_v3.Schema$Event[]> {
        if (!this.plugin.calendar) {
            this.plugin.authService.initializeCalendarApi();
            if (!this.plugin.calendar) {
                throw new Error("Calendar API が初期化されていません。");
            }
        }

        const existingEvents: calendar_v3.Schema$Event[] = [];
        let nextPageToken: string | undefined;
        const requestParams: calendar_v3.Params$Resource$Events$List = {
            calendarId: this.plugin.settings.calendarId,
            privateExtendedProperty: ["isGcalSync=true"],
            showDeleted: false,
            maxResults: 250,
            singleEvents: false,
        };

        console.log("このプラグインによってマークされた全ての GCal イベントを取得中...");

        try {
            let page = 1;
            do {
                console.log(`GCal イベントページ ${page} を取得中...`);
                requestParams.pageToken = nextPageToken;
                const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.plugin.calendar!.events.list(requestParams);

                if (response.data.items) {
                    existingEvents.push(...response.data.items);
                }
                nextPageToken = response.data.nextPageToken ?? undefined;
                page++;
            } while (nextPageToken);

            console.log(`合計 ${existingEvents.length} 件の GCal イベントを取得しました。`);
            return existingEvents;
        } catch (e: any) {
            const errorMsg = isGaxiosError(e)
                ? e.response?.data?.error?.message || e.message
                : String(e);
            console.error("GCal イベントの取得中に致命的なエラー:", e);
            new Notice(`GCal イベントの取得エラー: ${errorMsg}。同期を中止しました。`, 10_000);
            throw new Error(`GCal イベントの取得に失敗しました: ${errorMsg}`);
        }
    }

    // ---------------------------------------------------------------------
    // Batch API
    // ---------------------------------------------------------------------

    /**
     * 準備されたバッチリクエストを実行します。
     *
     * 仕様上、バッチ全体が 409 Conflict で返るケース（削除対象が既に無い等）がある。
     * 409 は致命的ではないため、結果を解析して上位へ返却する。
     */
    async executeBatchRequest(batchRequests: BatchRequestItem[]): Promise<BatchResponseItem[]> {
        // 1) 認証チェックとトークンリフレッシュ
        if (!this.plugin.oauth2Client || !this.plugin.settings.tokens?.access_token) {
            const tokenRefreshed = await this.plugin.authService.ensureAccessToken();
            if (!tokenRefreshed || !this.plugin.settings.tokens?.access_token) {
                throw new Error("バッチリクエストを実行できません: 認証トークンを取得できませんでした。");
            }
        }

        // 2) multipart/mixed リクエストを組み立て
        const boundary = `batch_${randomBytes(16).toString("hex")}`;
        const batchUrl = "https://www.googleapis.com/batch/calendar/v3";
        let body = "";

        batchRequests.forEach((req, idx) => {
            body += `--${boundary}\r\n`;
            body += `Content-Type: application/http\r\n`;
            body += `Content-ID: <item-${idx + 1}>\r\n\r\n`;
            body += `${req.method} ${req.path}\r\n`;

            // ユーザー定義ヘッダー
            if (req.headers) {
                Object.entries(req.headers).forEach(([k, v]) => {
                    body += `${k}: ${v}\r\n`;
                });
            }
            // BODY
            if (req.body) {
                body += "Content-Type: application/json; charset=UTF-8\r\n\r\n";
                body += JSON.stringify(req.body);
            }
            body += "\r\n"; // Part 終端
        });
        body += `--${boundary}--\r\n`;

        const requestParams: RequestUrlParam = {
            url: batchUrl,
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.plugin.settings.tokens!.access_token}`,
                "Content-Type": `multipart/mixed; boundary=${boundary}`,
            },
            body,
            throw: false, // ステータスコードに関わらずレスポンスを取得
        };

        // 3) 送信
        try {
            console.log(`${batchRequests.length} 件の操作を含むバッチリクエストを送信中...`);
            const responseText = await request(requestParams);

            // --- ステータス推定 ---
            let responseStatus = 200;
            try {
                const maybeJson = JSON.parse(responseText);
                if (maybeJson?.error?.code) responseStatus = maybeJson.error.code as number;
            } catch {
                const statusMatch = responseText.match(/^HTTP\/\d\.\d\s+(\d+)/m);
                if (statusMatch) {
                    responseStatus = parseInt(statusMatch[1], 10);
                } else if (!responseText.includes(`--${boundary}`)) {
                    responseStatus = 500; // 不明なエラー
                }
            }
            console.log(`バッチ応答ステータス (推定): ${responseStatus}`);

            // 4) 致命的エラー判定
            if (responseStatus >= 400 && responseStatus !== 409) {
                // 409 は item‑level エラーとして処理するため throw しない
                console.error("バッチリクエスト全体が失敗しました:", responseStatus, responseText.slice(0, 1000));
                let details = responseText.slice(0, 500);
                try {
                    const errJson = JSON.parse(responseText);
                    details = errJson?.error?.message || details;
                } catch {/* ignore */}
                throw new Error(`バッチリクエストがステータス ${responseStatus} で失敗しました: ${details}`);
            }

            // 5) レスポンスを解析
            const results = this.parseBatchResponse(responseText, boundary);
            // Conflict (409) を警告ログにとどめて続行
            const conflictCount = results.filter(r => r.status === 409).length;
            if (conflictCount) {
                console.warn(`バッチ応答に 409 Conflict が ${conflictCount} 件含まれています。対象リソースが既に無い可能性があります。`);
            }
            return results;
        } catch (error) {
            // 認証・権限系などの例外処理
            console.error("バッチリクエストの実行または処理中にエラー:", error);
            if (error instanceof Error) {
                const msg = error.toString();
                if (/401|invalid_grant|invalid credential/i.test(msg)) {
                    new Notice("同期中の認証エラー。再認証を試みてください。", 10_000);
                    this.plugin.settings.tokens = null;
                    await this.plugin.saveData(this.plugin.settings);
                    this.plugin.authService.initializeCalendarApi();
                    this.plugin.clearAutoSync();
                } else if (/403/.test(msg)) {
                    new Notice("権限エラー(403)。カレンダーAPIが有効か、権限スコープを確認してください。", 10_000);
                }
            }
            throw error;
        }
    }

    // ---------------------------------------------------------------------
    // multipart/mixed パース
    // ---------------------------------------------------------------------

    /**
     * Google Batch API からの multipart/mixed レスポンスをパースします。
     */
    private parseBatchResponse(responseText: string, boundary: string): BatchResponseItem[] {
        const results: BatchResponseItem[] = [];
        const delimiter = `--${boundary}`;
        const parts = responseText.split(delimiter).filter(p => p.trim() && p.trim() !== "--");

        for (const rawPart of parts) {
            const cleaned = rawPart.replace(/^\r?\n|\r?\n$/g, "");
            const parsed = this.parseSingleBatchPart(cleaned);
            if (parsed) {
                results.push(parsed);
            } else {
                // パース失敗でも結果を返す（エラー扱い）
                results.push({ status: 500, body: { error: { message: "Failed to parse batch response part." } } });
            }
        }
        console.log(`${results.length} 件のバッチ応答アイテムを抽出しました。`);
        return results;
    }

    /**
     * 個別のバッチ応答パートをパースします。
     */
    private parseSingleBatchPart(partText: string): BatchResponseItem | null {
        const lines = partText.split(/\r?\n/);
        const statusLineIdx = lines.findIndex(l => l.startsWith("HTTP/"));
        const headerEndIdx = lines.findIndex((l, idx) => idx > statusLineIdx && l.trim() === "");

        if (statusLineIdx === -1 || headerEndIdx === -1) {
            console.warn("バッチパート内で HTTP ステータス行/ヘッダー終端が見つかりません:", lines.slice(0, 5).join("\n"));
            return null;
        }

        // ステータス行
        const statusLine = lines[statusLineIdx];
        const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

        // ボディ
        const bodyRaw = lines.slice(headerEndIdx + 1).join("\n").trim();
        let bodyJson: any = null;
        if (bodyRaw) {
            try {
                bodyJson = JSON.parse(bodyRaw);
            } catch {
                bodyJson = { message: bodyRaw.slice(0, 200) + (bodyRaw.length > 200 ? "…" : "") };
            }
        }
        return { status, body: bodyJson };
    }
}
