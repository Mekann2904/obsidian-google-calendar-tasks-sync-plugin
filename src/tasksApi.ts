import { tasks_v1, google } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';

export class GoogleTasksService {
    private plugin: GoogleCalendarTasksSyncPlugin;
    private tasks: tasks_v1.Tasks | null = null;

    constructor(plugin: GoogleCalendarTasksSyncPlugin) {
        this.plugin = plugin;
    }

    ensureClient(): void {
        if (!this.plugin.oauth2Client) return;
        if (!this.tasks) {
            this.tasks = google.tasks({ version: 'v1', auth: this.plugin.oauth2Client });
        }
    }

    async getOrCreateList(title: string): Promise<string> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');

        // 既存のタスクリストを検索（同名）
        const res = await this.tasks.tasklists.list({ maxResults: 100 });
        const items = res.data.items || [];
        const found = items.find(i => i.title === title);
        if (found?.id) return found.id;

        // 作成
        const created = await this.tasks.tasklists.insert({ requestBody: { title } });
        if (!created.data.id) throw new Error('Google Tasks リスト作成に失敗');
        return created.data.id;
    }

    async upsertTasks(listId: string, tasks: Array<{ title: string; notes?: string }>): Promise<void> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');

        for (const t of tasks) {
            await this.tasks.tasks.insert({ tasklist: listId, requestBody: { title: t.title, notes: t.notes } });
        }
    }
}

