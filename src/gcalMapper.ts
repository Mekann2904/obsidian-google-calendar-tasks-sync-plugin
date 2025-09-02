import { App } from 'obsidian';
import moment from 'moment';
import { ObsidianTask, GoogleCalendarEventInput, GoogleCalendarTasksSyncSettings } from './types';
import { FingerprintUtils } from './commonUtils';
import { rrulestr } from 'rrule';

export class GCalMapper {
    private app: App;
    private settings: GoogleCalendarTasksSyncSettings;

    constructor(app: App, settings: GoogleCalendarTasksSyncSettings) {
        this.app = app;
        this.settings = settings;
    }

    /**
     * ObsidianTask オブジェクトを Google Calendar イベントの入力オブジェクトに変換します。
     * @param {ObsidianTask} task 変換する Obsidian タスク
     * @returns {GoogleCalendarEventInput} Google Calendar API 用のイベントオブジェクト
     */
    mapObsidianTaskToGoogleEvent(task: ObsidianTask): GoogleCalendarEventInput {
        const event: GoogleCalendarEventInput = {
            summary: task.summary || '無題のタスク',
            extendedProperties: {
                private: {
                    obsidianTaskId: task.id,
                    isGcalSync: 'true',
                    appId: 'obsidian-gcal-tasks',
                    version: '1',
                    isCompleted: task.isCompleted ? 'true' : 'false',
                }
            },
            description: this.buildEventDescription(task),
            // 完了＝キャンセルではない。イベント自体は confirmed を維持する。
            status: 'confirmed',
        };

        // 開始日と期限日が存在する場合のみ時間を設定 (syncLogicでフィルタされるはず)
        if (task.startDate && task.dueDate) {
            this.setEventTimeUsingStartDue(event, task);
        } else {
            // 予期せぬケース：フィルタを通過したが日付がない場合
            console.warn(`タスク "${task.summary || task.id}" は開始日または期限日が欠落しているため、デフォルトの終日イベントとして設定されます (予期せぬケース)。`);
            this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 開始日/期限日の欠落)`;
        }

        

        // リマインダーを scheduledDate から設定、またはデフォルトを設定
        if (event.start) {
            // ローカル壁時計として扱う（toEventDateTime もローカル＋timeZone を送るため整合）
            const eventStartMoment = event.start.dateTime
                ? moment(event.start.dateTime)
                : moment(event.start.date + 'T00:00:00');

            let reminderMoment: moment.Moment | null = null;

            if (task.scheduledDate) {
                // ⏳ が指定されている場合、その日時を使用
                // ⏳ はローカル前提（UTCにしない）
                reminderMoment = moment(task.scheduledDate, [moment.ISO_8601, 'YYYY-MM-DD'], true);
                if (!reminderMoment.isValid()) {
                    console.warn(`タスク "${task.summary}" のリマインダー日時 (scheduledDate) のパースに失敗しました。`);
                    reminderMoment = null;
                }
            } else {
                // ⏳ がない場合、デフォルトでイベント開始の前日に設定
                reminderMoment = eventStartMoment.clone().subtract(1, 'day');
                console.log(`タスク "${task.summary}" にデフォルトリマインダー（1日前）を設定します。`);
            }

            if (reminderMoment && eventStartMoment.isValid()) {
                const diffMinutes = eventStartMoment.diff(reminderMoment, 'minutes');

                if (diffMinutes > 0) {
                    event.reminders = {
                        useDefault: false,
                        overrides: [{ method: 'popup', minutes: diffMinutes }],
                    };
                    console.log(`タスク "${task.summary}" に ${diffMinutes} 分前のリマインダーを設定しました。`);
                } else {
                    console.warn(`タスク "${task.summary}" のリマインダー時刻 (${reminderMoment.toISOString()}) がイベント開始時刻 (${eventStartMoment.toISOString()}) 以降のため、リマインダーは設定されません。`);
                }
            }
        }

        // localFp を付与（説明/リマインダーは設定で可変）
        const includeDesc = !!this.settings.includeDescriptionInIdentity;
        const includeRem  = !!this.settings.includeReminderInIdentity;
        const fpEvent = {
            summary: event.summary,
            description: includeDesc ? event.description : undefined,
            start: event.start,
            end: event.end,
            status: event.status,
            recurrence: event.recurrence,
            reminders: includeRem ? event.reminders : undefined,
        } as GoogleCalendarEventInput;
        const localFp = FingerprintUtils.identityKeyFromEvent(fpEvent as any, includeDesc, includeRem);
        (event.extendedProperties!.private as any).localFp = localFp;

        return event;
    }

    /**
     * Google Calendar イベントの説明欄の内容を生成します。
     */
    private buildEventDescription(task: ObsidianTask): string {
        let descParts: string[] = [];
        try {
            const vaultName = this.app.vault.getName();
            const encodedVault = encodeURIComponent(vaultName);
            const encodedPath = encodeURIComponent(task.sourcePath);
            let fileParam = encodedPath;
            if (task.blockLink) {
                // アンカーも含めて file= の値としてURLエンコード
                fileParam = encodeURIComponent(`${task.sourcePath}#${task.blockLink}`);
            }
            descParts.push(`Obsidian ノート: obsidian://open?vault=${encodedVault}&file=${fileParam}`);
        } catch (e) {
            console.warn("Obsidian URI の生成に失敗しました", e);
            descParts.push(`Obsidian ソース: "${task.sourcePath}" (Line ${task.sourceLine + 1})`);
        }

        let metaParts: string[] = [];
        // 継続行の自由記述があれば先頭に差し込む
        if (task.extraDetail && task.extraDetail.trim().length > 0) {
            metaParts.push(task.extraDetail.trim());
        }
        if (this.settings.syncPriorityToDescription && task.priority) {
            const priorityMap = { highest: '🔺 最高', high: '⏫ 高', medium: '🔼 中', low: '🔽 低', lowest: '⏬ 最低' };
            metaParts.push(`優先度: ${priorityMap[task.priority] || task.priority}`);
        }
        if (this.settings.syncTagsToDescription && task.tags.length > 0) {
            metaParts.push(`タグ: ${task.tags.map(t => `#${t}`).join(' ')}`);
        }
        if (task.createdDate) {
            metaParts.push(`作成日: ${task.createdDate}`);
        }
        if (this.settings.syncScheduledDateToDescription && task.scheduledDate) {
            metaParts.push(`予定日: ${task.scheduledDate}`);
        }
        if (task.completionDate && task.isCompleted) {
            metaParts.push(`完了日: ${task.completionDate}`);
        }

        if (metaParts.length > 0) {
            descParts.push('---');
            descParts.push(...metaParts);
        }

        return descParts.join('\n');
    }

    /**
     * タスクの開始日と期限日を使用してイベントの時間を設定します。
     */
    private setEventTimeUsingStartDue(event: GoogleCalendarEventInput, task: ObsidianTask): void {
        const startStr = task.startDate!;
        const dueStr = task.dueDate!;

        const startMoment = moment(startStr, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
        const dueMoment = moment(dueStr, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);

        if (!startMoment.isValid() || !dueMoment.isValid()) {
            console.error(`Date parse error for task "${task.summary || task.id}". Defaulting time.`);
            this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付パース失敗)`;
            return;
        }

        const winStart = (task.timeWindowStart || '').trim();
        const winEnd = (task.timeWindowEnd || '').trim();
        const hasWindow = /^\d{1,2}:\d{2}$/.test(winStart) && /^(\d{1,2}:\d{2}|24:00)$/.test(winEnd);
        const hasRecurrence = task.recurrenceRule && !task.isCompleted;

        const toMomentAt = (d: moment.Moment, hhmm: string): moment.Moment => {
            const [h, m] = hhmm.split(':').map(v => parseInt(v, 10));
            return d.clone().hour(h).minute(m).second(0).millisecond(0);
        };

        // First, set the start and end times.
        if (hasWindow) {
            // Timed event with a window.
            const startDay = startMoment;
            const startDateTime = toMomentAt(startDay, winStart);
            
            const endIs24h = winEnd === '24:00';
            // For recurring events, end time is based on start day. For non-recurring, on due date.
            const baseEndDay = hasRecurrence ? startDay : dueMoment;
            const endDateTime = endIs24h
                ? toMomentAt(baseEndDay.clone().add(1, 'day'), '00:00')
                : toMomentAt(baseEndDay, winEnd);

            event.start = this.toEventDateTime(startDateTime);
            event.end   = this.toEventDateTime(
                endDateTime.isSameOrBefore(startDateTime)
                ? startDateTime.clone().add(this.settings.defaultEventDurationMinutes, 'minutes')
                : endDateTime
            );

        } else {
            // All-day or timed event without a time window
            const startIsDateTime = /(T|\s)\d{1,2}:\d{2}/.test(startStr);
            const dueIsDateTime = /(T|\s)\d{1,2}:\d{2}/.test(dueStr);

            if (startIsDateTime || dueIsDateTime) {
                // Timed event
                event.start = this.toEventDateTime(startMoment);
                event.end = this.toEventDateTime(dueMoment);
                if (dueMoment.isSameOrBefore(startMoment)) {
                    event.end = this.toEventDateTime(startMoment.clone().add(this.settings.defaultEventDurationMinutes, 'minutes'));
                }
            } else {
                // All-day event
                event.start = { date: startMoment.format('YYYY-MM-DD') };
                const endDateMoment = dueMoment.clone().add(1, 'day');
                event.end = { date: endDateMoment.format('YYYY-MM-DD') };

                if (endDateMoment.isSameOrBefore(startMoment)) {
                    event.end = { date: startMoment.clone().add(1, 'day').format('YYYY-MM-DD') };
                }
            }
        }

        // Second, set the recurrence rule if it exists.
        if (hasRecurrence && event.start) {
            const raw = String(task.recurrenceRule).trim();
            const upper = raw.replace(/\r/g, '\n').toUpperCase();
            const rruleLine = upper.match(/RRULE:[^\n]+/)?.[0]
                           ?? (/^FREQ=/.test(upper) ? `RRULE:${upper}` : upper.replace(/DTSTART:[^\n]+\n?/g, '').trim());
            let normalized = rruleLine.startsWith('RRULE:') ? rruleLine : `RRULE:${rruleLine}`;

            try {
                // First, calculate the day span (inclusive).
                const daySpanCount = Math.max(
                    1,
                    dueMoment.clone().startOf('day').diff(startMoment.clone().startOf('day'), 'days') + 1
                );

                // For FREQ=DAILY without COUNT/UNTIL, always set COUNT to the day span.
                if (/FREQ=DAILY/.test(normalized) && !/COUNT=|UNTIL=/.test(normalized)) {
                    normalized = `${normalized};COUNT=${daySpanCount}`;
                } else if (!/COUNT=|UNTIL=/.test(normalized)) {
                    // For weekly/monthly, count occurrences using rrule with robust boundary handling.
                    const dtstart = event.start.dateTime
                        ? moment(event.start.dateTime).toDate()
                        : moment(event.start.date, 'YYYY-MM-DD').startOf('day').toDate();

                    const until = moment(task.dueDate!, [moment.ISO_8601, 'YYYY-MM-DD'], true)
                        .endOf('day')
                        .toDate();

                    const set: any = rrulestr(normalized, { dtstart, forceset: true });
                    const all: Date[] = (typeof set.all === 'function') ? set.all() : (set['rrules']?.[0]?.all?.() ?? []);
                    const count = all.filter((d: Date) => d >= dtstart && d <= until).length;
                    if (count > 0) {
                        normalized = `${normalized};COUNT=${count}`;
                    }
                }

                // Calculate dtstart for validation
                const dtstart = event.start.dateTime
                    ? moment(event.start.dateTime).toDate()
                    : moment(event.start.date, 'YYYY-MM-DD').startOf('day').toDate();

                // Final validation (dtstart is passed for proper validation)
                rrulestr(normalized, { dtstart });

                // Only send RRULE (Google Calendar API uses start/end fields as DTSTART)
                event.recurrence = [normalized];
            } catch (e) {
                console.warn(`Invalid RRULE (${normalized}). Skipping recurrence.`, e);
                delete event.recurrence;
            }
        } else {
            delete event.recurrence;
        }

        // Final cleanup
        if (event.start?.dateTime && (event.start as any).date) delete (event.start as any).date;
        if (event.end?.dateTime && (event.end as any).date) delete (event.end as any).date;

        // Final check for validity
		if (!event.start || !event.end ||
            (!event.start.date && !event.start.dateTime) ||
            (!event.end.date && !event.end.dateTime)) {
             console.error(`タスク "${task.summary || task.id}" は無効な開始/終了時間になりました。デフォルトにフォールバックします。`, event);
             this.setDefaultEventTime(event);
             event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付処理エラー)`;
        }

        console.log('[GCalMapper] start=%s end=%s recurrence=%o',
            event.start?.dateTime ?? event.start?.date,
            event.end?.dateTime ?? event.end?.date,
            event.recurrence);
    }

    public toEventDateTime(m: moment.Moment): { dateTime: string; timeZone: string } {
        // Always send local wall-clock without offset, plus explicit IANA timeZone.
        const dateTime = m.format('YYYY-MM-DDTHH:mm:ss');
        let timeZone: string | undefined = undefined;
        try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
        if (!timeZone || typeof timeZone !== 'string' || timeZone.trim().length === 0) {
            // Fallback (should rarely happen)
            timeZone = 'UTC';
        }
        return { dateTime, timeZone };
    }

    /**
     * イベントにデフォルトの終日イベント時間 (今日) を設定します。
     */
    private setDefaultEventTime(event: GoogleCalendarEventInput): void {
        const today = moment().format('YYYY-MM-DD'); // ローカル今日
        event.start = { date: today };
        event.end = { date: moment(today).add(1, 'day').format('YYYY-MM-DD') };
        delete event.start?.dateTime;
        delete event.end?.dateTime;
    }
}
