import { Notice } from 'obsidian';
import { ErrorHandler, DateUtils, FingerprintUtils } from './commonUtils';
import { rrulestr } from 'rrule';
import { calendar_v3 } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';
import { ObsidianTask, GoogleCalendarEventInput, BatchRequestItem, BatchResponseItem, BatchResult, ErrorLog, GoogleCalendarTasksSyncSettings, SyncMetrics } from './types';
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
    private readonly MAX_RETRIES = 4; // 再試行上限（指数バックオフ＋ジッタ）
    private readonly BASE_BACKOFF_MS = 400; // 初期バックオフ

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
        const batchProcessor = new BatchProcessor(settings);

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
            // サーバ側は privateExtendedProperty で同期対象集合を固定している前提だが、
            // 将来の挙動変化に備えて最終フィルタを適用。
            // 削除（cancelled）は extendedProperties 欠落の可能性があるため常に通す。
            try {
                const mapped = new Set<string>(Object.values(taskMap).filter((v): v is string => !!v));
                existingEvents = existingEvents.filter(ev => {
                    const managed = ev.extendedProperties?.private?.['isGcalSync'] === 'true';
                    if (ev.status === 'cancelled') return managed || (!!ev.id && mapped.has(ev.id));
                    return managed;
                });
            } catch (e) {
                console.warn('取得イベントの仕分けで警告:', e);
            }
            if (!force) {
                googleEventMap = this.mapGoogleEvents(existingEvents, taskMap);
            }
            // 重複検出用インデックス
            const dedupeIndex = this.buildDedupeIndex(existingEvents);
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
                obsidianTasks, googleEventMap, taskMap, batchRequests, gcalMapper, settings, force, dedupeIndex
            );
            skippedCount += skipped;
            console.timeEnd("Sync: Prepare Batch Requests");

            // 追加: taskMap 経由の更新・削除に If-Match を可能な限り付与して 412 を低減
            try {
                for (const r of batchRequests) {
                    if (!r || !r.originalGcalId) continue;
                    if (!r.headers) r.headers = {};
                    if (!('If-Match' in r.headers)) {
                        const ev = eventById.get(r.originalGcalId);
                        if (ev?.etag) r.headers['If-Match'] = ev.etag;
                    }
                }
            } catch {}

            // 4. 削除準備
            console.time("Sync: Prepare Deletions");
            this.prepareDeletionRequests(taskMap, currentObsidianTaskIds, existingEvents, existingGIdSet, batchRequests, settings, force);
            console.timeEnd("Sync: Prepare Deletions");

            // 5. バッチ実行
            if (batchRequests.length > 0) {
                const { results, created, updated, deleted, errors, skipped: batchSkipped, metrics } =
                    await this.executeBatchesWithRetry(batchRequests, batchProcessor);
                
                createdCount += created;
                updatedCount += updated;
                deletedCount += deleted;
                errorCount += errors;
                skippedCount += batchSkipped;

                // メトリクスの要約を出力
                if (metrics) this.logMetricsSummary('Main Batch', metrics);

                const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(settings.calendarId)}/events`;
                const fallbackInserts: BatchRequestItem[] = [];
                const fallbackNoIfMatch: BatchRequestItem[] = [];
                const fallbackDeleteNoIfMatch: BatchRequestItem[] = [];

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
                            } else if (status === 412) {
                                const retryDel: BatchRequestItem = {
                                    method: 'DELETE',
                                    path: req.path,
                                    obsidianTaskId: req.obsidianTaskId,
                                    operationType: 'delete',
                                    originalGcalId: req.originalGcalId
                                };
                                fallbackDeleteNoIfMatch.push(retryDel);
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
                                    body: { ...(req.fullBody || req.body || {}) },
                                    obsidianTaskId: req.obsidianTaskId,
                                    operationType: 'insert'
                                });
                            }
                            return;
                        }

                        // insert の 409 (既存ID) は通常 body.id 指定時の衝突。現状は安全にスキップのみ。
                        if (req.operationType === 'insert' && status === 409 && req.obsidianTaskId) {
                            console.warn('Insert 409 detected for', req.obsidianTaskId, '— skipping without mapping.');
                            skippedCount++;
                            return;
                        }

                        const operation = req.operationType || 'unknown';
                        const reason = (res.body?.error?.errors?.[0]?.reason) || (res.body?.error?.status) || '';
                        const isRate403 = status === 403 && /(rateLimitExceeded|userRateLimitExceeded)/i.test(reason);
                        const isResExhausted = /RESOURCE_EXHAUSTED/i.test(reason);
                        const isTransient = status === 412 || status === 429 || status >= 500 || isRate403 || isResExhausted;
                        const message = typeof res.body?.error?.message === 'string' ? (res.body.error.message as string).slice(0, 200) : undefined;
                        const entry: ErrorLog = {
                            errorType: isTransient ? 'transient' : 'permanent',
                            operation: operation as any,
                            taskId: req.obsidianTaskId || 'unknown',
                            gcalId: req.originalGcalId,
                            retryCount: this.retryCount,
                            errorDetails: { status, reason, message }
                        };
                        this.errorLogs.push(entry);
                        // 412 (If-Match 不一致) はローカル優先で上書き再送
                        if ((req.operationType === 'update' || req.operationType === 'patch') && status === 412) {
                            const retry: BatchRequestItem = {
                                method: req.method,
                                path: req.path,
                                body: req.body || req.fullBody,
                                obsidianTaskId: req.obsidianTaskId,
                                operationType: req.operationType,
                                originalGcalId: req.originalGcalId
                            };
                            fallbackNoIfMatch.push(retry);
                            return;
                        }
                        if (status === 400) {
                            try {
                                console.error('400 body:', JSON.stringify(res.body).slice(0, 500));
                                console.error('400 req:', JSON.stringify(req.body || req.fullBody).slice(0, 500));
                            } catch {}
                        }
                        // 診断用に recentErrors を更新（上限 50 件）
                        const maxSamples = 50;
                        const arr = this.plugin.settings.recentErrors ?? [];
                        arr.unshift(entry);
                        while (arr.length > maxSamples) arr.pop();
                        this.plugin.settings.recentErrors = arr;
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
                    if (fb.metrics) this.logMetricsSummary('Fallback Inserts', fb.metrics);
                    fb.results.forEach((res, idx) => {
                        const req = fallbackInserts[idx];
                        if (res.status >= 200 && res.status < 300 && res.body?.id && req.obsidianTaskId) {
                            taskMap[req.obsidianTaskId] = res.body.id;
                        }
                    });
                }

                if (fallbackNoIfMatch.length > 0) {
                    console.log(`412再試行(If-Match無): ${fallbackNoIfMatch.length} 件を再送`);
                    const fb2 = await this.executeBatchesWithRetry(fallbackNoIfMatch, batchProcessor);
                    createdCount += fb2.created;
                    updatedCount += fb2.updated;
                    deletedCount += fb2.deleted;
                    errorCount += fb2.errors;
                    skippedCount += fb2.skipped;
                }

                if (fallbackDeleteNoIfMatch.length > 0) {
                    console.log(`412削除再試行(If-Match無): ${fallbackDeleteNoIfMatch.length} 件を再送`);
                    const fb3 = await this.executeBatchesWithRetry(fallbackDeleteNoIfMatch, batchProcessor);
                    createdCount += fb3.created;
                    updatedCount += fb3.updated;
                    deletedCount += fb3.deleted;
                    errorCount += fb3.errors;
                    skippedCount += fb3.skipped;
                    // 成功した delete は taskMap を掃除
                    fb3.results.forEach((res, idx) => {
                        const req = fallbackDeleteNoIfMatch[idx];
                        if (res.status >= 200 && res.status < 300 && req?.obsidianTaskId) {
                            delete taskMap[req.obsidianTaskId];
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
            // recentErrors を永続化
            try { await this.plugin.saveData(this.plugin.settings); } catch {}
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
                const prev = googleEventMap.get(obsId);
                if (!prev) {
                    googleEventMap.set(obsId, event);
                } else {
                    const a = prev.updated ? DateUtils.parseDate(prev.updated) : DateUtils.parseDate('1970-01-01');
                    const b = event.updated ? DateUtils.parseDate(event.updated) : DateUtils.parseDate('1970-01-01');
                    if (b.isAfter(a)) googleEventMap.set(obsId, event);
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
        force: boolean = false,
        dedupeIndex?: Map<string, calendar_v3.Schema$Event>
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
                    if (existingEvent) {
                        const gcalId = existingEvent.id!;
                        const headers: Record<string, string> = {};
                        if (existingEvent.etag) headers['If-Match'] = existingEvent.etag;
                        // 完了は status をキャンセルにせず、extendedProperties.private.isCompleted='true' を更新
                        const payload = gcalMapper.mapObsidianTaskToGoogleEvent(task);
                        const patchBody = this.buildPatchBody(existingEvent, payload);
                        batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, headers, body: patchBody, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: gcalId });
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
                // Google Calendar の events.insert は body.id を受け付けないため付与しない
                const bodies = this.expandEventForInsertion(eventPayload, task);
                bodies.forEach(body => batchRequests.push({ method: 'POST', path: calendarPath, body, obsidianTaskId: obsId, operationType: 'insert' }));
                continue;
            }

            if (existingEvent) {
                if (this.needsUpdate(existingEvent, eventPayload)) {
                    const gcalId = existingEvent.id!;
                    // 展開条件: 日次時間帯 or 日付跨ぎの時間指定
                    const rr = (eventPayload.recurrence || [])[0] || '';
                    const isDaily = /FREQ=DAILY/.test(rr);
                    const sdt = eventPayload.start?.dateTime ? moment.parseZone(eventPayload.start.dateTime) : null;
                    const edt = eventPayload.end?.dateTime ? moment.parseZone(eventPayload.end.dateTime) : null;
                    const crossDay = !!(sdt && edt && !sdt.isSame(edt, 'day'));

                    if (isDaily || crossDay) {
                        // 既存を削除し、必要数のPOSTへ置換
                        const delHeaders: Record<string, string> = {};
                        if (existingEvent.etag) delHeaders['If-Match'] = existingEvent.etag;
                        batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, headers: delHeaders, obsidianTaskId: obsId, operationType: 'delete', originalGcalId: gcalId });
                        const bodies = this.expandEventForInsertion(eventPayload, task);
                        bodies.forEach(body => batchRequests.push({ method: 'POST', path: calendarPath, body, obsidianTaskId: obsId, operationType: 'insert' }));
                    } else {
                        const headers: Record<string, string> = {};
                        if (existingEvent.etag) headers['If-Match'] = existingEvent.etag;
                        const patchBody = this.buildPatchBody(existingEvent, eventPayload);
                        batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(gcalId)}`, headers, body: patchBody, fullBody: eventPayload, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: gcalId });
                    }
                } else {
                    skippedCount++;
                }
            } else {
                // まず taskMap を優先（updatedMin/窓の都合でリストに出てこないケースの重複作成を防ぐ）
                const mappedId = taskMap[obsId];
                if (mappedId) {
                    // ID 指定更新でも展開条件なら置換
                    const rr = (eventPayload.recurrence || [])[0] || '';
                    const isDaily = /FREQ=DAILY/.test(rr);
                    const sdt = eventPayload.start?.dateTime ? moment.parseZone(eventPayload.start.dateTime) : null;
                    const edt = eventPayload.end?.dateTime ? moment.parseZone(eventPayload.end.dateTime) : null;
                    const crossDay = !!(sdt && edt && !sdt.isSame(edt, 'day'));
                    if (isDaily || crossDay) {
                        batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(mappedId)}`, obsidianTaskId: obsId, operationType: 'delete', originalGcalId: mappedId });
                        const bodies = this.expandEventForInsertion(eventPayload, task);
                        bodies.forEach(body => batchRequests.push({ method: 'POST', path: calendarPath, body, obsidianTaskId: obsId, operationType: 'insert' }));
                    } else {
                        const headers: Record<string, string> = {};
                        batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(mappedId)}`, headers, body: eventPayload, fullBody: eventPayload, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: mappedId });
                    }
                } else {
                    // 重複防止: 同一性キーで既存イベントを検索
                    const identity = this.buildIdentityKeyFromPayload(eventPayload);
                    const dup = dedupeIndex?.get(identity);
                    if (dup && dup.id) {
                        // 既存イベントを再利用し、マッピングだけ張る
                        taskMap[obsId] = dup.id;
                        // 内容差分があれば PATCH（extendedProperties の obsidianTaskId 差異は無視）
                        if (this.needsUpdateIgnoringOwner(dup, eventPayload)) {
                            const headers: Record<string, string> = {};
                            if (dup.etag) headers['If-Match'] = dup.etag;
                            batchRequests.push({ method: 'PATCH', path: `${calendarPath}/${encodeURIComponent(dup.id)}`, headers, body: this.buildPatchBodyIgnoringOwner(dup, eventPayload), fullBody: eventPayload, obsidianTaskId: obsId, operationType: 'patch', originalGcalId: dup.id });
                        } else {
                            skippedCount++;
                        }
                    } else {
                        const bodies = this.expandEventForInsertion(eventPayload, task);
                        bodies.forEach(body => batchRequests.push({ method: 'POST', path: calendarPath, body, obsidianTaskId: obsId, operationType: 'insert' }));
                    }
                }
            }
        }
        return { currentObsidianTaskIds, skipped: skippedCount };
    }

    // 挿入時に必要なら日次スライスや毎日展開に分割
    private expandEventForInsertion(eventPayload: GoogleCalendarEventInput, task: ObsidianTask): GoogleCalendarEventInput[] {
        const out: GoogleCalendarEventInput[] = [];
        const clone = (e: GoogleCalendarEventInput): GoogleCalendarEventInput => JSON.parse(JSON.stringify(e));

        const ruleStr = (eventPayload.recurrence || [])[0] || '';
        const hasRecurrence = !!ruleStr;

        // 0) 汎用: RRULE があり、🛫/📅 がある場合は rrule で期間内の実発生日を列挙して個別イベント化
        if (hasRecurrence && task.startDate && task.dueDate) {
            try {
                const dtstart = eventPayload.start?.dateTime ? new Date(eventPayload.start.dateTime) : new Date(task.startDate);
                const set = rrulestr(ruleStr, { forceset: true, dtstart });
                const startBound = moment(task.startDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).startOf('day').toDate();
                // inclusive のため終端は日末まで
                const endBound = moment(task.dueDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).endOf('day').toDate();
                const dates: Date[] = (set as any).between(startBound, endBound, true) as Date[];
                if (dates && dates.length > 0) {
                    const baseStart = eventPayload.start?.dateTime ? moment.parseZone(eventPayload.start.dateTime) : null;
                    const baseEnd = eventPayload.end?.dateTime ? moment.parseZone(eventPayload.end.dateTime) : null;
                    const durationMs = baseStart && baseEnd ? baseEnd.diff(baseStart) : 0;
                    const twStart = task.timeWindowStart || (baseStart ? baseStart.format('HH:mm') : undefined);
                    const twEnd = task.timeWindowEnd || (baseEnd ? baseEnd.format('HH:mm') : undefined);

                    dates.forEach(d => {
                        const m = moment(d);
                        let s: moment.Moment;
                        let e: moment.Moment;
                        if (twStart && twEnd) {
                            const [sh, sm] = twStart.split(':').map(Number);
                            s = m.clone().hour(sh).minute(sm).second(0).millisecond(0);
                            if (twEnd === '24:00') e = m.clone().add(1,'day').startOf('day');
                            else {
                                const [eh, em] = twEnd.split(':').map(Number);
                                e = m.clone().hour(eh).minute(em).second(0).millisecond(0);
                            }
                        } else if (baseStart && durationMs > 0) {
                            s = m.clone().hour(baseStart.hour()).minute(baseStart.minute()).second(0).millisecond(0);
                            e = s.clone().add(durationMs, 'ms');
                        } else {
                            // 時刻情報がない場合は終日1日（フォールバック）
                            out.push({ ...clone(eventPayload), start: { date: m.format('YYYY-MM-DD') }, end: { date: m.clone().add(1,'day').format('YYYY-MM-DD') }, recurrence: undefined });
                            return;
                        }
                        // ガード: 不正や逆転を修正
                        if (!s.isValid()) { console.warn('skip invalid start', m.toString()); return; }
                        if (!e.isValid() || !e.isAfter(s)) {
                            // 最低でも設定のデフォルト分だけ確保（存在しない時間帯は次の00:00）
                            const minEnd = s.clone().add(this.plugin.settings.defaultEventDurationMinutes, 'minute');
                            e = e.isValid() ? (e.isAfter(s) ? e : minEnd) : minEnd;
                        }
                        const ev = clone(eventPayload);
                        ev.start = { dateTime: s.format('YYYY-MM-DDTHH:mm:ssZ'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } as any;
                        ev.end = { dateTime: e.format('YYYY-MM-DDTHH:mm:ssZ'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } as any;
                        ev.recurrence = undefined;
                        if ((ev.start as any).date) delete (ev.start as any).date;
                        if ((ev.end as any).date) delete (ev.end as any).date;
                        out.push(ev);
                    });
                    if (out.length > 0) return out;
                }
            } catch (e) {
                console.warn('RRULE 展開に失敗したため、フォールバック経路を使用します。', e);
            }
        }

        // 1) daily + COUNT の場合は個別イベントに展開
        const mDaily = ruleStr.match(/FREQ=DAILY(?:;COUNT=(\d+))?/);
        if (mDaily) {
            let count = Number(mDaily[1] || '');
            if (!count || isNaN(count)) {
                // COUNT が無い場合は🛫〜📅の日数で補完
                if (task.startDate && task.dueDate) {
                    const s = moment(task.startDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).startOf('day');
                    const e = moment(task.dueDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).startOf('day');
                    const days = e.diff(s, 'days') + 1;
                    count = days > 0 ? days : 1;
                } else {
                    count = 1;
                }
            }
            const base = eventPayload.start?.dateTime ? moment.parseZone(eventPayload.start.dateTime) : null;
            if (base && count > 0) {
                // 時間帯はタスクの timeWindow または payload の時刻から推定
                const twStart = task.timeWindowStart || moment(base).format('HH:mm');
                const twEnd = task.timeWindowEnd || (eventPayload.end?.dateTime ? moment.parseZone(eventPayload.end.dateTime).format('HH:mm') : '24:00');
                for (let i = 0; i < count; i++) {
                    const sDay = base.clone().add(i, 'day');
                    const [sh, sm] = twStart.split(':').map(Number);
                    const [eh, em] = twEnd.split(':').map(x => x === '24:00' ? NaN : Number(x));
                    const s = sDay.clone().hour(sh).minute(sm).second(0).millisecond(0);
                    let e: moment.Moment;
                    if (twEnd === '24:00') {
                        e = sDay.clone().add(1, 'day').startOf('day');
                    } else {
                        e = sDay.clone().hour(eh!).minute(em!).second(0).millisecond(0);
                    }
                    if (!s.isValid()) { console.warn('skip invalid start (daily expand):', sDay.toString()); continue; }
                    if (!e.isValid() || !e.isAfter(s)) {
                        e = s.clone().add(this.plugin.settings.defaultEventDurationMinutes, 'minute');
                    }
                    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    const ev = clone(eventPayload);
                    ev.start = { dateTime: s.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz } as any;
                    ev.end = { dateTime: e.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz } as any;
                    ev.recurrence = undefined;
                    if ((ev.start as any).date) delete (ev.start as any).date;
                    if ((ev.end as any).date) delete (ev.end as any).date;
                    out.push(ev);
                }
                return out;
            }
        }

        // 2) 単一イベントが日付を跨ぐ場合は日次スライス
        const sdt = eventPayload.start?.dateTime ? moment.parseZone(eventPayload.start.dateTime) : null;
        const edt = eventPayload.end?.dateTime ? moment.parseZone(eventPayload.end.dateTime) : null;
        if (sdt && edt && !sdt.isSame(edt, 'day')) {
            let cursor = sdt.clone();
            // 先頭スライス: 開始〜24:00
            let endOfDay = cursor.clone().add(1,'day').startOf('day');
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            out.push({ ...clone(eventPayload), start: { dateTime: cursor.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz } as any, end: { dateTime: endOfDay.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz } as any, recurrence: undefined });
            // 中間スライス: 00:00〜24:00
            cursor = endOfDay.clone();
            while (cursor.isBefore(edt, 'day')) {
                const next = cursor.clone().add(1,'day').startOf('day');
                const tzMid = Intl.DateTimeFormat().resolvedOptions().timeZone;
                out.push({
                    ...clone(eventPayload),
                    start: { dateTime: cursor.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tzMid } as any,
                    end:   { dateTime: next.format('YYYY-MM-DDTHH:mm:ss'),   timeZone: tzMid } as any,
                    recurrence: undefined
                });
                cursor = next;
            }
            // 最終スライス: 00:00〜元の終了時刻
            const finalStart = cursor.startOf('day');
            if (finalStart.isBefore(edt)) {
                const tz2 = Intl.DateTimeFormat().resolvedOptions().timeZone;
                out.push({ ...clone(eventPayload), start: { dateTime: finalStart.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz2 } as any, end: { dateTime: edt.format('YYYY-MM-DDTHH:mm:ss'), timeZone: tz2 } as any, recurrence: undefined });
            }
            // 正規化: date を排除
            out.forEach(ev => { if ((ev.start as any).date) delete (ev.start as any).date; if ((ev.end as any).date) delete (ev.end as any).date; });
            return out;
        }

        // 3) それ以外はそのまま単一
        out.push(eventPayload);
        return out;
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
            // [安全化] プラグイン管理対象 or taskMap が参照している ID のみ削除
            const managedOrMapped = new Set<string>(Object.values(this.plugin.settings.taskMap || {}));
            existingGCalEvents.forEach(event => {
                if (!event.id) return;
                const isManaged = event.extendedProperties?.private?.['isGcalSync'] === 'true';
                const isMapped = managedOrMapped.has(event.id);
                if (!(isManaged || isMapped)) return;
                const headers: Record<string, string> = {};
                if (event.etag) headers['If-Match'] = event.etag;
                batchRequests.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(event.id)}`, headers, obsidianTaskId: 'force-delete', operationType: 'delete', originalGcalId: event.id });
                processed.add(event.id);
            });
            return;
        }

        // 現在のタスクが参照中の gId を収集
        const gIdsInUseByCurrent = new Set<string>();
        for (const id of currentObsidianTaskIds) {
            const gid = taskMap[id];
            if (gid) gIdsInUseByCurrent.add(gid);
        }

        const byId = new Map<string, calendar_v3.Schema$Event>();
        existingGCalEvents.forEach(e => { if (e.id) byId.set(e.id, e); });

        Object.entries(taskMap).forEach(([obsId, gId]) => {
            if (!gId) return;
            if (!currentObsidianTaskIds.has(obsId)) {
                if (!existingGIdSet.has(gId)) {
                    delete taskMap[obsId];
                    return;
                }
                // 他の現行タスクが同じ gId を使用している場合は削除しない
                if (gIdsInUseByCurrent.has(gId)) {
                    delete taskMap[obsId]; // 古い片方のマップは掃除
                    return;
                }
                if (!processed.has(gId)) {
                    const ev = byId.get(gId);
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
                if (gIdsInUseByCurrent.has(id)) return; // 現行タスクが参照中なら孤児扱いにしない
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
        const metrics: SyncMetrics = {
            sentSubBatches: 0,
            attempts: 0,
            totalWaitMs: 0,
            batchLatenciesMs: [],
            statusCounts: {},
        };

        const treatAsSkipped = (req: BatchRequestItem, status: number) => {
            if (req.operationType === 'insert' && status === 409) return true; // 既存IDでの重複作成
            if ((req.operationType === 'delete' || req.operationType === 'update' || req.operationType === 'patch') && (status === 404 || status === 410)) return true;
            return false;
        };

        // 送信対象のインデックス集合
        let pending = batchRequests.map((_, i) => i);
        let attempt = 0;

        while (pending.length > 0) {
            attempt++;
            this.retryCount = attempt - 1;
            metrics.attempts = attempt; // 最終回数で更新

            const subBatchSize = Math.max(1, Math.min(this.plugin.settings.batchSize ?? 100, 1000));
            // 公式上限は1000。各パートは個別リクエストとしてカウントされ、順序保証はない。
            for (let i = 0; i < pending.length; i += subBatchSize) {
                const windowIdx = pending.slice(i, i + subBatchSize);
                const subReq = windowIdx.map(idx => batchRequests[idx]);
                const start = performance.now();
                const subRes = await this.plugin.gcalApi.executeBatchRequest(subReq);
                const end = performance.now();
                metrics.sentSubBatches++;
                metrics.batchLatenciesMs.push(end - start);

                // Content-ID での対応づけ（順序入れ替わりに強く）
                const cidToOrig = new Map<string, number>();
                windowIdx.forEach((orig, j) => cidToOrig.set(`item-${j + 1}`, orig));

                subRes.forEach((res, k) => {
                    const mappedIdx = res.contentId ? cidToOrig.get(res.contentId) : undefined;
                    if (res.contentId && mappedIdx === undefined) {
                        console.warn('Unknown Content-ID in batch response:', res.contentId);
                    }
                    const origIdx = mappedIdx !== undefined ? mappedIdx : windowIdx[k];
                    const req = batchRequests[origIdx];

                    metrics.statusCounts[res.status] = (metrics.statusCounts[res.status] || 0) + 1;
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

                    // 409/410/404/412 などの恒久的/スキップ対象
                    if (treatAsSkipped(req, res.status)) {
                        finalResults[origIdx] = res; // スキップとして記録
                        skipped++;
                        return;
                    }

                    // 再試行条件（429, 403: rateLimitExceeded系, 5xx）
                    const reason = (res.body?.error?.errors?.[0]?.reason) || (res.body?.error?.status) || '';
                    const shouldRetry = this.shouldRetry(res.status, String(reason));
                    if (shouldRetry && attempt <= this.MAX_RETRIES) {
                        // 次のラウンドで再送（finalResults は未確定のまま）
                        return;
                    }

                    // 412: 後続の If-Match 無し再送で処理するため、ここではエラー/スキップにカウントしない
                    if (res.status === 412) {
                        finalResults[origIdx] = res;
                        return;
                    }

                    // 恒久失敗として確定
                    finalResults[origIdx] = res;
                    errors++;
                });

                // レート制限回避のためのインターバッチ遅延
                if (i + subBatchSize < pending.length && (this.plugin.settings.interBatchDelay ?? 0) > 0) {
                    const base = this.plugin.settings.interBatchDelay;
                    const jittered = Math.floor(base * (Math.random() * 0.5 + 0.75)); // ±25% ジッタ
                    metrics.totalWaitMs += jittered;
                    await new Promise(resolve => setTimeout(resolve, jittered));
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

            const delay = this.backoffDelayMs(attempt);
            metrics.totalWaitMs += delay;
            await new Promise(resolve => setTimeout(resolve, delay));
            pending = nextPending;
        }

        return { results: finalResults, created, updated, deleted, errors, skipped, metrics };
    }

    private shouldRetry(status: number, reason: string): boolean {
        if (status === 429) return true;
        if (status === 403 && /(rateLimitExceeded|userRateLimitExceeded)/i.test(reason)) return true;
        if (/(RESOURCE_EXHAUSTED)/i.test(reason)) return true;
        if (status === 500 || status === 502 || status === 503 || status === 504) return true;
        return false;
    }

    private backoffDelayMs(attempt: number, cap = 20_000): number {
        const exp = Math.min(cap, this.BASE_BACKOFF_MS * Math.pow(2, attempt));
        const jitter = exp * (Math.random() * 0.5 + 0.75); // 0.75x〜1.25x
        return Math.floor(jitter);
    }

    // 安定イベントIDを生成（Googleの制約: 英小文字/数字/ハイフン/アンダースコア, 5-1024文字）
    // generateStableEventId は未使用のため削除

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

    // 予定の同一性キー（タイトル、開始/終了、終日/時刻、RRULE、状態）
    private buildIdentityKeyFromPayload(payload: GoogleCalendarEventInput): string {
        const sum = (payload.summary || '').trim().replace(/\s+/g, ' ');
        const keyTime = (t?: calendar_v3.Schema$EventDateTime) => {
            if (!t) return 'N';
            if (t.date) return `D:${t.date}`; // 終日: exclusive end は比較側でも同じ仕様
            if (t.dateTime) return `T:${moment(t.dateTime).toISOString(true)}`; // keep offset
            return 'N';
        };
        const startK = keyTime(payload.start);
        const endK = keyTime(payload.end);
        const stat = (payload.status === 'cancelled') ? 'X' : 'C';
        const rec = (payload.recurrence || []).map(r => r.toUpperCase().trim()).sort().join(';');
        const includeDesc = !!this.plugin.settings.includeDescriptionInIdentity;
        const includeRem  = !!this.plugin.settings.includeReminderInIdentity;
        const descK = includeDesc ? `|D|${(payload.description || '').trim()}` : '';
        const remK = includeRem ? `|M|${this.reminderFingerprint(payload)}` : '';
        return `S|${sum}|A|${startK}|B|${endK}|R|${rec}|Z|${stat}${descK}${remK}`;
    }

    private buildIdentityKeyFromEvent(ev: calendar_v3.Schema$Event): string {
        const sum = (ev.summary || '').trim().replace(/\s+/g, ' ');
        const keyTime = (t?: calendar_v3.Schema$EventDateTime) => {
            if (!t) return 'N';
            if ((t as any).date) return `D:${(t as any).date}`;
            if ((t as any).dateTime) return `T:${moment((t as any).dateTime).toISOString(true)}`;
            return 'N';
        };
        const startK = keyTime(ev.start);
        const endK = keyTime(ev.end);
        const stat = (ev.status === 'cancelled') ? 'X' : 'C';
        const rec = (ev.recurrence || []).map(r => r.toUpperCase().trim()).sort().join(';');
        const includeDesc = !!this.plugin.settings.includeDescriptionInIdentity;
        const includeRem  = !!this.plugin.settings.includeReminderInIdentity;
        const descK = includeDesc ? `|D|${(ev.description || '').trim()}` : '';
        const remK = includeRem ? `|M|${this.reminderFingerprint(ev)}` : '';
        return `S|${sum}|A|${startK}|B|${endK}|R|${rec}|Z|${stat}${descK}${remK}`;
    }

    private reminderFingerprint(x: any): string {
        const useDefault = x.reminders?.useDefault ?? undefined;
        const overridesRaw = x.reminders?.overrides ?? undefined;
        const overrides = (overridesRaw || []).map((o: any) => ({ method: o?.method ?? 'popup', minutes: o?.minutes ?? 0 }));
        if (useDefault === undefined && overrides.length === 0) return 'N';
        if (useDefault) return 'DEF';
        if (!overrides.length) return 'OFF';
        // 並び順の影響を排除
        const sig = overrides.map((o: any) => `${o.method || 'popup'}:${o.minutes ?? 0}`).sort().join(',');
        return `OVR(${sig})`;
    }

    private buildDedupeIndex(events: calendar_v3.Schema$Event[]): Map<string, calendar_v3.Schema$Event> {
        const map = new Map<string, calendar_v3.Schema$Event>();
        for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            if (ev.extendedProperties?.private?.['isGcalSync'] !== 'true') continue; // プラグイン管理対象のみ
            const key = this.buildIdentityKeyFromEvent(ev);
            const prev = map.get(key);
            if (!prev) map.set(key, ev);
            else {
                // 更新日時が新しい方を残す
                const newer = (a?: string | null, b?: string | null) => (a && b)
                    ? moment(a ?? undefined).isAfter(moment(b ?? undefined))
                    : !!a && !b;
                map.set(key, newer(ev.updated, prev.updated) ? ev : prev);
            }
        }
        return map;
    }

    private needsUpdate(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): boolean {
        // Summary, Description, Status, Time, Reminders, Recurrence checks
        // まず localFp を比較（説明/リマインダー含有は設定に従う）
        const includeDesc = !!this.plugin.settings.includeDescriptionInIdentity;
        const includeRem  = !!this.plugin.settings.includeReminderInIdentity;
        const payloadForFp = {
            summary: newPayload.summary,
            description: includeDesc ? newPayload.description : undefined,
            start: newPayload.start,
            end: newPayload.end,
            status: newPayload.status,
            recurrence: newPayload.recurrence,
            reminders: includeRem ? newPayload.reminders : undefined,
        } as GoogleCalendarEventInput;
        const newFp = FingerprintUtils.identityKeyFromEvent(payloadForFp as any, includeDesc, includeRem);
        const oldFp = existingEvent.extendedProperties?.private?.['localFp'];
        if (oldFp && oldFp === newFp) return false;

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

        return false;
    }

    // obsidianTaskId の相違を無視して差分を判定（重複再利用時）
    private needsUpdateIgnoringOwner(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): boolean {
        // Summary, Description, Status, Time, Reminders, Recurrence checks（所有者IDの違いは無視）
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

        return false;
    }

    // 差分PATCHボディを生成
    private buildPatchBody(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): Partial<calendar_v3.Schema$Event> {
        const patch: Partial<calendar_v3.Schema$Event> = {};

        if ((existingEvent.summary || '') !== (newPayload.summary || '')) patch.summary = newPayload.summary;
        if ((existingEvent.description || '') !== (newPayload.description || '')) patch.description = newPayload.description;

        const oldStat = existingEvent.status === 'cancelled' ? 'cancelled' : 'confirmed';
        const newStat = newPayload.status === 'cancelled' ? 'cancelled' : 'confirmed';
        if (oldStat !== newStat) patch.status = newPayload.status;

        const cmpTime = (t1?: calendar_v3.Schema$EventDateTime, t2?: calendar_v3.Schema$EventDateTime) => {
            if (!t1 && !t2) return false;
            if (!t1 || !t2) return true;
            if (t1.date && t2.date) return t1.date !== t2.date;
            if (t1.dateTime && t2.dateTime) return !DateUtils.isSameDateTime(t1.dateTime, t2.dateTime);
            return true;
        };
        if (cmpTime(existingEvent.start, newPayload.start)) patch.start = newPayload.start;
        if (cmpTime(existingEvent.end, newPayload.end)) patch.end = newPayload.end;

        const oldUseDefault = existingEvent.reminders?.useDefault ?? true;
        const newUseDefault = newPayload.reminders?.useDefault ?? true;
        if (oldUseDefault !== newUseDefault) patch.reminders = newPayload.reminders;
        else if (!newUseDefault) {
            const oldOverrides = existingEvent.reminders?.overrides || [];
            const newOverrides = newPayload.reminders?.overrides || [];
            if (oldOverrides.length !== newOverrides.length || oldOverrides.some((o, i) => o.minutes !== newOverrides[i].minutes || o.method !== newOverrides[i].method)) {
                patch.reminders = newPayload.reminders;
            }
        }

        const norm = (r?: string) => r ? r.toUpperCase().replace('RRULE:', '').trim() : '';
        const oldRec = (existingEvent.recurrence || []).map(norm).sort().join(',');
        const newRec = (newPayload.recurrence || []).map(norm).sort().join(',');
        if (oldRec !== newRec) patch.recurrence = newPayload.recurrence;

        // extendedProperties の obsidianTaskId 差異は更新しない（重複再利用時の所有者揺れを無視）
        // isGcalSync が欠けている場合のみ補う
        // 管理印を最新に（localFp/appId/version）
        const includeDesc2 = !!this.plugin.settings.includeDescriptionInIdentity;
        const includeRem2  = !!this.plugin.settings.includeReminderInIdentity;
        const priv: any = {
            ...(existingEvent.extendedProperties?.private || {}),
            isGcalSync: 'true',
            appId: 'obsidian-gcal-tasks',
            version: '1',
            localFp: FingerprintUtils.identityKeyFromEvent(
                {
                    summary: newPayload.summary,
                    description: includeDesc2 ? newPayload.description : undefined,
                    start: newPayload.start,
                    end: newPayload.end,
                    status: newPayload.status,
                    recurrence: newPayload.recurrence,
                    reminders: includeRem2 ? newPayload.reminders : undefined,
                } as any,
                includeDesc2,
                includeRem2
            ),
        };
        // 完了フラグが新Payloadに含まれる場合は反映
        const newCompleted = (newPayload.extendedProperties as any)?.private?.isCompleted;
        if (typeof newCompleted === 'string') {
            priv.isCompleted = newCompleted;
        }
        patch.extendedProperties = { private: priv } as any;

        // 何も差分がない場合は summary を noop として入れない（空オブジェクトのまま返す）
        return patch;
    }

    // 所有者差異を無視してPATCHボディを生成（重複再利用用）
    private buildPatchBodyIgnoringOwner(
        existingEvent: calendar_v3.Schema$Event,
        newPayload: GoogleCalendarEventInput
    ): Partial<calendar_v3.Schema$Event> {
        const tmp = this.buildPatchBody(existingEvent, newPayload);
        // 所有者差異は無視するが、管理印(localFp等)は送る
        return tmp;
    }

    // メトリクスのp50/p95/p99を計算して要約ログを出力
    private logMetricsSummary(title: string, metrics: SyncMetrics): void {
        const lat = metrics.batchLatenciesMs.slice().sort((a,b)=>a-b);
        const pct = (p: number) => {
            if (lat.length === 0) return 0;
            const idx = Math.min(lat.length - 1, Math.ceil((p/100)*lat.length)-1);
            return lat[idx];
        };
        const p50 = pct(50);
        const p95 = pct(95);
        const p99 = pct(99);
        const sum = lat.reduce((s,v)=>s+v,0);
        const avg = lat.length ? sum/lat.length : 0;
        const sc = metrics.statusCounts;
        const scStr = Object.keys(sc).sort().map(k=>`${k}:${sc[+k]}`).join(', ');
        console.log(`[Metrics] ${title}: batches=${metrics.sentSubBatches}, attempts=${metrics.attempts}, waitMs=${metrics.totalWaitMs}, avg=${avg.toFixed(1)}ms, p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, p99=${p99.toFixed(1)}ms, statuses={ ${scStr} }`);
    }

    // 重複整理（ドライラン/実行）
    async runDedupeCleanup(dryRun: boolean = true): Promise<void> {
        if (!this.plugin.settings.tokens) {
            new Notice('未認証のため重複整理を実行できない。設定から認証する。', 7000);
            return;
        }
        const ok = await this.plugin.authService.ensureAccessToken();
        if (!ok || !this.plugin.calendar) {
            new Notice('カレンダーAPIクライアント未準備のため中止。', 7000);
            return;
        }

        const tmpSettings = JSON.parse(JSON.stringify(this.plugin.settings)) as GoogleCalendarTasksSyncSettings;
        tmpSettings.lastSyncTime = undefined;
        tmpSettings.fetchWindowPastDays = 0;
        tmpSettings.fetchWindowFutureDays = 0;

        console.time('Dedupe: Fetch all managed events');
        const events = await this.plugin.gcalApi.fetchGoogleCalendarEvents(tmpSettings);
        console.timeEnd('Dedupe: Fetch all managed events');

        // グルーピング
        const groups = new Map<string, calendar_v3.Schema$Event[]>();
        for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            if (ev.extendedProperties?.private?.['isGcalSync'] !== 'true') continue;
            const key = this.buildIdentityKeyFromEvent(ev);
            const arr = groups.get(key) || [];
            arr.push(ev);
            groups.set(key, arr);
        }

        // タスク参照数
        const usage = new Map<string, number>();
        Object.values(this.plugin.settings.taskMap || {}).forEach(id => {
            if (!id) return; usage.set(id, (usage.get(id) || 0) + 1);
        });

        type Plan = { key: string; keep: calendar_v3.Schema$Event; removes: calendar_v3.Schema$Event[] };
        const plans: Plan[] = [];
        for (const [key, arr] of groups) {
            if (arr.length <= 1) continue;
            // 残すイベント: 参照数が最大→同数なら updated が新しい
            const sorted = arr.slice().sort((a,b) => {
                const ua = usage.get(a.id || '') || 0;
                const ub = usage.get(b.id || '') || 0;
                if (ua !== ub) return ub - ua;
                const ma = a.updated ? moment(a.updated) : moment(0);
                const mb = b.updated ? moment(b.updated) : moment(0);
                return mb.valueOf() - ma.valueOf();
            });
            const keep = sorted[0];
            const removes = sorted.slice(1);
            plans.push({ key, keep, removes });
        }

        const totalDupGroups = plans.length;
        const totalRemoves = plans.reduce((s,p) => s + p.removes.length, 0);
        console.log(`[Dedupe] 対象グループ: ${totalDupGroups}, 削除候補: ${totalRemoves}`);
        if (dryRun) {
            new Notice(`ドライラン: 重複 ${totalDupGroups} グループ、削除候補 ${totalRemoves} 件`, 8000);
            plans.slice(0, 10).forEach(p => console.log(`[Dedupe] keep=${p.keep.id} removes=${p.removes.map(r=>r.id).join(',')}`));
            return;
        }

        // 実行: マッピング更新と削除
        const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(this.plugin.settings.calendarId)}/events`;
        const batch: BatchRequestItem[] = [];
        const taskMap = this.plugin.settings.taskMap || {};
        for (const p of plans) {
            const keepId = p.keep.id!;
            for (const r of p.removes) {
                const rid = r.id!;
                // taskMapの参照を差し替え
                Object.entries(taskMap).forEach(([obsId, gId]) => {
                    if (gId === rid) taskMap[obsId] = keepId;
                });
                const headers: Record<string, string> = {};
                if (r.etag) headers['If-Match'] = r.etag;
                batch.push({ method: 'DELETE', path: `${calendarPath}/${encodeURIComponent(rid)}`, headers, operationType: 'delete' });
            }
        }

        if (batch.length === 0) {
            new Notice('重複は見つからない。', 4000);
            return;
        }

        const bp = new BatchProcessor(this.plugin.settings);
        const result = await this.executeBatchesWithRetry(batch, bp);
        await this.plugin.saveData(this.plugin.settings); // 更新されたtaskMapを保存
        new Notice(`重複整理完了: 削除 ${result.deleted}, スキップ ${result.skipped}, エラー ${result.errors}`, 8000);
    }
}
