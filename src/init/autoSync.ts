import moment from 'moment';
import type GoogleCalendarTasksSyncPlugin from '../main';

export function setupAutoSyncTimer(plugin: GoogleCalendarTasksSyncPlugin): void {
    plugin.clearAutoSync();
    if (plugin.settings.autoSync && plugin.settings.syncIntervalMinutes >= 1) {
        const intervalMillis = plugin.settings.syncIntervalMinutes * 60 * 1000;
        console.log(`自動同期を ${plugin.settings.syncIntervalMinutes} 分ごとに設定します。`);
        plugin.syncIntervalId = window.setInterval(async () => {
            const timestamp = moment().format('HH:mm:ss');
            console.log(`[${timestamp}] 自動同期トリガー`);
            if (plugin.isCurrentlySyncing()) {
                console.warn(`[${timestamp}] 自動同期スキップ: 実行中`);
                return;
            }
            if (!plugin.settings.tokens) {
                console.warn(`[${timestamp}] 自動同期スキップ: 未認証`);
                return;
            }
            const tokenReady = await plugin.authService.ensureAccessToken();
            if (!tokenReady) {
                console.warn(`[${timestamp}] 自動同期スキップ: トークン取得失敗`);
                return;
            }
            console.log(`[${timestamp}] 自動同期実行中...`);
            await plugin.syncLogic.runSync(JSON.parse(JSON.stringify(plugin.settings)));
            console.log(`[${timestamp}] 自動同期完了`);
        }, intervalMillis);
        console.log(`自動同期タイマー開始 (ID: ${plugin.syncIntervalId})。初回実行は約 ${moment().add(intervalMillis, 'ms').format('HH:mm')}。`);
    } else {
        console.log(`自動同期は無効です (有効: ${plugin.settings.autoSync}, 間隔: ${plugin.settings.syncIntervalMinutes} 分)。`);
    }
}
