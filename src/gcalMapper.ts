import { App } from 'obsidian';
import moment from 'moment';
import { ObsidianTask, GoogleCalendarEventInput, GoogleCalendarTasksSyncSettings } from './types';
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
                    isGcalSync: 'true'
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
            let rruleString = task.recurrenceRule.toUpperCase();
            if (!rruleString.startsWith('RRULE:')) {
                rruleString = `RRULE:${rruleString}`;
            }
            try {
                rrulestr(rruleString); // パース可能かチェック
                event.recurrence = [rruleString];
            } catch (e) {
                 console.warn(`タスク "${task.summary || task.id}" の無効な RRULE 文字列: ${task.recurrenceRule}。繰り返しをスキップします。`, e);
                 delete event.recurrence;
            }
        } else {
            delete event.recurrence; // 完了済み、ルールなし、または開始時間がない場合は削除
        }

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

        const startIsDateTime = startStr.includes('T');
        const dueIsDateTime = dueStr.includes('T');

        // moment.utc を使用し、厳密なパースを行う
        const startMoment = moment.utc(startStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);
        const dueMoment = moment.utc(dueStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);

        if (!startMoment.isValid() || !dueMoment.isValid()) {
            console.error(`タスク "${task.summary || task.id}" の日付パース失敗 (setEventTimeUsingStartDue)。Start: ${startStr}, Due: ${dueStr}。時間をデフォルト設定します。`);
            this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付パース失敗)`;
            return;
        }

        if (!startIsDateTime || !dueIsDateTime) {
            // 終日イベント
            event.start = { date: startMoment.format('YYYY-MM-DD') };
            // GCal APIでは終日イベントの終了日は exclusive なので、dueMoment の *翌日* を指定
            const endDate = dueMoment.add(1, 'day').format('YYYY-MM-DD');
            event.end = { date: endDate };

            if (moment.utc(event.end.date).isSameOrBefore(moment.utc(event.start.date))) {
                console.warn(`タスク "${task.summary || task.id}": 終日イベントの終了日(${dueMoment.subtract(1, 'day').format('YYYY-MM-DD')})が開始日(${startMoment.format('YYYY-MM-DD')})以前。終了日を開始日の翌日に設定。`);
                event.end = { date: startMoment.clone().add(1, 'day').format('YYYY-MM-DD') };
            }
        } else {
            // 時間指定イベント
            event.start = { dateTime: startMoment.toISOString(true) }; // keepOffset=true
            event.end = { dateTime: dueMoment.toISOString(true) };   // keepOffset=true

            if (dueMoment.isSameOrBefore(startMoment)) {
                console.warn(`タスク "${task.summary || task.id}": 終了時刻 (${dueMoment.toISOString()}) が開始時刻 (${startMoment.toISOString()}) 以前。デフォルト期間 (${this.settings.defaultEventDurationMinutes}分) を使用して調整します。`);
                event.end = { dateTime: startMoment.clone().add(this.settings.defaultEventDurationMinutes, 'minutes').toISOString(true) };
            }
        }

        // 最終チェック
		if (!event.start || !event.end ||
            (!event.start.date && !event.start.dateTime) ||
            (!event.end.date && !event.end.dateTime)) {
             console.error(`タスク "${task.summary || task.id}" は無効な開始/終了時間になりました。デフォルトにフォールバックします。`, event);
             this.setDefaultEventTime(event);
             event.description = (event.description || '') + `\n\n(注意: イベント時間はデフォルト設定 - 日付処理エラー)`;
        }
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
