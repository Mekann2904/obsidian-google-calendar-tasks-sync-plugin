import { Notice } from 'obsidian';
import { BatchRequestItem, BatchResponseItem, GoogleCalendarTasksSyncSettings } from './types';

export class BatchProcessor {
    // Google Calendar API のバッチリクエストは、公式ドキュメント上、最大50リクエストまで。
    // See: https://developers.google.com/calendar/api/guides/batch
    private readonly BATCH_SIZE: number;

    constructor(private settings: GoogleCalendarTasksSyncSettings) {
        const sz = Number(this.settings.batchSize ?? 50);
        this.BATCH_SIZE = Math.max(1, Math.min(50, isNaN(sz) ? 50 : sz));
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
        const totalBatches = Math.ceil(batchRequests.length / this.BATCH_SIZE);

        if (batchRequests.length === 0) {
            if (this.settings.showNotices) {
                new Notice('変更なし。', 2000);
            }
            return { results: [], created, updated, deleted, errors, skipped };
        }

        console.log(`${batchRequests.length} 件を ${totalBatches} バッチで実行`);
        if (this.settings.showNotices) {
            new Notice('Google に変更を送信中...', 3000);
        }
        console.time("BatchProcessor: Execute All Batches");

        for (let i = 0; i < batchRequests.length; i += this.BATCH_SIZE) {
            const batchChunk = batchRequests.slice(i, i + this.BATCH_SIZE);
            const batchIndex = Math.floor(i / this.BATCH_SIZE) + 1;
            console.log(`バッチ ${batchIndex}/${totalBatches} 実行`);
            if (this.settings.showNotices) {
                new Notice(`バッチ ${batchIndex}/${totalBatches} を送信中...`, 2000);
            }

            try {
                console.time(`BatchProcessor: Execute Batch ${batchIndex}`);
                const raw = await executeBatch(batchChunk, signal);
                console.timeEnd(`BatchProcessor: Execute Batch ${batchIndex}`);
                const mapByContentId = (results: BatchResponseItem[], chunk: BatchRequestItem[]) => {
                    const out: BatchResponseItem[] = new Array(chunk.length);
                    for (let j = 0; j < results.length; j++) {
                        const cid = results[j]?.contentId;
                        if (cid && /^item-\d+$/.test(cid)) {
                            const idx = Number(cid.split('-')[1]) - 1;
                            if (idx >= 0 && idx < chunk.length) {
                                out[idx] = results[j];
                                continue;
                            }
                        }
                        out[j] = results[j];
                    }
                    return out;
                };

                const padResultsIfShort = (results: BatchResponseItem[], expected: number) => {
                    if (results.length >= expected) return results;
                    const missing = expected - results.length;
                    console.warn(`Batch results short by ${missing} item(s). Padding with 500s.`);
                    return results.concat(
                        Array.from({ length: missing }, () => ({ status: 500, body: { error: { message: 'Missing response' } } }))
                    );
                };

                const mapped = mapByContentId(raw, batchChunk);
                const results = padResultsIfShort(mapped, batchChunk.length);
                allResults.push(...results);

                const { created: c, updated: u, deleted: d, errors: e, skipped: s } = 
                    this.processBatchResults(results, batchChunk);
                created += c; updated += u; deleted += d; errors += e; skipped += s;
            } catch (e: any) {
                errors += this.handleBatchError(e, batchChunk, allResults);
            }

            // 次のバッチがある場合、レート制限回避のために遅延（±25% ジッタ）
            if (i + this.BATCH_SIZE < batchRequests.length && (this.settings.interBatchDelay ?? 0) > 0) {
                const base = this.settings.interBatchDelay!;
                const jittered = Math.floor(base * (Math.random() * 0.5 + 0.75));
                await new Promise(resolve => setTimeout(resolve, jittered));
            }
        }

        console.timeEnd("BatchProcessor: Execute All Batches");
        return { results: allResults, created, updated, deleted, errors, skipped };
    }

    private handleBatchError(
        error: any,
        batchChunk: BatchRequestItem[],
        allResults: BatchResponseItem[]
    ): number {
        // ネットワークや一括失敗など: ここで 200 を作らない
        console.error(`バッチエラー:`, error);
        let errorCount = 0;
        const isGone = error?.status === 410;

        for (const req of batchChunk) {
            if (isGone) {
                if (req.operationType === 'delete' || req.operationType === 'patch' || req.operationType === 'update') {
                    // 上位でスキップ扱い/後続フォールバックできるよう 404/410 を返す（410 を採用）
                    allResults.push({ status: 410, body: { error: { message: 'Gone' } } });
                } else {
                    // insert は恒久失敗寄りとしてカウント
                    allResults.push({ status: 500, body: { error: { message: 'Batch Gone' } } });
                    errorCount++;
                }
            } else {
                // 不明な失敗は 500 相当
                allResults.push({
                    status: 500,
                    body: { error: { message: error?.message || '不明なエラー' } }
                });
                errorCount++;
            }
        }

        if (this.settings.showNotices) {
            new Notice(`バッチでエラー発生。コンソールを確認してください。`, 10_000);
        }
        return errorCount;
    }

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
