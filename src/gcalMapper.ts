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
                }
            },
            description: this.buildEventDescription(task),
            status: task.isCompleted ? 'cancelled' : 'confirmed',
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

        // 繰り返しルール
        if (!task.isCompleted && task.recurrenceRule && event.start) { // 未完了でルールと開始時間がある場合のみ
            // RRULE 正規化: 複数行や先頭に DTSTART が付く表現を許容し、RRULE 行のみ抽出
            const raw = String(task.recurrenceRule).trim();
            const upper = raw.replace(/\r/g, '\n').toUpperCase();
            const rruleLineMatch = upper.match(/RRULE:[^\n]+/);
            let normalized = '';
            if (rruleLineMatch) normalized = rruleLineMatch[0];
            else if (/^FREQ=/.test(upper)) normalized = `RRULE:${upper}`;
            else normalized = upper.replace(/DTSTART:[^\n]+\n?/g, '').trim();
            if (normalized && !normalized.startsWith('RRULE:')) normalized = `RRULE:${normalized}`;
            try {
                rrulestr(normalized); // パース可能かチェック
                event.recurrence = [normalized];
            } catch (e) {
                console.warn(`タスク "${task.summary || task.id}" の無効な RRULE 文字列(正規化後): ${normalized}。繰り返しをスキップします。`, e);
                delete event.recurrence;
            }
        } else {
            delete event.recurrence; // 完了済み、ルールなし、または開始時間がない場合は削除
        }

        // リマインダーを scheduledDate から設定、またはデフォルトを設定
        if (event.start) {
            const eventStartMoment = event.start.dateTime
                ? moment.utc(event.start.dateTime)
                : moment.utc(event.start.date).startOf('day');

            let reminderMoment: moment.Moment | null = null;

            if (task.scheduledDate) {
                // ⏳ が指定されている場合、その日時を使用
                reminderMoment = moment.utc(task.scheduledDate, [moment.ISO_8601, 'YYYY-MM-DD'], true);
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
            let linkSuffix = '';
            if (task.blockLink) {
                linkSuffix = `#${task.blockLink}`;
            }
            descParts.push(`Obsidian ノート: obsidian://open?vault=${encodedVault}&file=${encodedPath}${linkSuffix}`);
        } catch (e) {
            console.warn("Obsidian URI の生成に失敗しました", e);
            descParts.push(`Obsidian ソース: "${task.sourcePath}" (Line ${task.sourceLine + 1})`);
        }

        let metaParts: string[] = [];
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
        const startStr = task.startDate!; // null でないことは呼び出し元で保証される想定
        const dueStr = task.dueDate!;   // null でないことは呼び出し元で保証される想定

        // 'YYYY-MM-DD HH:mm' も時刻付きとして認識する
        const hasTime = (s: string) => /(T|\s)\d{1,2}:\d{2}/.test(s);
        const startIsDateTime = hasTime(startStr);
        const dueIsDateTime = hasTime(dueStr);

        // moment.utc を使用し、厳密なパースを行う
        const startMoment = moment(startStr, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
        const dueMoment = moment(dueStr, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);

        if (!startMoment.isValid() || !dueMoment.isValid()) {
            console.error(`タスク "${task.summary || task.id}" の日付パース失敗 (setEventTimeUsingStartDue)。Start: ${startStr}, Due: ${dueStr}。時間をデフォルト設定します。`);
            this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付パース失敗)`;
            return;
        }

        if (!startIsDateTime || !dueIsDateTime) {
            // 🔁拡張: 時間ウィンドウが指定されている場合は時間指定イベントにする
            const winStart = (task.timeWindowStart || '').trim();
            const winEnd = (task.timeWindowEnd || '').trim();
            const hasWindow = /^\d{1,2}:\d{2}$/.test(winStart) && /^(\d{1,2}:\d{2}|24:00)$/.test(winEnd);

            const toMomentAt = (d: moment.Moment, hhmm: string): moment.Moment => {
                const [h, m] = hhmm.split(':').map(v => parseInt(v,10));
                return d.clone().hour(h).minute(m).second(0).millisecond(0);
            };

            if (hasWindow) {
                // 時間ウィンドウがある場合は必ず時間指定イベントにする
                const isDaily = (task.recurrenceRule || '').toUpperCase().includes('FREQ=DAILY');
                event.start = this.toEventDateTime(toMomentAt(startMoment, winStart));
                if (winEnd === '24:00') {
                    // 24:00 は翌日 00:00
                    const baseEndDay = isDaily ? startMoment.clone().add(1,'day')
                                               : (dueMoment.isSame(startMoment,'day') ? startMoment.clone().add(1,'day')
                                                                                      : dueMoment.clone().add(1,'day'));
                    event.end = this.toEventDateTime(toMomentAt(baseEndDay, '00:00'));
                } else {
                    const baseEndDay = isDaily ? startMoment : dueMoment;
                    event.end = this.toEventDateTime(toMomentAt(baseEndDay, winEnd));
                }
            } else if (startIsDateTime && !dueIsDateTime && startMoment.isSame(dueMoment, 'day')) {
                // 仕様: 開始に時刻・終了が日付のみ（同日）の場合は 24:00 まで
                event.start = this.toEventDateTime(startMoment);
                event.end = this.toEventDateTime(startMoment.clone().add(1,'day').startOf('day'));
            } else {
                // 終日イベント
                event.start = { date: startMoment.format('YYYY-MM-DD') };
                // GCal APIでは終日イベントの終了日は exclusive なので、dueMoment の *翌日* を指定
                const endDate = dueMoment.add(1, 'day').format('YYYY-MM-DD');
                event.end = { date: endDate };

                if (moment.utc(event.end.date).isSameOrBefore(moment.utc(event.start.date))) {
                    console.warn(`タスク "${task.summary || task.id}": 終日イベントの終了日(${dueMoment.subtract(1, 'day').format('YYYY-MM-DD')})が開始日(${startMoment.format('YYYY-MM-DD')})以前。終了日を開始日の翌日に設定。`);
                    event.end = { date: startMoment.clone().add(1, 'day').format('YYYY-MM-DD') };
                }
            }
        } else {
            // 時間指定イベント
            event.start = this.toEventDateTime(startMoment);
            event.end = this.toEventDateTime(dueMoment);

            if (dueMoment.isSameOrBefore(startMoment)) {
                console.warn(`タスク "${task.summary || task.id}": 終了時刻 (${dueMoment.toISOString()}) が開始時刻 (${startMoment.toISOString()}) 以前。デフォルト期間 (${this.settings.defaultEventDurationMinutes}分) を使用して調整します。`);
                event.end = this.toEventDateTime(startMoment.clone().add(this.settings.defaultEventDurationMinutes, 'minutes'));
            }
        }

        // RRULE の期間限定補助: "every day" かつ COUNT/UNTILなし、start/due が日付の範囲の場合は COUNT を補う
        if (task.recurrenceRule && event.start?.dateTime && (!task.startDate?.includes('T') || !task.dueDate?.includes('T'))) {
            const rule = (task.recurrenceRule || '').toUpperCase();
            if (rule.includes('FREQ=DAILY') && !/;COUNT=|;UNTIL=/.test(rule) && task.startDate && task.dueDate) {
                const s = moment(task.startDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).startOf('day');
                const e = moment(task.dueDate, [moment.ISO_8601, 'YYYY-MM-DD'], true).startOf('day');
                const days = e.diff(s, 'days') + 1; // 期間を含める
                if (days > 0) {
                    event.recurrence = [ `RRULE:FREQ=DAILY;COUNT=${days}` ];
                }
            }
        }

        // dateTime があれば date をクリア（Google 側の解釈ブレを防止）
        if (event.start?.dateTime && (event.start as any).date) delete (event.start as any).date;
        if (event.end?.dateTime && (event.end as any).date) delete (event.end as any).date;

        // 最終チェック
		if (!event.start || !event.end ||
            (!event.start.date && !event.start.dateTime) ||
            (!event.end.date && !event.end.dateTime)) {
             console.error(`タスク "${task.summary || task.id}" は無効な開始/終了時間になりました。デフォルトにフォールバックします。`, event);
             this.setDefaultEventTime(event);
             event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付処理エラー)`;
        }
    }

    private toEventDateTime(m: moment.Moment): { dateTime: string; timeZone?: string } {
        // Google Calendar API は dateTime と timeZone の組合せを許容。
        // 互換性のため、offset なしのローカル表記 + IANA timeZone を送る。
        const dateTime = m.format('YYYY-MM-DDTHH:mm:ss');
        let timeZone: string | undefined = undefined;
        try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
        return timeZone ? { dateTime, timeZone } : { dateTime };
    }

    /**
     * イベントにデフォルトの終日イベント時間 (今日) を設定します。
     */
    private setDefaultEventTime(event: GoogleCalendarEventInput): void {
        const today = moment.utc().format('YYYY-MM-DD');
        event.start = { date: today };
        event.end = { date: moment.utc(today).add(1, 'day').format('YYYY-MM-DD') };
        delete event.start?.dateTime;
        delete event.end?.dateTime;
    }
}
