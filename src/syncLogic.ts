import { Notice } from 'obsidian';
import { ErrorHandler, DateUtils } from './commonUtils';
import { calendar_v3 } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';
import { ObsidianTask, GoogleCalendarEventInput, BatchRequestItem, BatchResponseItem, BatchResult, ErrorLog } from './types';
import { createHash } from 'crypto';
import { BatchProcessor } from './batchProcessor';
import moment from 'moment';
import { GCalMapper } from './gcalMapper';

export class SyncLogic {
    private plugin: GoogleCalendarTasksSyncPlugin;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
        this.errorLogs = [];
    }

    /**
     * Obsidian タスクと Google Calendar イベント間の同期を実行します。
     * @param {GoogleCalendarTasksSyncSettings} settings 同期実行時の設定スナップショット
     * @param {object} [options] - 同期オプション
     * @param {boolean} [options.force=false] - true の場合、リモートをローカルの状態で上書きする強制同期を実行します。
     */
    private errorLogs: ErrorLog[];
    private retryCount = 0;
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY_MS = 1000;

    async runSync(settings: GoogleCalendarTasksSyncSettings, options: { force?: boolean } = {}): Promise<void> {
        const { force = false } = options;
        if (this.plugin.isCurrentlySyncing()) {
            console.warn("同期はスキップされました: 既に進行中です。");
            new Notice("同期は既に進行中です。");
            return;
        }
        this.plugin.setSyncing(true);
        this.errorLogs = [];
        this.retryCount = 0;
        const syncStartTime = moment();

        // --- FIX: ローカルインスタンスの生成 ---
        const gcalMapper = new GCalMapper(this.plugin.app, settings);
        const batchProcessor = new BatchProcessor(settings.calendarId, settings);

        // FIX: 強制同期の場合は lastSyncTime をクリアしてフル同期を実行
        if (force) {
            settings.lastSyncTime = undefined;
        }

        // 設定と認証の確認
        if (!settings.tokens || !settings.calendarId) {
            ErrorHandler.showError('同期失敗: 認証またはカレンダー ID が設定されていません。');
            this.plugin.setSyncing(false);
            return;
        }
        const tokenEnsured = await this.plugin.authService.ensureAccessToken();
        if (!tokenEnsured) {
            new Notice('同期中止: 認証トークンを取得できませんでした。', 7000);
            console.error('同期中止: アクセストークン確保失敗。');
            this.plugin.setSyncing(false);
            return;
        }
        if (!this.plugin.calendar) {
            new Notice('同期中止: Calendar API クライアント初期化失敗。', 7000);
            console.error('同期中止: Calendar API クライアント初期化失敗。');
            this.plugin.setSyncing(false);
            return;
        }

        console.log(`カレンダー ID: ${settings.calendarId} と同期を開始 (強制: ${force})`);
        const isManualSync = !settings.autoSync || force;
        if (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) {
            new Notice(force ? '強制同期を開始しました...' : '同期を開始しました...', 3000);
        }

        let createdCount = 0, updatedCount = 0, deletedCount = 0, skippedCount = 0, errorCount = 0;
        const batchRequests: BatchRequestItem[] = [];
        // FIX: taskMap は settings スナップショットから取得
        const taskMap = force ? {} : { ...settings.taskMap };
        let existingEvents: calendar_v3.Schema$Event[] = [];
        let googleEventMap = new Map<string, calendar_v3.Schema$Event>();

        try {
            // 1. Obsidian タスク取得
            if (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) {
                new Notice('Obsidian タスクを取得中...', 2000);
            }
            console.time("Sync: Fetch Obsidian Tasks");
            const obsidianTasks = await this.plugin.taskParser.getObsidianTasks();
            console.timeEnd("Sync: Fetch Obsidian Tasks");

            // 2. Google Calendar イベント取得
            if (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) {
                new Notice('GCal イベントを取得中...', 2000);
            }
            console.time("Sync: Fetch GCal Events");
            // FIX: gcalApi に settings を渡す (将来の拡張性のため)
            existingEvents = await this.plugin.gcalApi.fetchGoogleCalendarEvents(settings);
            if (!force) {
                googleEventMap = this.mapGoogleEvents(existingEvents, taskMap);
            }
            console.timeEnd("Sync: Fetch GCal Events");

            const existingGIdSet = new Set<string>(
                existingEvents.map(e => e.id).filter((v): v is string => !!v)
            );
            
            // ID → Event の逆引きマップ（ETag 参照用）
            const eventById = new Map<string, calendar_v3.Schema$Event>();
            existingEvents.forEach(ev => { if (ev.id) eventById.set(ev.id, ev); });

            // 3. 作成/更新/キャンセル準備
            if (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) {
                new Notice(`${obsidianTasks.length} 件のタスクを処理中...`, 3000);
            }
            console.time("Sync: Prepare Batch Requests");
            const { currentObsidianTaskIds, skipped } = this.prepareBatchRequests(
                obsidianTasks, googleEventMap, taskMap, batchRequests, gcalMapper, settings, force
            );
            skippedCount += skipped;
            console.timeEnd("Sync: Prepare Batch Requests");

            // 4. 削除準備
            console.time("Sync: Prepare Deletions");
            this.prepareDeletionRequests(taskMap, currentObsidianTaskIds, existingEvents, existingGIdSet, batchRequests, settings, force);
            console.timeEnd("Sync: Prepare Deletions");

            // 5. バッチ実行
            if (batchRequests.length > 0) {
                const { results, created, updated, deleted, errors, skipped: batchSkipped } =
                    await this.executeBatchesWithRetry(batchRequests, batchProcessor);
                
                createdCount += created;
                updatedCount += updated;
                deletedCount += deleted;
                errorCount += errors;
                skippedCount += batchSkipped;

                const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(settings.calendarId)}/events`;
                const fallbackInserts: BatchRequestItem[] = [];

                results.forEach((res: BatchResponseItem, i: number) => {
                    const req = batchRequests[i];
                    // FIX: クラッシュ回避のため、応答に対応するリクエストが存在することを確認
                    if (!req) {
                        console.warn(`応答に対応するリクエストが見つかりません (index: ${i})。リトライ処理中の不整合の可能性があります。`, res);
                        errorCount++;
                        return;
                    }

                    if (res.status >= 200 && res.status < 300) {
                        const newGcalId = res.body?.id;
                        if (req.operationType === 'insert' && newGcalId && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = newGcalId;
                        } else if ((req.operationType === 'update' || req.operationType === 'patch') && newGcalId && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = newGcalId;
                        } else if (req.operationType === 'delete' && req.obsidianTaskId) {
                            delete taskMap[req.obsidianTaskId];
                        }
                    } else {
                        const status = res.status;
                        if (req.operationType === 'delete') {
                            this.handleDeleteError(req, status);
                            if (status === 410 || status === 404) {
                                if (req.obsidianTaskId) delete taskMap[req.obsidianTaskId];
                            }
                            return;
                        }

                        if ((req.operationType === 'update' || req.operationType === 'patch') && (status === 404 || status === 410)) {
                            if (req.obsidianTaskId) {
                                if (taskMap[req.obsidianTaskId]) {
                                    delete taskMap[req.obsidianTaskId];
                                }
                                fallbackInserts.push({
                                    method: 'POST',
                                    path: calendarPath,
                                    body: { ...(req.body || {}), id: this.generateStableEventId(req.obsidianTaskId) },
                                    obsidianTaskId: req.obsidianTaskId,
                                    operationType: 'insert'
                                });
                            }
                            return;
                        }

                        // insert の 409 (既存ID) はスキップ扱いにし、taskMap を安定IDで更新
                        if (req.operationType === 'insert' && status === 409 && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = this.generateStableEventId(req.obsidianTaskId);
                            skippedCount++;
                            return;
                        }

                        const operation = req.operationType || 'unknown';
                        this.errorLogs.push({
                            errorType: (status >= 500 || status === 429) ? 'transient' : 'permanent',
                            operation: operation as any,
                            taskId: req.obsidianTaskId || 'unknown',
                            gcalId: req.originalGcalId,
                            retryCount: this.retryCount,
                            errorDetails: { status }
                        });
                    }
                });

                if (fallbackInserts.length > 0) {
                    console.log(`再作成フォールバック: ${fallbackInserts.length} 件をPOST`);
                    const fb = await this.executeBatchesWithRetry(fallbackInserts, batchProcessor);
                    createdCount += fb.created;
                    updatedCount += fb.updated;
                    deletedCount += fb.deleted;
                    errorCount += fb.errors;
                    skippedCount += fb.skipped;
                    fb.results.forEach((res, idx) => {
                        const req = fallbackInserts[idx];
                        if (res.status >= 200 && res.status < 300 && res.body?.id && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = res.body.id;
                        }
                    });
                }
            } else if (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) {
                new Notice('変更なし。', 2000);
            }

            // 7. 設定保存・サマリー (FIX: Live Settings に結果を反映)
            const syncEndTime = new Date();
            this.plugin.settings.taskMap = taskMap;
            this.plugin.settings.lastSyncTime = moment(syncEndTime).format('YYYY-MM-DDTHH:mm:ssZ');
            await this.plugin.saveData(this.plugin.settings);

            const durationSeconds = moment(syncEndTime).diff(syncStartTime, 'seconds');
            const shouldShowSummary = 
                (isManualSync && settings.syncNoticeSettings.showManualSyncProgress) ||
                (!isManualSync && settings.syncNoticeSettings.showAutoSyncSummary &&
                 durationSeconds >= settings.syncNoticeSettings.minSyncDurationForNotice);
            
            if (shouldShowSummary || (errorCount > 0 && settings.syncNoticeSettings.showErrors)) {
                new Notice(`同期完了 (${durationSeconds.toFixed(1)}秒): ${createdCount}追加, ${updatedCount}更新, ${deletedCount}削除, ${skippedCount}スキップ, ${errorCount}エラー`,
                    errorCount ? 15000 : 7000);
            }
        } catch (fatal) {
            console.error('致命的エラー:', fatal);
            new Notice('同期中に致命的エラー発生。コンソールを確認してください。', 15000);
        } finally {
            this.plugin.setSyncing(false);
            this.plugin.refreshSettingsTab();
        }
    }

    private mapGoogleEvents(
        existingEvents: calendar_v3.Schema$Event[],
        taskMap: { [obsidianTaskId: string]: string }
    ): Map<string, calendar_v3.Schema$Event> {
        const googleEventMap = new Map<string, calendar_v3.Schema$Event>();
        existingEvents.forEach(event => {
            const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
            const gcalId = event.id;

            if (event.status === 'cancelled') return;

            if (obsId && gcalId) {
                const existingMapping = googleEventMap.get(obsId);
                if (!existingMapping || (event.updated && existingMapping.updated && DateUtils.parseDate(event.updated).isAfter(DateUtils.parseDate(existingMapping.updated)))) {
                    googleEventMap.set(obsId, event);
                }
                if (!taskMap[obsId] || taskMap[obsId] !== gcalId) {
                    taskMap[obsId] = gcalId;
                }
            }
        });
        return googleEventMap;
    }

    private prepareBatchRequests(
        obsidianTasks: ObsidianTask[],
        googleEventMap: Map<string, calendar_v3.Schema$Event>,
        taskMap: { [obsidianTaskId: string]: string },
        batchRequests: BatchRequestItem[],
        gcalMapper: GCalMapper,
        settings: GoogleCalendarTasksSyncSettings,
        force: boolean = false
    ): { currentObsidianTaskIds: Set<string>, skipped: number } {
        const currentObsidianTaskIds = new Set<string>();
        let skippedCount = 0;
        const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(settings.calendarId)}/events`;

        for (const task of obsidianTasks) {
            currentObsidianTaskIds.add(task.id);
            const obsId = task.id;

            if (!task.startDate || !task.dueDate) {
                skippedCount++;
                continue;
            }

            if (task.isCompleted) {
                if (!force) {
                    const existingEvent = googleEventMap.get(obsId);
                    if (existingEvent && existingEvent.status !== 'cancelled') {
                        const gcalId = existingEvent.id!;
                        const headers: Record<string, string> = {};
                        if (existingEvent.etag) headers['If-Match'] = existingEvent.etag;
                        batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, headers, body: { status: 'cancelled' }, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: gcalId });
                    } else {
                        skippedCount++;
                    }
                } else {
                    skippedCount++;
                }
                continue;
            }

            const eventPayload = gcalMapper.mapObsidianTaskToGoogleEvent(task);
            const existingEvent = googleEventMap.get(obsId);

            if (force) {
                // 挿入を冪等化するため、安定イベントIDを付与
                const insertBody = { ...eventPayload, id: this.generateStableEventId(obsId) } as GoogleCalendarEventInput;
                batchRequests.push({ method: 'POST', path: calendarPath, body: insertBody, obsidianTaskId: obsId, operationType: 'insert' });
                continue;
            }

            if (existingEvent) {
                if (this.needsUpdate(existingEvent, eventPayload)) {
                    const gcalId = existingEvent.id!;
                    const headers: Record<string, string> = {};
                    if (existingEvent.etag) headers['If-Match'] = existingEvent.etag;
                    batchRequests.push({ method: 'PUT', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, headers, body: eventPayload, obsidianTaskId: obsId, operationType: 'update', originalGcalId: gcalId });
                } else {
                    skippedCount++;
                }
            } else {
                const insertBody = { ...eventPayload, id: this.generateStableEventId(obsId) } as GoogleCalendarEventInput;
                batchRequests.push({ method: 'POST', path: calendarPath, body: insertBody, obsidianTaskId: obsId, operationType: 'insert' });
            }
        }
        return { currentObsidianTaskIds, skipped: skippedCount };
    }

    private prepareDeletionRequests(
        taskMap: { [obsidianTaskId: string]: string },
        currentObsidianTaskIds: Set<string>,
        existingGCalEvents: calendar_v3.Schema$Event[],
        existingGIdSet: Set<string>,
        batchRequests: BatchRequestItem[],
        settings: GoogleCalendarTasksSyncSettings,
        force: boolean = false
    ): void {
        const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(settings.calendarId)}/events`;
        const processed = new Set<string>();

        if (force) {
            existingGCalEvents.forEach(event => {
                if (event.id) {
                    const headers: Record<string, string> = {};
                    if (event.etag) headers['If-Match'] = event.etag;
                    batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(event.id)}`, headers, obsidianTaskId: 'force-delete', operationType: 'delete', originalGcalId: event.id });
                    processed.add(event.id);
                }
            });
            return;
        }

        Object.entries(taskMap).forEach(([obsId, gId]) => {
            if (!gId) return;
            if (!currentObsidianTaskIds.has(obsId)) {
                if (!existingGIdSet.has(gId)) {
                    delete taskMap[obsId];
                    return;
                }
                if (!processed.has(gId)) {
                    const ev = existingGCalEvents.find(e => e.id === gId);
                    const headers: Record<string, string> = {};
                    if (ev?.etag) headers['If-Match'] = ev.etag;
                    batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(gId)}`, headers, obsidianTaskId: obsId, operationType: 'delete', originalGcalId: gId });
                    processed.add(gId);
                }
            }
        });

        existingGCalEvents.forEach(event => {
            const id = event.id;
            const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
            if (id && event.extendedProperties?.private?.['isGcalSync'] === 'true' && !processed.has(id) && (!obsId || !taskMap[obsId])) {
                const headers: Record<string, string> = {};
                if (event.etag) headers['If-Match'] = event.etag;
                batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(id)}`, headers, obsidianTaskId: obsId || 'orphan', operationType: 'delete', originalGcalId: id });
                processed.add(id);
            }
        });
    }

    private async executeBatchesWithRetry(batchRequests: BatchRequestItem[], _batchProcessor: BatchProcessor): Promise<BatchResult> {
        // 選択的リトライ: 成功/恒久失敗は確定し、403/429/5xx のみ再送
        const finalResults: BatchResponseItem[] = new Array(batchRequests.length);
        let created = 0, updated = 0, deleted = 0, errors = 0, skipped = 0;

        const isTransient = (status: number) => [403, 429, 500, 502, 503, 504].includes(status);
        const treatAsSkipped = (req: BatchRequestItem, status: number) => {
            if (req.operationType === 'insert' && status === 409) return true; // 既存IDでの重複作成
            if ((req.operationType === 'delete' || req.operationType === 'update' || req.operationType === 'patch') && (status === 404 || status === 410 || status === 412)) return true; // 412: ETag競合
            return false;
        };

        // 送信対象のインデックス集合
        let pending = batchRequests.map((_, i) => i);
        let attempt = 0;

        while (pending.length > 0) {
            attempt++;
            this.retryCount = attempt - 1;

            for (let i = 0; i < pending.length; i += 50) {
                const windowIdx = pending.slice(i, i + 50);
                const subReq = windowIdx.map(idx => batchRequests[idx]);
                const subRes = await this.plugin.gcalApi.executeBatchRequest(subReq);

                subRes.forEach((res, k) => {
                    const origIdx = windowIdx[k];
                    const req = batchRequests[origIdx];

                    if (res.status >= 200 && res.status < 300) {
                        finalResults[origIdx] = res;
                        switch (req.operationType) {
                            case 'insert': created++; break;
                            case 'update':
                            case 'patch': updated++; break;
                            case 'delete': deleted++; break;
                        }
                        return;
                    }

                    if (treatAsSkipped(req, res.status)) {
                        finalResults[origIdx] = res; // スキップとして記録
                        skipped++;
                        return;
                    }

                    if (isTransient(res.status) && attempt <= this.MAX_RETRIES) {
                        // 次のラウンドで再送（finalResults は未確定のまま）
                        return;
                    }

                    // 恒久失敗として確定
                    finalResults[origIdx] = res;
                    errors++;
                });

                // レート制限回避のためのインターバッチ遅延
                if (i + 50 < pending.length && this.plugin.settings.interBatchDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.plugin.settings.interBatchDelay));
                }
            }

            // 未確定（= transient 扱い）だけを次の試行に残す
            const nextPending: number[] = [];
            for (const idx of pending) {
                if (!finalResults[idx]) nextPending.push(idx);
            }

            if (nextPending.length === 0) break;
            if (attempt >= this.MAX_RETRIES) {
                // これ以上の再送は行わない。残りはエラーで確定。
                for (const idx of nextPending) {
                    finalResults[idx] = { status: 500, body: { error: { message: 'Retry limit reached' } } };
                    errors++;
                }
                break;
            }

            const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            await new Promise(resolve => setTimeout(resolve, delay));
            pending = nextPending;
        }

        return { results: finalResults, created, updated, deleted, errors, skipped };
    }

    // 安定イベントIDを生成（Googleの制約: 英小文字/数字/ハイフン/アンダースコア, 5-1024文字）
    private generateStableEventId(obsidianTaskId: string): string {
        const sha1 = createHash('sha1').update(`obsidian-task:${obsidianTaskId}`).digest('hex');
        return `obs-${sha1}`; // 44文字程度、衝突実質無視可能
    }

    private handleDeleteError(request: BatchRequestItem, status: number): void {
        const errorType = status === 404 ? 'permanent' : 'transient';
        this.errorLogs.push({
            errorType,
            operation: 'delete',
            taskId: request.obsidianTaskId || 'unknown',
            gcalId: request.originalGcalId,
            retryCount: this.retryCount,
            errorDetails: { status }
        });
    }

    private needsUpdate(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): boolean {
        // Summary, Description, Status, Time, Reminders, Recurrence checks
        if ((existingEvent.summary || '') !== (newPayload.summary || '')) return true;
        if ((existingEvent.description || '') !== (newPayload.description || '')) return true;
        const oldStat = existingEvent.status === 'cancelled' ? 'cancelled' : 'confirmed';
        const newStat = newPayload.status === 'cancelled' ? 'cancelled' : 'confirmed';
        if (oldStat !== newStat) return true;

        const cmpTime = (t1?: calendar_v3.Schema$EventDateTime, t2?: calendar_v3.Schema$EventDateTime) => {
            if (!t1 && !t2) return false;
            if (!t1 || !t2) return true;
            if (t1.date && t2.date) return t1.date !== t2.date;
            if (t1.dateTime && t2.dateTime) return !DateUtils.isSameDateTime(t1.dateTime, t2.dateTime);
            return true;
        };
        if (cmpTime(existingEvent.start, newPayload.start)) return true;
        if (cmpTime(existingEvent.end, newPayload.end)) return true;

        const oldUseDefault = existingEvent.reminders?.useDefault ?? true;
        const newUseDefault = newPayload.reminders?.useDefault ?? true;
        if (oldUseDefault !== newUseDefault) return true;
        if (!newUseDefault) {
            const oldOverrides = existingEvent.reminders?.overrides || [];
            const newOverrides = newPayload.reminders?.overrides || [];
            if (oldOverrides.length !== newOverrides.length) return true;
            if (oldOverrides.some((o, i) => o.minutes !== newOverrides[i].minutes || o.method !== newOverrides[i].method)) return true;
        }

        const norm = (r?: string) => r ? r.toUpperCase().replace('RRULE:', '').trim() : '';
        const oldRec = (existingEvent.recurrence || []).map(norm).sort();
        const newRec = (newPayload.recurrence || []).map(norm).sort();
        if (oldRec.join(',') !== newRec.join(',')) return true;

        const oldId = existingEvent.extendedProperties?.private?.['obsidianTaskId'];
        const newId = newPayload.extendedProperties?.private?.['obsidianTaskId'];
        if ((oldId || '') !== (newId || '')) return true;

        return false;
    }
}
