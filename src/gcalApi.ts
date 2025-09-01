import { Notice, requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { calendar_v3 } from 'googleapis';
import { randomBytes } from 'crypto';
import GoogleCalendarTasksSyncPlugin from './main';
import { GoogleCalendarTasksSyncSettings, BatchRequestItem, BatchResponseItem } from './types';
import { isGaxiosError } from './utils';
import { GaxiosResponse } from 'gaxios';

export class GCalApiService {
    private plugin: GoogleCalendarTasksSyncPlugin;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
    }

    /**
     * このプラグインによって作成された Google Calendar イベントを取得します。
     */
    async fetchGoogleCalendarEvents(settings: GoogleCalendarTasksSyncSettings): Promise<calendar_v3.Schema$Event[]> {
        if (!this.plugin.calendar) {
            this.plugin.authService.initializeCalendarApi();
            if (!this.plugin.calendar) {
                throw new Error("Calendar API が初期化されていません。");
            }
        }

        const existingEvents: calendar_v3.Schema$Event[] = [];
        let nextPageToken: string | undefined;
        let nextSyncToken: string | undefined;

        // 重要: デフォルトは全件取得。一方で設定が有効でsyncTokenがある場合は増分取得を試行（失敗時は全件へフォールバック）。
        const trySyncToken = !!settings.useSyncToken && !!(this.plugin as any).settings?.syncToken;

        // [重要] 同一条件原則: 初回フル取得と同一の検索条件を維持する。
        // 但し、syncToken 使用時は showDeleted を有効化し、削除（cancelled）イベントを確実に取得する。
        const requestParams: calendar_v3.Params$Resource$Events$List = {
            calendarId: settings.calendarId,
            privateExtendedProperty: ["isGcalSync=true", "appId=obsidian-gcal-tasks"], // 初回と増分で同一条件を維持（自プラグイン生成に限定）
            showDeleted: trySyncToken ? true : false, // 増分時は true（仕様順守）。フル取得時は false。
            maxResults: 2500, // ページング削減（上限 2500）
            singleEvents: false,
            // ペイロード削減（必要最小限のフィールド）+ originalStartTime 追加（識別用に summary も含む）
            fields: 'items(id,summary,etag,status,updated,extendedProperties,recurringEventId,originalStartTime),nextPageToken,nextSyncToken',
        };

        // [自己監査] syncToken 条件固定: 初回フル取得のフィルタ署名を保存し、増分時に比較（差異があれば警告）。
        const sig = {
            calendarId: requestParams.calendarId!,
            privateExtendedProperty: (requestParams.privateExtendedProperty || []).slice().sort(),
            singleEvents: !!requestParams.singleEvents,
            fields: requestParams.fields || '',
        };
        const savedSig = (this.plugin as any).settings?.listFilterSignature as typeof sig | undefined;
        if (!trySyncToken && !savedSig) {
            (this.plugin as any).settings.listFilterSignature = sig;
            try { await (this.plugin as any).saveData((this.plugin as any).settings); } catch {}
        } else if (trySyncToken && savedSig) {
            const same = (
                savedSig.calendarId === sig.calendarId &&
                savedSig.singleEvents === sig.singleEvents &&
                savedSig.fields === sig.fields &&
                JSON.stringify(savedSig.privateExtendedProperty) === JSON.stringify(sig.privateExtendedProperty)
            );
            if (!same) {
                console.warn('syncToken 使用時のクエリ条件が初回と一致しません。将来の無効化(410)の原因になり得ます。', { savedSig, current: sig });
            }
        } else if (trySyncToken && !savedSig) {
            // アップグレード導入等で signature 不在のケースを救済
            console.warn('listFilterSignature が存在しません。現在の条件をバックフィル保存します。', sig);
            (this.plugin as any).settings.listFilterSignature = sig;
            try { await (this.plugin as any).saveData((this.plugin as any).settings); } catch {}
        }

        if (trySyncToken) {
            requestParams.syncToken = (this.plugin as any).settings.syncToken;
            console.log(`syncToken による増分取得を試行します。`);
        } else {
            console.log(`管理対象イベントを全件取得します（updatedMin/time 窓は使用しません）。`);
        }

        try {
            let page = 1;
            do {
                console.log(`GCal イベントページ ${page} を取得中...`);
                requestParams.pageToken = nextPageToken;
                const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.eventsListWithRetry(requestParams);

                if (response.data.items) {
                    existingEvents.push(...response.data.items);
                }
                if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken;
                nextPageToken = response.data.nextPageToken ?? undefined;
                page++;
            } while (nextPageToken);

            console.log(`合計 ${existingEvents.length} 件の GCal イベントを取得しました。`);
            // syncToken 保存（増分が有効な場合）
            if (nextSyncToken && settings.useSyncToken) {
                (this.plugin as any).settings.syncToken = nextSyncToken;
                await (this.plugin as any).saveData((this.plugin as any).settings);
                console.log(`syncToken を保存しました。`);
            }
            return existingEvents;
        } catch (e: any) {
            const errorMsg = isGaxiosError(e)
                ? e.response?.data?.error?.message || e.message
                : String(e);
            // syncToken が無効化された場合はフル取得へフォールバック
            if (/Sync token is no longer valid/i.test(errorMsg) || /410/.test(String(e?.response?.status))) {
                console.warn(`syncToken が無効のため、フル取得へフォールバックします。`);
                try {
                    // フォールバック前に状態を完全クリア
                    existingEvents.length = 0;
                    nextPageToken = undefined;
                    nextSyncToken = undefined;

                    // パラメータ／保存トークンのクリア
                    delete requestParams.syncToken;
                    requestParams.showDeleted = false; // フル取得では削除ノイズを避ける
                    requestParams.pageToken = undefined;
                    (this.plugin as any).settings.syncToken = undefined;
                    await (this.plugin as any).saveData((this.plugin as any).settings);

                    // 全件再取得
                    let page = 1;
                    do {
                        console.log(`GCal イベントページ ${page} を取得中...(fallback)`);
                        requestParams.pageToken = nextPageToken;
                        const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.eventsListWithRetry(requestParams);
                    if (response.data.items) existingEvents.push(...response.data.items);
                        if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken;
                        nextPageToken = response.data.nextPageToken ?? undefined;
                        page++;
                    } while (nextPageToken);
                    console.log(`フォールバックで合計 ${existingEvents.length} 件を取得しました。`);
                    // フォールバックでも nextSyncToken を保存して次回から増分に戻す
                    if (nextSyncToken && settings.useSyncToken) {
                        (this.plugin as any).settings.syncToken = nextSyncToken;
                        await (this.plugin as any).saveData((this.plugin as any).settings);
                        console.log(`syncToken を保存しました。(fallback)`);
                    }
                    return existingEvents;
                } catch (e2) {
                    const msg = `syncToken フォールバック取得も失敗: ${String((e2 as any)?.message || e2)}`;
                    console.error(msg);
                    throw new Error(`${errorMsg} / ${msg}`);
                }
            }
            console.error("GCal イベントの取得中に致命的なエラー:", e);
            new Notice(`GCal イベントの取得エラー: ${errorMsg}。同期を中止しました。`, 10_000);
            throw new Error(`GCal イベントの取得に失敗しました: ${errorMsg}`);
        }
    }

    // 軽リトライ付きの events.list 呼び出し（429/5xx 対応）
    private async eventsListWithRetry(params: calendar_v3.Params$Resource$Events$List): Promise<GaxiosResponse<calendar_v3.Schema$Events>> {
        const max = 3;
        let lastError: any = null;
        for (let i = 0; i < max; i++) {
            try {
                const res = await this.plugin.calendar!.events.list(params);
                return res;
            } catch (e: any) {
                lastError = e;
                const status = isGaxiosError(e) ? (e.response?.status ?? 0) : 0;
                const reason = isGaxiosError(e) ? (e.response?.data?.error?.errors?.[0]?.reason ?? '') : '';
                const code   = (e as any)?.code || '';
                const transient = !status || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(code));
                const shouldRetry403 = status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(String(reason));
                if (transient || status === 429 || status >= 500 || shouldRetry403) {
                    const base = Math.min(800 * (2 ** i), 4000);
                    const jitter = Math.floor(Math.random() * 200);
                    const delay = base + jitter;
                    console.warn(`events.list ${status}${reason ? ` (${reason})` : ''}. retry in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw e;
            }
        }
        throw lastError;
    }

    // ---------------------------------------------------------------------
    // Batch API
    // ---------------------------------------------------------------------

    /**
     * 準備されたバッチリクエストを実行します。
     * 404/409/410 は item-level の警告として扱い、致命停止しません。
     */
    async executeBatchRequest(batchRequests: BatchRequestItem[]): Promise<BatchResponseItem[]> {
        // 1) 認証チェックとトークンリフレッシュ（常時呼び出し）
        const tokenRefreshed = await this.plugin.authService.ensureAccessToken();
        if (!tokenRefreshed) {
            throw new Error("バッチリクエストを実行できません: 認証トークンを取得できませんでした。");
        }

        // 0) 空バッチは送らない
        if (!batchRequests || batchRequests.length === 0) {
            console.log('バッチ要求は空。送信をスキップします。');
            return [];
        }

        // 2) multipart/mixed リクエストを組み立て
        const boundary = `batch_${randomBytes(16).toString("hex")}`;
        const batchUrl = "https://www.googleapis.com/batch/calendar/v3";
        let body = "";
        const normalizePath = (p: string) => {
            try {
                if (/^https?:\/\//i.test(p)) {
                    const u = new URL(p);
                    return u.pathname + (u.search || "");
                }
            } catch {}
            return p;
        };

        batchRequests.forEach((req, idx) => {
            body += `--${boundary}\r\n`;
            body += `Content-Type: application/http\r\n`;
            body += `Content-ID: <item-${idx + 1}>\r\n\r\n`;
            // FIX: HTTP/1.1 を明示し、必ずヘッダ終端の空行を入れる
            body += `${req.method} ${normalizePath(req.path)} HTTP/1.1\r\n`;

            // ユーザー定義ヘッダー + 必要に応じて Content-Type
            const headerLines: string[] = [];
            if (req.headers) {
                for (const [k, v] of Object.entries(req.headers)) headerLines.push(`${k}: ${v}`);
            }
            if (req.body) {
                // JSON ボディを送る場合のみ付与
                headerLines.push(`Content-Type: application/json; charset=UTF-8`);
            }
            // 相互運用性向上（明示）
            headerLines.push('Accept: application/json');
            if (headerLines.length > 0) {
                body += headerLines.join("\r\n") + "\r\n";
            }
            body += `\r\n`; // ヘッダ終端

            // ボディ
            if (req.body) {
                body += JSON.stringify(req.body) + `\r\n`;
            }
            body += `\r\n`; // Part 終端の空行
        });
        body += `--${boundary}--\r\n`;

        // OAuth クライアントから Authorization ヘッダーを取得（必要なら自動更新）
        if (!this.plugin.oauth2Client) throw new Error('OAuth クライアント未初期化');
        const authHeaders = await this.plugin.oauth2Client.getRequestHeaders();

        const requestParams: RequestUrlParam = {
            url: batchUrl,
            method: "POST",
            headers: {
                ...authHeaders, // { Authorization: 'Bearer ...' }
                "Content-Type": `multipart/mixed; boundary=${boundary}`,
            },
            body,
            throw: false, // ステータスコードに関わらずレスポンスを取得
        };

        // 3) 送信（429/5xx のトップレベルに軽リトライ）
        const fetchWithRetry = async (): Promise<RequestUrlResponse> => {
            const max = 4;
            for (let i = 0; i < max; i++) {
                try {
                    const res = await requestUrl(requestParams);
                    const ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
                    let reason = '';
                    if (/json/i.test(String(ct))) {
                        try { reason = (JSON.parse(res.text))?.error?.errors?.[0]?.reason ?? ''; } catch {}
                    }
                    const shouldRetry = (
                        res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason))
                    );
                    if (shouldRetry) {
                        const base = Math.min(1600 * (2 ** i), 8000);
                        const jitter = Math.floor(Math.random() * 400);
                        const delay = base + jitter;
                        console.warn(`Batch top-level ${res.status}${reason ? ` (${reason})` : ''}. retry in ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    return res;
                } catch (e: any) {
                    const code = (e?.cause?.code || e?.code || '').toString();
                    const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(code) || !code;
                    if (transient) {
                        const base = Math.min(1600 * (2 ** i), 8000);
                        const jitter = Math.floor(Math.random() * 400);
                        const delay = base + jitter;
                        console.warn(`Batch request transient error ${code || 'UNKNOWN'}. retry in ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    throw e;
                }
            }
            return await requestUrl(requestParams);
        };
        try {
            console.log(`${batchRequests.length} 件の操作を含むバッチリクエストを送信中...`);
            const res = await fetchWithRetry();
            const responseText = res.text;

            // 4) multipart の boundary は Content-Type ヘッダ優先で検出（本文スキャンはフォールバック）
            const ct = res.headers['content-type'] || res.headers['Content-Type'];
            const results = this.parseBatchResponse(responseText, ct as string | undefined);

            // 404/409/410 は item-level の警告として集計
            const ignorable = new Set([404, 409, 410, 412]);
            const ignorableCount = results.filter(r => ignorable.has(r.status)).length;
            if (ignorableCount > 0) {
                const counts = results.reduce((acc, r) => {
                    if (ignorable.has(r.status)) acc[r.status] = (acc[r.status] || 0) + 1;
                    return acc;
                }, {} as Record<number, number>);
                const summary = Object.entries(counts).map(([s, c]) => `${c}件の ${s}`).join(", ");
                console.warn(`バッチ応答に無視可能なエラーが含まれています: ${summary}。`);
            }

            // レスポンスが空 or パース不能だった場合は致命エラーとして扱う
            if (results.length === 0) {
                // 可能ならトップレベル JSON を読み取って詳細表示
                try {
                    const err = JSON.parse(responseText);
                    const code = err?.error?.code;
                    const msg  = err?.error?.message || "Unknown error";
                    throw new Error(`Batch response parse failed: ${code ?? "N/A"} ${msg}`);
                } catch {
                    throw new Error("Batch response parse failed: No parts found.");
                }
            }

            return results;
        } catch (error) {
            console.error("バッチリクエストの実行または処理中にエラー:", error);
            if (error instanceof Error) {
                const msg = error.toString();
                if (/401|invalid_grant|invalid credential/i.test(msg)) {
                    new Notice("同期中の認証エラー。再認証を試みてください。", 10_000);
                    await this.plugin.persistTokens(null);
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
     * レスポンス本文から boundary を自動検出し、multipart をパースします。
     * 返り値は part ごとの HTTP ステータスと JSON ボディ（可能な範囲で）です。
     */
    private parseBatchResponse(responseText: string, contentType?: string): BatchResponseItem[] {
        const results: BatchResponseItem[] = [];

        // FIX: レスポンス側 boundary を Content-Type から優先抽出（なければ本文から推定）
        let boundary = this.detectBoundaryFromContentType(contentType);
        if (!boundary) boundary = this.detectResponseBoundary(responseText);
        if (!boundary) {
            console.warn("レスポンスの boundary を検出できませんでした。");
            return results;
        }

        const delimiter = `--${boundary}`;
        const endDelimiter = `--${boundary}--`;

        // 前後のプリンブル/エピローグを考慮し、delimiter で分解
        const parts = responseText
            .split(delimiter)
            .map(p => p.trim())
            .filter(p => p && p !== '--' && p !== endDelimiter);

        for (const rawPart of parts) {
            const cleaned = rawPart.replace(/^\r?\n|\r?\n$/g, "");
            const parsed = this.parseSingleBatchPart(cleaned);
            if (parsed) {
                results.push(parsed);
            } else {
                results.push({ status: 500, body: { error: { message: "Failed to parse batch response part." } } });
            }
        }

        console.log(`${results.length} 件のバッチ応答アイテムを抽出しました。`);
        return results;
    }

    private detectBoundaryFromContentType(ct?: string): string | null {
        if (!ct) return null;
        const m = /boundary="?([^";]+)"?/i.exec(ct);
        return m?.[1] ?? null;
    }

    // FIX: レスポンス本文から最初の boundary トークンを推定
    private detectResponseBoundary(text: string): string | null {
        // 典型例: `--batch_ABCDEF123\r\n` で開始（RFC2046 準拠のトークン）
        // CRLF あり／なし双方に耐性を持たせる
        const token = "[A-Za-z0-9'()+_,.\-]+";
        const m = text.match(new RegExp(`(?:^|\\r?\\n)--(${token})\\r?\\n`));
        if (m && m[1]) return m[1];

        // 念のため閉じ区切りのパターンも試す
        const m2 = text.match(new RegExp(`--(${token})--\\r?\\n`));
        if (m2 && m2[1]) return m2[1];

        return null;
    }

    /**
     * 個別のバッチ応答パートをパースします。
     */
    private parseSingleBatchPart(partText: string): BatchResponseItem | null {
        // 各 part は自前ヘッダの後に `HTTP/1.1 xxx` から始まる HTTP メッセージが続く
        const lines = partText.split(/\r?\n/);

        // `HTTP/` 行を探す
        // HTTP/1.1 だけでなく HTTP/2 形式にも耐性を持たせる
        const statusLineIdx = lines.findIndex(l => /^HTTP\/\d(?:\.\d+)?\s+\d+/.test(l));
        if (statusLineIdx === -1) {
            console.warn("バッチパート内で HTTP ステータス行が見つかりません:", lines.slice(0, 6).join("\n"));
            return null;
        }

        // Content-ID をパート先頭ヘッダから抽出（存在する場合）
        let contentId: string | undefined = undefined;
        for (let i = 0; i < statusLineIdx; i++) {
            const l = lines[i];
            const m = /^Content-ID:\s*<([^>]+)>/i.exec(l);
            if (m) { contentId = m[1]; break; }
        }

        // HTTP ヘッダ終端（空行）を探す（statusLine 以降）
        let headerEndIdx = lines.findIndex((l, idx) => idx > statusLineIdx && l.trim() === "");
        if (headerEndIdx === -1) {
            // 204 No Content 等でボディが無い場合、空行が省略されることがある。
            // その場合はパート末尾をヘッダ終端と見なし、ボディ無しで成功として扱う。
            headerEndIdx = lines.length - 1;
        }

        // ステータス
        const statusLine = lines[statusLineIdx];
        const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d+)?\s+(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

        // ボディ（空のこともある）
        const bodyRaw = headerEndIdx + 1 < lines.length ? lines.slice(headerEndIdx + 1).join("\n").trim() : "";
        let bodyJson: any = undefined;
        if (bodyRaw) {
            try {
                bodyJson = JSON.parse(bodyRaw);
            } catch {
                // JSON でなければ切り詰めて保持
                bodyJson = { message: bodyRaw.slice(0, 500) + (bodyRaw.length > 500 ? "…" : "") };
            }
        }

        return { status, body: bodyJson, contentId };
    }
}
