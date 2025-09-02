import { Notice } from 'obsidian';
import moment from 'moment';
import { calendar_v3 } from 'googleapis';

export class ErrorHandler {
    private static lastShown = new Map<string, number>();

    private static show(message: string, duration: number, level: 'log'|'warn'|'error', dedupeMs = 1500) {
        const now = Date.now();
        const last = this.lastShown.get(message) ?? 0;
        if (now - last < dedupeMs) return;
        this.lastShown.set(message, now);

        console[level](message);
        new Notice(message, duration);
    }

    static showError(message: string, duration = 10000): void { this.show(message, duration, 'error'); }
    static showWarning(message: string, duration = 7000): void { this.show(message, duration, 'warn'); }
    static showInfo(message: string, duration = 5000): void { this.show(message, duration, 'log'); }
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

    // 秒精度・タイムゾーンオフセット維持で比較
    static isSameDateTime(
        dt1: string | undefined,
        dt2: string | undefined,
        unit: moment.unitOfTime.StartOf = 'second'
    ): boolean {
        if (!dt1 && !dt2) return true;
        if (!dt1 || !dt2) return false;
        const a = moment.parseZone(dt1);
        const b = moment.parseZone(dt2);
        if (!a.isValid() || !b.isValid()) return dt1 === dt2;
        return a.isSame(b, unit);
    }

    // Google EventDateTime 比較（終日/時刻の型差も吸収）
    static isSameEventDateTime(
        a?: calendar_v3.Schema$EventDateTime,
        b?: calendar_v3.Schema$EventDateTime
    ): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if ((a as any).date && (b as any).date) return (a as any).date === (b as any).date;
        if ((a as any).dateTime && (b as any).dateTime) {
            return DateUtils.isSameDateTime((a as any).dateTime, (b as any).dateTime);
        }
        return false;
    }
}

// 管理印・指紋ユーティリティ
export class FingerprintUtils {
    static reminderFingerprint(x: { reminders?: { useDefault?: boolean | null; overrides?: Array<{ method?: string | null; minutes?: number | null }> | null } }): string {
        const useDefault = x.reminders?.useDefault ?? undefined;
        const raw = x.reminders?.overrides ?? [];

        const norm = raw
            .map(o => ({
                method: String((o?.method ?? 'popup')).toLowerCase(),
                minutes: Number.isFinite(o?.minutes as any) ? Number(o?.minutes) : 0
            }))
            .reduce((acc, cur) => {
                const key = `${cur.method}:${cur.minutes}`;
                if (!acc.map.has(key)) { acc.map.set(key, true); acc.arr.push(cur); }
                return acc;
            }, { map: new Map<string, boolean>(), arr: [] as {method:string;minutes:number}[] }).arr
            .sort((a,b) => a.method === b.method ? a.minutes - b.minutes : a.method.localeCompare(b.method));

        if (useDefault === undefined && norm.length === 0) return 'N';
        if (useDefault) return 'DEF';
        if (!norm.length) return 'OFF';

        const sig = norm.map(o => `${o.method}:${o.minutes}`).join(',');
        return `OVR(${sig})`;
    }

    static identityKeyFromEvent(ev: calendar_v3.Schema$Event, includeDesc = false, includeRem = false): string {
        const sum = (ev.summary || '').trim().replace(/\s+/g, ' ');
        const keyTime = (t?: calendar_v3.Schema$EventDateTime) => {
            if (!t) return 'N';
            if ((t as any).date) return `D:${(t as any).date}`;
            if ((t as any).dateTime) return `T:${moment.parseZone((t as any).dateTime).toISOString(true)}`;
            return 'N';
        };
        const startK = keyTime(ev.start);
        const endK = keyTime(ev.end);
        const stat = (ev.status === 'cancelled') ? 'X' : 'C';
        const rec = (ev.recurrence || []).map(r => String(r).toUpperCase().replace(/^RRULE:/, '').trim()).sort().join(';');
        const descRaw = includeDesc ? (ev.description || '').trim() : '';
        const descK = includeDesc ? `|D|${descRaw.length > 256 ? descRaw.slice(0, 256) : descRaw}` : '';
        const remK = includeRem ? `|M|${this.reminderFingerprint(ev as any)}` : '';
        return `S|${sum}|A|${startK}|B|${endK}|R|${rec}|Z|${stat}${descK}${remK}`;
    }
}

export class TaskMapUtils {
    static updateTaskMap(
        taskMap: Record<string, string>,
        obsidianTaskId: string | undefined,
        googleEventId: string | undefined
    ): void {
        if (!obsidianTaskId || !googleEventId) return;
        if (taskMap[obsidianTaskId] === googleEventId) return;
        taskMap[obsidianTaskId] = googleEventId;
    }

    static removeFromTaskMap(
        taskMap: Record<string, string>,
        obsidianTaskId: string | undefined
    ): void {
        if (!obsidianTaskId) return;
        if (Object.prototype.hasOwnProperty.call(taskMap, obsidianTaskId)) delete taskMap[obsidianTaskId];
    }
}
