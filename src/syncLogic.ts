import { Notice } from 'obsidian';
import { ErrorHandler, DateUtils } from './commonUtils';
import { calendar_v3 } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';
import { ObsidianTask, GoogleCalendarEventInput, BatchRequestItem, BatchResponseItem } from './types';
import { BatchProcessor } from './batchProcessor';

export class SyncLogic {
    private plugin: GoogleCalendarTasksSyncPlugin;
    private batchProcessor: BatchProcessor;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
        this.batchProcessor = new BatchProcessor(plugin.settings.calendarId);
    }

    /**
     * Obsidian タスクと Google Calendar イベント間の同期を実行します。
     */
    async runSync(): Promise<void> {
        if (this.plugin.isCurrentlySyncing()) {
            console.warn("同期はスキップされました: 既に進行中です。");
            new Notice("同期は既に進行中です。");
            return;
        }
        this.plugin.setSyncing(true);
        const syncStartTime = DateUtils.parseDate(new Date().toISOString());

        // 設定と認証の確認
        if (!this.plugin.settings.tokens || !this.plugin.settings.calendarId) {
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

        console.log(`カレンダー ID: ${this.plugin.settings.calendarId} と同期を開始`);
        new Notice('同期を開始しました...', 3000);

        let createdCount = 0, updatedCount = 0, deletedCount = 0, skippedCount = 0, errorCount = 0;
        const batchRequests: BatchRequestItem[] = [];
        const taskMap = { ...this.plugin.settings.taskMap };
        let existingEvents: calendar_v3.Schema$Event[] = [];
        let googleEventMap = new Map<string, calendar_v3.Schema$Event>();

        try {
            // 1. Obsidian タスク取得
            new Notice('Obsidian タスクを取得中...', 2000);
            console.time("Sync: Fetch Obsidian Tasks");
            const obsidianTasks = await this.plugin.taskParser.getObsidianTasks();
            console.timeEnd("Sync: Fetch Obsidian Tasks");

            // 2. Google Calendar イベント取得
            new Notice('GCal イベントを取得中...', 2000);
            console.time("Sync: Fetch GCal Events");
            existingEvents = await this.plugin.gcalApi.fetchGoogleCalendarEvents();
            googleEventMap = this.mapGoogleEvents(existingEvents, taskMap);
            console.timeEnd("Sync: Fetch GCal Events");

            // 3. 作成/更新/キャンセル準備
            new Notice(`${obsidianTasks.length} 件のタスクを処理中...`, 3000);
            console.time("Sync: Prepare Batch Requests");
            const { currentObsidianTaskIds, skipped } = this.prepareBatchRequests(
                obsidianTasks, googleEventMap, taskMap, batchRequests
            );
            skippedCount += skipped;
            console.timeEnd("Sync: Prepare Batch Requests");

            // 4. 削除準備
            console.time("Sync: Prepare Deletions");
            this.prepareDeletionRequests(taskMap, currentObsidianTaskIds, existingEvents, batchRequests);
            console.timeEnd("Sync: Prepare Deletions");

            // 5. バッチ実行
            if (batchRequests.length > 0) {
                const { results, created, updated, deleted, errors, skipped } = 
                    await this.batchProcessor.executeBatches(
                        batchRequests,
                        (batch) => this.plugin.gcalApi.executeBatchRequest(batch)
                    );
                
                createdCount += created;
                updatedCount += updated;
                deletedCount += deleted;
                errorCount += errors;
                skippedCount += skipped;

                // バッチ結果を処理してtaskMapを更新
                results.forEach((res, i) => {
                    const req = batchRequests[i];
                    if (res.status >= 200 && res.status < 300) {
                        const id = res.body?.id || req.originalGcalId;
                        if (req.operationType === 'insert' && id && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = id;
                        } else if ((req.operationType === 'update' || req.operationType === 'patch') && id && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = id;
                        } else if (req.operationType === 'delete' && req.obsidianTaskId) {
                            delete taskMap[req.obsidianTaskId];
                        }
                    } else if (req.operationType === 'delete' && req.obsidianTaskId) {
                        delete taskMap[req.obsidianTaskId];
                    }
                });
            } else {
                new Notice('変更なし。', 2000);
            }

            // 7. 設定保存・サマリー
            const syncEndTime = DateUtils.parseDate(new Date().toISOString());
            this.plugin.settings.taskMap = taskMap;
            this.plugin.settings.lastSyncTime = syncEndTime.toISOString();
            await this.plugin.saveData(this.plugin.settings);

            const durationSeconds = DateUtils.formatDuration(syncStartTime, syncEndTime);
            new Notice(`同期完了 (${durationSeconds.toFixed(1)}秒): ${createdCount}追加, ${updatedCount}更新, ${deletedCount}削除, ${skippedCount}スキップ, ${errorCount}エラー`,
                errorCount ? 15000 : 7000);
        } catch (fatal) {
            console.error('致命的エラー:', fatal);
            new Notice('同期中に致命的エラー発生。コンソールを確認してください。', 15000);
        } finally {
            this.plugin.setSyncing(false);
            this.plugin.refreshSettingsTab();
        }
    }

    /**
     * 取得した Google イベントをマップ化し、taskMap を修正。
     */
    private mapGoogleEvents(
        existingEvents: calendar_v3.Schema$Event[],
        taskMap: { [obsidianTaskId: string]: string }
    ): Map<string, calendar_v3.Schema$Event> {
        const googleEventMap = new Map<string, calendar_v3.Schema$Event>();
        existingEvents.forEach(event => {
            const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
            const gcalId = event.id;
            if (obsId && gcalId) {
                const existingMapping = googleEventMap.get(obsId);
                if (!existingMapping || (event.updated && existingMapping.updated && DateUtils.parseDate(event.updated).isAfter(DateUtils.parseDate(existingMapping.updated)))) {
                    googleEventMap.set(obsId, event);
                }
                if (!taskMap[obsId] || taskMap[obsId] !== gcalId) {
                    if (taskMap[obsId] && taskMap[obsId] !== gcalId) console.warn(`タスクマップ修正: ${obsId} -> ${gcalId} (旧: ${taskMap[obsId]})`);
                    else if (!taskMap[obsId]) console.log(`タスクマップ補完: ${obsId} -> ${gcalId}`);
                    taskMap[obsId] = gcalId;
                }
            } else if (gcalId && event.extendedProperties?.private?.['isGcalSync'] === 'true') {
                console.warn(`GCal イベント (ID: ${gcalId}) はプラグイン管理下ですが 'obsidianTaskId' がありません。`);
            }
        });
        return googleEventMap;
    }

    /**
     * 作成/更新/キャンセルのバッチリクエストを準備。
     */
    private prepareBatchRequests(
        obsidianTasks: ObsidianTask[],
        googleEventMap: Map<string, calendar_v3.Schema$Event>,
        taskMap: { [obsidianTaskId: string]: string },
        batchRequests: BatchRequestItem[]
    ): { currentObsidianTaskIds: Set<string>, skipped: number } {
        const currentObsidianTaskIds = new Set<string>();
        let skippedCount = 0;
        const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(this.plugin.settings.calendarId)}/events`;

        for (const task of obsidianTasks) {
            currentObsidianTaskIds.add(task.id);
            const obsId = task.id;
            const existingEvent = googleEventMap.get(obsId);
            const googleEventId = existingEvent?.id || taskMap[obsId];

            // 完了済みタスク → cancel
            if (task.isCompleted) {
                if (googleEventId && existingEvent && existingEvent.status !== 'cancelled') {
                    batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(googleEventId)}`, body: { status: 'cancelled' }, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: googleEventId });
                    console.log(`キャンセル準備: "${task.summary || obsId}" (GCal ID: ${googleEventId})`);
                } else {
                    skippedCount++;
                }
                continue;
            }

            // 日付不足 → skip
            if (!task.startDate || !task.dueDate) {
                skippedCount++;
                continue;
            }

            const eventPayload = this.plugin.gcalMapper.mapObsidianTaskToGoogleEvent(task);

            if (googleEventId && existingEvent) {
                if (this.needsUpdate(existingEvent, eventPayload)) {
                    batchRequests.push({ method: 'PUT', path: `${calendarPath}/${encodeURIComponent(googleEventId)}`, body: eventPayload, obsidianTaskId: obsId, operationType: 'update', originalGcalId: googleEventId });
                    console.log(`更新準備: "${task.summary || obsId}" (GCal ID: ${googleEventId})`);
                } else {
                    skippedCount++;
                }
            } else {
                if (googleEventId && !existingEvent) {
                    console.warn(`古いマップエントリ発見: ${googleEventId} → 再作成`);
                    delete taskMap[obsId];
                }
                batchRequests.push({ method: 'POST', path: calendarPath, body: eventPayload, obsidianTaskId: obsId, operationType: 'insert' });
                console.log(`挿入準備: "${task.summary || obsId}"`);
            }
        }
        console.log(`バッチリクエスト準備完了: ${batchRequests.length} 件の操作, ${skippedCount} 件スキップ。`);
        return { currentObsidianTaskIds, skipped: skippedCount };
    }

    /**
     * 削除バッチリクエストを準備。
     */
    private prepareDeletionRequests(
        taskMap: { [obsidianTaskId: string]: string },
        currentObsidianTaskIds: Set<string>,
        existingGCalEvents: calendar_v3.Schema$Event[],
        batchRequests: BatchRequestItem[]
    ): void {
        const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(this.plugin.settings.calendarId)}/events`;
        const processed = new Set<string>();

        // Obsidian で削除されたタスクに対応 → delete
        Object.entries(taskMap).forEach(([obsId, gId]) => {
            if (gId && !currentObsidianTaskIds.has(obsId) && !processed.has(gId)) {
                batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(gId)}`, obsidianTaskId: obsId, operationType: 'delete', originalGcalId: gId });
                processed.add(gId);
                console.log(`削除準備 (Obs削除): GCal ID: ${gId}`);
            }
        });

        // 孤児イベント → delete
        existingGCalEvents.forEach(event => {
            const id = event.id;
            const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
            if (id && event.extendedProperties?.private?.['isGcalSync'] === 'true' && !processed.has(id) && (!obsId || !taskMap[obsId])) {
                batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(id)}`, obsidianTaskId: obsId || 'orphan', operationType: 'delete', originalGcalId: id });
                processed.add(id);
                console.log(`削除準備 (孤児): GCal ID: ${id}`);
            }
        });
        console.log(`削除リクエスト準備完了。`);
    }

    /**
     * イベントの更新要否を判定
     */
    private needsUpdate(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): boolean {
        if ((existingEvent.summary||'') !== (newPayload.summary||'')) return true;
        if ((existingEvent.description||'') !== (newPayload.description||'')) return true;
        const oldStat = existingEvent.status==='cancelled'?'cancelled':'confirmed';
        const newStat = newPayload.status==='cancelled'?'cancelled':'confirmed';
        if (oldStat !== newStat) return true;
        const cmpTime = (t1: calendar_v3.Schema$EventDateTime | undefined, t2: calendar_v3.Schema$EventDateTime | undefined) => {
            if (!t1&&!t2) return false;
            if (!t1||!t2) return true;
            if (t1.date&&t2.date) return t1.date!==t2.date;
            if (t1.dateTime&&t2.dateTime) return !DateUtils.isSameDateTime(t1.dateTime, t2.dateTime);
            return true;
        };
        if (cmpTime(existingEvent.start, newPayload.start)) return true;
        if (cmpTime(existingEvent.end, newPayload.end)) return true;
        const norm = (r: string | undefined) => r ? (r.toUpperCase().startsWith('RRULE:') ? r.substring(6).trim() : r.trim()) : '';
        const oldRec = (existingEvent.recurrence||[]).map(norm).sort();
        const newRec = (newPayload.recurrence||[]).map(norm).sort();
        if (oldRec.length!==newRec.length||oldRec.some((v,i)=>v!==newRec[i])) return true;
        const oldId = existingEvent.extendedProperties?.private?.['obsidianTaskId'];
        const newId = newPayload.extendedProperties?.private?.['obsidianTaskId'];
        if ((oldId||'') !== (newId||'')) { console.warn(`ID mismatch: ${oldId} vs ${newId}`);return true; }
        return false;
    }
}
