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

    async listLists(maxResults: number = 100): Promise<tasks_v1.Schema$TaskList[]> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        const res = await this.tasks.tasklists.list({ maxResults });
        return res.data.items || [];
    }

    async getList(listId: string): Promise<tasks_v1.Schema$TaskList | null> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        try {
            const res = await this.tasks.tasklists.get({ tasklist: listId });
            return res.data || null;
        } catch (e: any) {
            // 404などは null 扱い
            return null;
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

    async listTasks(listId: string): Promise<tasks_v1.Schema$Task[]> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        const res = await this.tasks.tasks.list({ tasklist: listId, maxResults: 200 });
        return res.data.items || [];
    }

    async upsertTasks(listId: string, tasks: Array<{ id?: string; title: string; notes?: string; due?: string; parentId?: string }>): Promise<void> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');

        for (const t of tasks) {
            if (t.id) {
                await this.tasks.tasks.patch({ tasklist: listId, task: t.id, requestBody: { title: t.title, notes: t.notes, due: t.due } });
                if (t.parentId) {
                    // 親の変更は move API を使用
                    await this.tasks.tasks.move({ tasklist: listId, task: t.id, parent: t.parentId });
                }
            } else {
                await this.tasks.tasks.insert({ tasklist: listId, parent: t.parentId, requestBody: { title: t.title, notes: t.notes, due: t.due } });
            }
        }
    }

    async deleteTask(listId: string, taskId: string): Promise<void> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        await this.tasks.tasks.delete({ tasklist: listId, task: taskId });
    }

    async renameList(listId: string, newTitle: string): Promise<void> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        await this.tasks.tasklists.patch({ tasklist: listId, requestBody: { title: newTitle } });
    }

    async deleteList(listId: string): Promise<void> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        await this.tasks.tasklists.delete({ tasklist: listId });
    }

    async ensureMarkerTask(listId: string, parentObsidianId: string): Promise<string> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        const markerTitle = '[ogcts:list-marker]';
        const markerNotes = `[ogcts] appId=obsidian-gcal-tasks isGtasksSync=true parentObsidianTaskId=${parentObsidianId} version=1`;
        const items = await this.listTasks(listId);
        const found = items.find(t => t.title === markerTitle && (t.notes || '').includes(`parentObsidianTaskId=${parentObsidianId}`));
        if (found?.id) return found.id;
        const created = await this.tasks.tasks.insert({ tasklist: listId, requestBody: { title: markerTitle, notes: markerNotes } });
        return created.data.id!;
    }

    async findListByMarker(parentObsidianId: string): Promise<string | undefined> {
        this.ensureClient();
        if (!this.tasks) throw new Error('Google Tasks API クライアント未初期化');
        const lists = await this.tasks.tasklists.list({ maxResults: 100 });
        for (const l of lists.data.items || []) {
            if (!l.id) continue;
            try {
                const items = await this.tasks.tasks.list({ tasklist: l.id, maxResults: 50 });
                const found = (items.data.items || []).some(t => (t.title === '[ogcts:list-marker]') && (t.notes || '').includes(`parentObsidianTaskId=${parentObsidianId}`));
                if (found) return l.id;
            } catch { /* ignore */ }
        }
        return undefined;
    }
}
