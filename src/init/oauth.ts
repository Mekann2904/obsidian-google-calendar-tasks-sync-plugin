import type GoogleCalendarTasksSyncPlugin from '../main';

export async function initializeOAuth(plugin: GoogleCalendarTasksSyncPlugin): Promise<void> {
    if (!plugin.settings.useLoopbackServer) {
        console.log("'useLoopbackServer' を true に強制します (唯一のサポート方法)。");
        plugin.settings.useLoopbackServer = true;
    }

    plugin.authService.reconfigureOAuthClient();
    plugin.authService.initializeCalendarApi();

    await plugin.httpServerManager.stopServer();
    plugin.httpServerManager.startServer();
}
