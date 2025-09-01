import { Notice } from 'obsidian';
import { BatchRequestItem, BatchResponseItem, GoogleCalendarTasksSyncSettings } from './types';

export class BatchProcessor {
    // Google Calendar API のバッチリクエストは、公式ドキュメント上、最大50リクエストまで。
    // See: https://developers.google.com/calendar/api/guides/batch
    private readonly BATCH_SIZE = 50;

    constructor(private settings: GoogleCalendarTasksSyncSettings) {}

    async executeBatches(
        batchRequests: BatchRequestItem[],
        executeBatch: (batch: BatchRequestItem[]) => Promise<BatchResponseItem[]>
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
                const results = await executeBatch(batchChunk);
                console.timeEnd(`BatchProcessor: Execute Batch ${batchIndex}`);
                allResults.push(...results);

                const { created: c, updated: u, deleted: d, errors: e, skipped: s } = 
                    this.processBatchResults(results, batchChunk);
                created += c; updated += u; deleted += d; errors += e; skipped += s;
            } catch (e: any) {
                errors += this.handleBatchError(e, batchChunk, allResults);
            }

            // FIX: 次のバッチがある場合、レート制限回避のために遅延を設ける
            if (i + this.BATCH_SIZE < batchRequests.length && this.settings.interBatchDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, this.settings.interBatchDelay));
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
        let errorCount = 0;
        if (error.status === 410) {
            console.warn(`バッチが 410 Gone: リソースは既に削除済み`);
            for (const req of batchChunk) {
                if (req.operationType === 'delete') {
                    // 削除済みとして扱う
                } else if (req.operationType === 'patch' || req.operationType === 'update') {
                    // スキップとして扱う
                } else {
                    errorCount++;
                }
                allResults.push({ status: 200, body: {} });
            }
            return errorCount;
        } else {
            console.error(`バッチエラー:`, error);
            const fake = batchChunk.map(() => ({ 
                status: 500, 
                body: { error: { message: error.message || '不明なエラー' } } 
            }));
            allResults.push(...fake);
            if (this.settings.showNotices) {
                new Notice(`バッチでエラー発生。コンソールを確認してください。`, 10000);
            }
            return batchChunk.length;
        }
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
