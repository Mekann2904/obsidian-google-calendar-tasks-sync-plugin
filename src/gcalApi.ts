import { Notice, requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { calendar_v3 } from 'googleapis';
import { randomBytes } from 'crypto';
import GoogleCalendarTasksSyncPlugin from './main';
import { GoogleCalendarTasksSyncSettings, BatchRequestItem, BatchResponseItem } from './types';
import { isGaxiosError } from './utils';
import { GaxiosResponse } from 'gaxios';

function normalizeResponseContentId(cid?: string): string | undefined {
    if (!cid) return cid;
    // <response-item-3> → item-3
    let m = cid.match(/(?:^|<)response-(item-\d+)(?:>|$)/i);
    if (m) return m[1];
    // <item-3> or item-3 → item-3
    m = cid.match(/(?:^|<)(item-\d+)(?:>|$)/i);
    if (m) return m[1];
    return cid; // それ以外はそのまま返す（順序フォールバックが効く）
}

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

        // 重要: デフォルトは全件取得。一方で設定が有効でsyncTokenがある場合は増分取得を試行（失敗時は全件へフォールバック）。
        const trySyncToken = !!settings.useSyncToken && !!this.plugin.settings?.syncToken;
        const requestParams: calendar_v3.Params$Resource$Events$List & { quotaUser?: string } = {
            calendarId: settings.calendarId,
            ...(settings as any).quotaUser ? { quotaUser: (settings as any).quotaUser } : {},
            privateExtendedProperty: ["isGcalSync=true", "appId=obsidian-gcal-tasks"],
            showDeleted: trySyncToken ? true : false,
            maxResults: 2500,
            singleEvents: false,
            fields: 'items(id,summary,description,etag,status,updated,start,end,recurrence,reminders,extendedProperties,recurringEventId,originalStartTime),nextPageToken,nextSyncToken',
        };

        const useSync = await this.validateSignature(requestParams, settings);
        if (useSync) {
            requestParams.syncToken = this.plugin.settings.syncToken;
            console.log(`syncToken による増分取得を試行します。`);
        } else {
            delete (requestParams as any).syncToken;
            console.log(`管理対象イベントを全件取得します（updatedMin/time 窓は使用しません）。`);
        }

        try {
            const { events, nextSyncToken } = await this.iteratePages(requestParams);
            console.log(`合計 ${events.length} 件の GCal イベントを取得しました。`);
            if (nextSyncToken && settings.useSyncToken) {
                this.plugin.settings.syncToken = nextSyncToken;
                await this.plugin.saveData(this.plugin.settings);
                console.log(`syncToken を保存しました。`);
            }
            return events;
        } catch (e: any) {
            const errorMsg = isGaxiosError(e)
                ? e.response?.data?.error?.message || e.message
                : String(e);
            if (/Sync token is no longer valid/i.test(errorMsg) || /410/.test(String(e?.response?.status))) {
                console.warn(`syncToken が無効のため、フル取得へフォールバックします。`);
                try {
                    return await this.fallbackFullFetch(requestParams, settings);
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

    // syncToken 条件の自己監査とリセット
    private async validateSignature(
        requestParams: calendar_v3.Params$Resource$Events$List & { quotaUser?: string },
        settings: GoogleCalendarTasksSyncSettings,
    ): Promise<boolean> {
        const trySyncToken = !!settings.useSyncToken && !!this.plugin.settings?.syncToken;
        const sig = {
            calendarId: requestParams.calendarId!,
            privateExtendedProperty: (requestParams.privateExtendedProperty || []).slice().sort(),
            singleEvents: !!requestParams.singleEvents,
            fields: requestParams.fields || '',
            quotaUser: (requestParams as any).quotaUser || '',
        };
        const savedSig = this.plugin.settings?.listFilterSignature as typeof sig | undefined;
        let signatureReset = false;
        const prevSig = savedSig;
        if (prevSig && prevSig.calendarId !== sig.calendarId) {
            console.warn('calendarId が変更されました。syncToken と署名をリセットします。', { before: prevSig.calendarId, after: sig.calendarId });
            this.plugin.settings.syncToken = undefined;
            this.plugin.settings.listFilterSignature = sig;
            try { await this.plugin.saveData(this.plugin.settings); } catch {}
            delete (requestParams as any).syncToken;
            requestParams.showDeleted = false;
            signatureReset = true;
        }

        if (!trySyncToken && !savedSig) {
            this.plugin.settings.listFilterSignature = sig;
            try { await this.plugin.saveData(this.plugin.settings); } catch {}
        } else if (!signatureReset && trySyncToken && savedSig) {
            const same = (
                savedSig.calendarId === sig.calendarId &&
                savedSig.singleEvents === sig.singleEvents &&
                savedSig.fields === sig.fields &&
                ((savedSig as any).quotaUser ?? '') === (sig.quotaUser ?? '') &&
                JSON.stringify(savedSig.privateExtendedProperty) === JSON.stringify(sig.privateExtendedProperty)
            );
            if (!same) {
                console.warn('syncToken 条件ミスマッチ→フル切替', {
                    savedSig,
                    current: sig,
                    before: { hasSync: !!this.plugin.settings?.syncToken, showDeleted: requestParams.showDeleted },
                });
                this.plugin.settings.syncToken = undefined;
                try { await this.plugin.saveData(this.plugin.settings); } catch {}
                delete (requestParams as any).syncToken;
                requestParams.showDeleted = false;
                console.warn('切替後状態', { after: { hasSync: false, showDeleted: requestParams.showDeleted } });
            }
        } else if (!signatureReset && trySyncToken && !savedSig) {
            console.warn('listFilterSignature が存在しません。現在の条件をバックフィル保存します。', sig);
            this.plugin.settings.listFilterSignature = sig;
            try { await this.plugin.saveData(this.plugin.settings); } catch {}
        }

        const useSync = !!settings.useSyncToken && !!this.plugin.settings?.syncToken;
        requestParams.showDeleted = useSync;
        return useSync;
    }

    // ページング取得を共通化
    private async iteratePages(
        params: calendar_v3.Params$Resource$Events$List,
        label = '',
    ): Promise<{ events: calendar_v3.Schema$Event[]; nextSyncToken?: string }> {
        const events: calendar_v3.Schema$Event[] = [];
        let nextPageToken: string | undefined = undefined;
        let nextSyncToken: string | undefined = undefined;
        let page = 1;
        do {
            console.log(`GCal イベントページ ${page} を取得中...${label}`);
            params.pageToken = nextPageToken;
            const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.eventsListWithRetry({ ...params });
            if (response.data.items) events.push(...response.data.items);
            if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken;
            nextPageToken = response.data.nextPageToken ?? undefined;
            page++;
        } while (nextPageToken);
        return { events, nextSyncToken };
    }

    // syncToken 無効時のフル取得フォールバック
    private async fallbackFullFetch(
        requestParams: calendar_v3.Params$Resource$Events$List & { quotaUser?: string },
        settings: GoogleCalendarTasksSyncSettings,
    ): Promise<calendar_v3.Schema$Event[]> {
        delete requestParams.syncToken;
        requestParams.showDeleted = false;
        requestParams.pageToken = undefined;
        this.plugin.settings.syncToken = undefined;
        await this.plugin.saveData(this.plugin.settings);

        const { events, nextSyncToken } = await this.iteratePages(requestParams, '(fallback)');
        console.log(`フォールバックで合計 ${events.length} 件を取得しました。`);
        if (nextSyncToken && settings.useSyncToken) {
            this.plugin.settings.syncToken = nextSyncToken;
            await this.plugin.saveData(this.plugin.settings);
            console.log(`syncToken を保存しました。(fallback)`);
        }
        return events;
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
                const respErr = isGaxiosError(e) ? e.response?.data?.error : undefined;
                const reason  = respErr?.errors?.[0]?.reason ?? '';
                const statusText = respErr?.status ?? '';
                const code   = (e as any)?.code || '';
                const transient = !status || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(code));
                const shouldRetry403 = status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(String(reason));
                const isResourceExhausted = /RESOURCE_EXHAUSTED/i.test(String(statusText));
                if (transient || status === 429 || status >= 500 || shouldRetry403 || isResourceExhausted) {
                    const base = Math.min(800 * (2 ** i), 4000);
                    const jitter = Math.floor(Math.random() * 200);
                    let delay = base + jitter;
                    const ra = isGaxiosError(e) ? ((e.response?.headers?.['retry-after'] as any) || (e.response?.headers as any)?.['Retry-After']) as (string | undefined) : undefined;
                    if (ra) {
                        const secs = /^\d+$/.test(ra) ? parseInt(ra, 10)
                            : (!Number.isNaN(Date.parse(ra)) ? Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) : 0);
                        if (secs > 0) delay = Math.max(delay, secs * 1000);
                    }
                    const msg = (respErr as any)?.message || '';
                    console.warn(`events.list ${status}${reason ? ` (${reason})` : ''}${isResourceExhausted ? ' (RESOURCE_EXHAUSTED)' : ''}${msg ? `: ${msg}` : ''}. retry in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw e;
            }
        }
        // 文脈を付けてスロー
        const code = isGaxiosError(lastError) ? (lastError.response?.status ?? '') : ((lastError as any)?.code || '');
        throw new Error(`events.list failed after ${max} attempts: ${String(code || lastError)}`);
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
            body += `Content-ID: <item-${idx + 1}>\r\n`;
            body += `Content-Transfer-Encoding: binary\r\n\r\n`;
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
                    let statusText = '';
                    if (/json/i.test(String(ct))) {
                        try {
                            const j = JSON.parse(res.text);
                            reason = j?.error?.errors?.[0]?.reason ?? '';
                            statusText = j?.error?.status ?? '';
                        } catch {}
                    }
                    const shouldRetry = (
                        res.status === 429 ||
                        res.status >= 500 ||
                        (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) ||
                        /RESOURCE_EXHAUSTED/i.test(statusText)
                    );
                    if (shouldRetry) {
                        const base = Math.min(1600 * (2 ** i), 8000);
                        const jitter = Math.floor(Math.random() * 400);
                        let delay = base + jitter;
                        const ra = (res.headers['retry-after'] as string) || (res.headers['Retry-After'] as string);
                        if (ra) {
                            const secs = /^\d+$/.test(ra) ? parseInt(ra, 10)
                                : (!Number.isNaN(Date.parse(ra)) ? Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) : 0);
                            if (secs > 0) delay = Math.max(delay, secs * 1000);
                        }
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

        // 念のため Content-ID の item-N に従って昇順に整列
        results.sort((a, b) => {
            const getNum = (cid?: string) => {
                if (!cid) return Number.MAX_SAFE_INTEGER;
                const m = cid.match(/(?:^|<)?(?:response-)?item-(\d+)(?:>|$)/i);
                return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
            };
            return getNum(a.contentId) - getNum(b.contentId);
        });

        console.log(`${results.length} 件のバッチ応答アイテムを抽出しました。`);
        return results;
    }

    private detectBoundaryFromContentType(ct?: string): string | null {
        if (!ct) return null;
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
        return (m?.[1] || m?.[2] || null);
    }

    // FIX: レスポンス本文から最初の boundary トークンを推定
    private detectResponseBoundary(text: string): string | null {
        // 典型例: `--batch_ABCDEF123\r\n` で開始（RFC2046 準拠のトークン）
        // CRLF あり／なし双方に耐性を持たせる
        const token = "[-A-Za-z0-9'()+_.,=/:]+";
        const m = text.match(new RegExp(`(?:^|\\r?\\n)--(${token})\\r?\\n`));
        if (m && m[1]) return m[1];

        // 念のため閉じ区切りのパターンも試す
        const m2 = text.match(new RegExp(`--(${token})--(?:\\r?\\n|$)`));
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

        // ★ 正規化を追加 ★
        contentId = normalizeResponseContentId(contentId);

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

        // パートヘッダ（小文字キーで正規化）
        const headers: Record<string, string> = {};
        for (let i = statusLineIdx + 1; i < headerEndIdx; i++) {
            const mh = /^([^:]+):\s*(.*)$/.exec(lines[i]);
            if (mh) headers[mh[1].toLowerCase()] = mh[2];
        }

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

        return { status, body: bodyJson, contentId, headers };
    }
}
