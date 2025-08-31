import { Notice } from 'obsidian';
import moment from 'moment';
import { calendar_v3 } from 'googleapis';

export class ErrorHandler {
    static showError(message: string, duration = 10000): void {
        console.error(message);
        new Notice(message, duration);
    }

    static showWarning(message: string, duration = 7000): void {
        console.warn(message);
        new Notice(message, duration);
    }

    static showInfo(message: string, duration = 5000): void {
        console.log(message);
        new Notice(message, duration);
    }
}

export class DateUtils {
    static parseDate(dateStr: string, format?: string): moment.Moment {
        return format ? moment(dateStr, format, true) : moment(dateStr);
    }

    static formatDuration(start: moment.Moment, end: moment.Moment): number {
        return moment.duration(end.diff(start)).asSeconds();
    }

    static isSameOrBefore(date1: string, date2: string): boolean {
        return moment(date1).isSameOrBefore(moment(date2));
    }

    static isSameDateTime(dt1: string | undefined, dt2: string | undefined): boolean {
        if (!dt1 && !dt2) return true;
        if (!dt1 || !dt2) return false;
        return moment(dt1).isSame(moment(dt2));
    }
}

// 管理印・指紋ユーティリティ
export class FingerprintUtils {
    static reminderFingerprint(x: { reminders?: { useDefault?: boolean | null; overrides?: Array<{ method?: string | null; minutes?: number | null }> | null } }): string {
        const useDefault = x.reminders?.useDefault ?? undefined;
        const overridesRaw = x.reminders?.overrides ?? undefined;
        const overrides = (overridesRaw || []).map(o => ({ method: o?.method ?? 'popup', minutes: o?.minutes ?? 0 }));
        if (useDefault === undefined && overrides.length === 0) return 'N';
        if (useDefault) return 'DEF';
        if (!overrides.length) return 'OFF';
        const sig = overrides.map(o => `${o.method}:${o.minutes}`).sort().join(',');
        return `OVR(${sig})`;
    }

    static identityKeyFromEvent(ev: calendar_v3.Schema$Event, includeDesc = false, includeRem = false): string {
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
        const rec = (ev.recurrence || []).map(r => String(r).toUpperCase().trim()).sort().join(';');
        const descK = includeDesc ? `|D|${(ev.description || '').trim()}` : '';
        const remK = includeRem ? `|M|${this.reminderFingerprint(ev as any)}` : '';
        return `S|${sum}|A|${startK}|B|${endK}|R|${rec}|Z|${stat}${descK}${remK}`;
    }
}

export class TaskMapUtils {
    static updateTaskMap(
        taskMap: Record<string, string>,
        obsidianTaskId: string,
        googleEventId: string
    ): void {
        if (obsidianTaskId && googleEventId) {
            taskMap[obsidianTaskId] = googleEventId;
        }
    }

    static removeFromTaskMap(
        taskMap: Record<string, string>,
        obsidianTaskId: string
    ): void {
        if (obsidianTaskId) {
            delete taskMap[obsidianTaskId];
        }
    }
}
