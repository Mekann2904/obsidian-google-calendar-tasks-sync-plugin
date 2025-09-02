import type GoogleCalendarTasksSyncPlugin from '../main';
import { Notice } from 'obsidian';

export function registerCommands(plugin: GoogleCalendarTasksSyncPlugin): void {
    plugin.addCommand({
        id: 'authenticate-with-google',
        name: 'Google で認証する',
        callback: () => plugin.authService.authenticate(),
    });

    plugin.addCommand({
        id: 'sync-tasks-now',
        name: 'Google Calendar と今すぐタスクを同期する',
        callback: async () => plugin.triggerSync(),
    });

    plugin.addCommand({
        id: 'dedupe-cleanup-dry-run',
        name: '重複イベントを整理（ドライラン）',
        callback: async () => {
            if (plugin.isCurrentlySyncing()) { new Notice('処理中のため実行できない。'); return; }
            await plugin.syncLogic.runDedupeCleanup(true);
        }
    });

    plugin.addCommand({
        id: 'dedupe-cleanup-exec',
        name: '重複イベントを整理（実行）',
        callback: async () => {
            if (plugin.isCurrentlySyncing()) { new Notice('処理中のため実行できない。'); return; }
            const ok = confirm('重複イベントの削除を実行しますか？ この操作は元に戻せません。');
            if (!ok) return;
            await plugin.syncLogic.runDedupeCleanup(false);
        }
    });
}
