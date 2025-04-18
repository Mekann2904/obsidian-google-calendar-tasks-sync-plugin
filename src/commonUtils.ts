import { Notice } from 'obsidian';
import moment from 'moment';

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
