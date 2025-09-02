import { Notice } from 'obsidian';
import { BatchRequestItem, BatchResponseItem, GoogleCalendarTasksSyncSettings } from './types';
import { logger } from './logger';

export class BatchProcessor {
    // Google Calendar JSON Batch は API ごとに上限が異なるため、
    // 固定 50 をやめ、設定の maxBatchPerHttp をハード上限として使用する。
    private readonly BATCH_SIZE: number;

    constructor(private settings: GoogleCalendarTasksSyncSettings) {
        const hard = Number(this.settings.maxBatchPerHttp ?? 50);
        this.BATCH_SIZE = Math.max(1, Math.min(1000, isNaN(hard) ? 50 : hard));
    }

    async executeBatches(
        batchRequests: BatchRequestItem[],
        executeBatch: (batch: BatchRequestItem[], signal?: AbortSignal) => Promise<BatchResponseItem[]>,
        signal?: AbortSignal
    ): Promise<{
        results: BatchResponseItem[];
        created: number;
        updated: number;
        deleted: number;
        errors: number;
        skipped: number;
    }> {
        let allResults: BatchResponseItem[] = [];
        let created = 0, updated = 0, deleted = 0, errors = 0, skipped = 0;

        if (batchRequests.length === 0) {
            if (this.settings.showNotices) {
                new Notice('変更なし。', 2000);
            }
            return { results: [], created, updated, deleted, errors, skipped };
        }

        if (this.settings.showNotices) new Notice('Google に変更を送信中...', 3000);
        logger.time('BatchProcessor: Execute All Batches');
        try {
            // --- 並列 + AIMD（加算増加・乗算減少）制御 ---
            const hardCap = this.BATCH_SIZE; // HTTP 1 本あたりの上限
            const minUnit = Math.max(1, Math.min(hardCap, this.settings.minDesiredBatchSize ?? 5));
            let unit = Math.min(hardCap, Math.max(minUnit, this.settings.desiredBatchSize ?? 50)); // 投下単位
            let inFlight = Math.max(1, this.settings.maxInFlightBatches ?? 2);              // 同時本数
            const step = Math.max(1, Math.floor(unit * 0.2));                                // 成功時の増分（+20%）
            const sla = this.settings.latencySLAms ?? 1500;                                  // p95 SLA
            const cooldown = this.settings.rateErrorCooldownMs ?? 1000;                      // レート時の冷却
            const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
            const clampUnit = (v: number) => Math.max(minUnit, Math.min(hardCap, v));

            let idx = 0;
            console.log(`${batchRequests.length} 件を開始 — HTTP上限/本:${hardCap}, 初期単位:${unit}, 初期並列:${inFlight}`);

            const mapByContentId = (results: BatchResponseItem[], chunk: BatchRequestItem[]) => {
                const out: BatchResponseItem[] = new Array(chunk.length);
                for (let j = 0; j < results.length; j++) {
                    const cid = results[j]?.contentId;
                    if (cid && /^item-\d+$/.test(cid)) {
                        const pos = Number(cid.split('-')[1]) - 1;
                        if (pos >= 0 && pos < chunk.length) { out[pos] = results[j]; continue; }
                    }
                    out[j] = results[j];
                }
                return out;
            };

            const padResultsIfShort = (results: BatchResponseItem[], expected: number) => {
                if (results.length >= expected) return results;
                const missing = expected - results.length;
                console.warn(`Batch results short by ${missing} item(s). Padding with 500s.`);
                return results.concat(Array.from({ length: missing }, () => ({ status: 500, body: { error: { message: 'Missing response' } } })));
            };

            while (idx < batchRequests.length) {
                if (signal?.aborted) throw new Error('AbortError');

                // 今波で投下する並列チャンクを構築
                const chunks: BatchRequestItem[][] = [];
                for (let k = 0; k < inFlight && idx < batchRequests.length; k++) {
                    const next = batchRequests.slice(idx, Math.min(idx + unit, batchRequests.length));
                    if (next.length > 0) chunks.push(next);
                    idx += unit;
                }

                const waveLatencies: number[] = [];
                let hadRateIssues = false;

                const settled = await Promise.allSettled(
                    chunks.map(async (chunk) => {
                        try {
                            const t0 = performance.now();
                            const raw = await executeBatch(chunk, signal);
                            const t1 = performance.now();
                            const latency = t1 - t0;
                            waveLatencies.push(latency);

                            let out = mapByContentId(raw, chunk);
                            out = padResultsIfShort(out, chunk.length);
                            if (out.length > chunk.length) out.length = chunk.length; // 過剰レス保険

                            allResults.push(...out);
                            const agg = this.processBatchResults(out, chunk);
                            created += agg.created; updated += agg.updated; deleted += agg.deleted; errors += agg.errors; skipped += agg.skipped;

                            // レート/一時エラーのシグナル検出（403のreasonも考慮）
                            const isRatey = (r?: BatchResponseItem) => {
                                if (!r) return false;
                                if (r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503) return true;
                                if (r.status === 403) {
                                    const reason = r.body?.error?.errors?.[0]?.reason || r.body?.error?.status || '';
                                    return /rateLimitExceeded|userRateLimitExceeded/i.test(String(reason));
                                }
                                return false;
                            };
                            if (out.some(isRatey)) hadRateIssues = true;
                        } catch (e: any) {
                            // チャンク単位の失敗は 500 で合成し計上
                            console.error('HTTP バッチ失敗:', e?.message || e);
                            hadRateIssues = true;
                            const synthetic: BatchResponseItem[] = Array.from({ length: chunk.length }, () => ({ status: 500, body: { error: { message: e?.message || 'Batch failed' } } }));
                            allResults.push(...synthetic);
                            const agg = this.processBatchResults(synthetic, chunk);
                            created += agg.created; updated += agg.updated; deleted += agg.deleted; errors += agg.errors; skipped += agg.skipped;
                        }
                    })
                );

                // 並列のうち致命失敗（settled: rejected）は上の catch で処理済みだが念のためログ
                settled.forEach(s => { if (s.status === 'rejected') console.error('並列実行失敗:', s.reason); });

                // p95 計算
                const sorted = waveLatencies.slice().sort((a,b)=>a-b);
                const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0;

                // AIMD 調整
                if (hadRateIssues || p95 > sla) {
                    unit = clampUnit(Math.floor(unit / 2));
                    inFlight = Math.max(1, Math.floor(inFlight / 2));
                    if (cooldown > 0) await sleep(cooldown);
                } else {
                    unit = clampUnit(unit + step);
                    inFlight = Math.min(Math.max(1, this.settings.maxInFlightBatches ?? 2), inFlight + 1);
                }

                // ジッタ付きインターバッチ遅延（次の波がある場合）
                if (idx < batchRequests.length && (this.settings.interBatchDelay ?? 0) > 0) {
                    const base = this.settings.interBatchDelay!;
                    const jittered = Math.floor(base * (Math.random() * 0.5 + 0.75));
                    await sleep(jittered);
                }
            }

            return { results: allResults, created, updated, deleted, errors, skipped };
        } finally {
            logger.timeEnd('BatchProcessor: Execute All Batches');
        }
    }

    // 旧 handleBatchError は並列+AIMD 化により呼び出し箇所が無くなったため削除

    private processBatchResults(
        results: BatchResponseItem[],
        requests: BatchRequestItem[]
    ): { created: number; updated: number; deleted: number; errors: number; skipped: number } {
        let created = 0, updated = 0, deleted = 0, errors = 0, skipped = 0;

        results.forEach((res, i) => {
            const req = requests[i];
            const op = req.operationType;
            const summary = req.body?.summary || `(Op:${op},GCalID:${req.originalGcalId})`;

            if (res.status >= 200 && res.status < 300) {
                switch(op) {
                    case 'insert': created++; break;
                    case 'update': case 'patch': updated++; break;
                    case 'delete': deleted++; break;
                }
                console.log(`${this.getOperationName(op, req)}: ${summary}`);
            } else {
                if ((op==='delete' || op==='patch' || op==='update') && (res.status===404||res.status===410||res.status===412)) {
                    skipped++;
                    const why = res.status===412 ? '競合(412)' : 'リソース未存在';
                    console.warn(`${why}: ${req.originalGcalId}`);
                } else if (op==='insert' && res.status===409) {
                    skipped++;
                    console.warn(`挿入スキップ(409): 既存IDまたは重複作成 ${req.obsidianTaskId}`);
                } else {
                    errors++;
                    const msg = res.body?.error?.message || `Status ${res.status}`;
                    console.error(`失敗: ${summary}: ${msg}`);
                }
            }
        });

        return { created, updated, deleted, errors, skipped };
    }

    private getOperationName(op?: string, req?: BatchRequestItem): string {
        const low = op?.toLowerCase();
        if (low === 'patch' && req?.body && req.body.status === 'cancelled') return 'キャンセル';
        switch(low) {
            case 'insert': return '作成';
            case 'update': return '更新';
            case 'patch': return '更新';
            case 'delete': return '削除';
            default: return op || '不明な操作';
        }
    }
}
