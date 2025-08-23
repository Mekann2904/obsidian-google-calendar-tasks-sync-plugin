import { Notice } from 'obsidian';
import { ErrorHandler, DateUtils } from './commonUtils';
import { calendar_v3 } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';
import { ObsidianTask, GoogleCalendarEventInput, BatchRequestItem, BatchResponseItem, BatchResult, ErrorLog } from './types';
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
                                    body: req.body,
                                    obsidianTaskId: req.obsidianTaskId,
                                    operationType: 'insert'
                                });
                            }
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
                        batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, body: { status: 'cancelled' }, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: gcalId });
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
                batchRequests.push({ method: 'POST', path: calendarPath, body: eventPayload, obsidianTaskId: obsId, operationType: 'insert' });
                continue;
            }

            if (existingEvent) {
                if (this.needsUpdate(existingEvent, eventPayload)) {
                    const gcalId = existingEvent.id!;
                    batchRequests.push({ method: 'PUT', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, body: eventPayload, obsidianTaskId: obsId, operationType: 'update', originalGcalId: gcalId });
                } else {
                    skippedCount++;
                }
            } else {
                batchRequests.push({ method: 'POST', path: calendarPath, body: eventPayload, obsidianTaskId: obsId, operationType: 'insert' });
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
                    batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(event.id)}`, obsidianTaskId: 'force-delete', operationType: 'delete', originalGcalId: event.id });
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
                    batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(gId)}`, obsidianTaskId: obsId, operationType: 'delete', originalGcalId: gId });
                    processed.add(gId);
                }
            }
        });

        existingGCalEvents.forEach(event => {
            const id = event.id;
            const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
            if (id && event.extendedProperties?.private?.['isGcalSync'] === 'true' && !processed.has(id) && (!obsId || !taskMap[obsId])) {
                batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(id)}`, obsidianTaskId: obsId || 'orphan', operationType: 'delete', originalGcalId: id });
                processed.add(id);
            }
        });
    }

    private async executeBatchesWithRetry(batchRequests: BatchRequestItem[], batchProcessor: BatchProcessor): Promise<BatchResult> {
        while (this.retryCount <= this.MAX_RETRIES) {
            try {
                const result = await batchProcessor.executeBatches(
                    batchRequests,
                    (batch) => this.plugin.gcalApi.executeBatchRequest(batch)
                );

                if (result.errors > 0) {
                    const shouldRetry = result.results.some(res => 
                        [403, 429, 500, 502, 503, 504].includes(res.status));
                    if (shouldRetry && this.retryCount < this.MAX_RETRIES) {
                        this.retryCount++;
                        const delay = this.RETRY_DELAY_MS * Math.pow(2, this.retryCount);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                return result;
            } catch (error) {
                if (this.retryCount >= this.MAX_RETRIES) throw error;
                this.retryCount++;
                const delay = this.RETRY_DELAY_MS * Math.pow(2, this.retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw new Error(`Max retries (${this.MAX_RETRIES}) exceeded`);
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

