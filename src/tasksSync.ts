import { App } from 'obsidian';
import GoogleCalendarTasksSyncPlugin from './main';
import { GoogleTasksService } from './tasksApi';

interface NestedTaskNode {
  title: string;
  notes?: string;
  children: NestedTaskNode[];
  indent: number;
  id: string;
  path: string;
}

export class TasksSync {
  constructor(private app: App, private plugin: GoogleCalendarTasksSyncPlugin, private gtasks: GoogleTasksService) {}

  async syncNestedToGoogleTasks(): Promise<void> {
    const trees = await this.collectNestedTasks();
    const settings = this.plugin.settings;
    settings.tasksListMap = settings.tasksListMap || {};
    settings.tasksItemMap = settings.tasksItemMap || {};

    for (const tree of trees) {
      if (tree.children.length === 0) continue;

      // 親→リストIDの確定（ローカル優先：タイトルが変わっていたらリネーム）
      let listId = settings.tasksListMap![tree.id];
      if (listId) {
        try {
          // 既存リストのタイトルをローカルに合わせる
          await this.gtasks.renameList(listId, tree.title);
        } catch {
          // 404 等は作り直し
          listId = await this.gtasks.getOrCreateList(tree.title);
          settings.tasksListMap![tree.id] = listId;
        }
      } else {
        listId = await this.gtasks.getOrCreateList(tree.title);
        settings.tasksListMap![tree.id] = listId;
      }

      // リモートの既存タスク一覧（重複抑止・再利用）
      const remote = await this.gtasks.listTasks(listId);
      const remoteById = new Map<string, tasks_v1.Schema$Task>();
      const remoteByTitle = new Map<string, tasks_v1.Schema$Task>();
      for (const t of remote) { if (t.id) remoteById.set(t.id, t); if (t.title) remoteByTitle.set(t.title, t); }

      // ローカル子の集合
      const localChildIds = new Set<string>(tree.children.map(c => c.id));

      // アップサート（ローカル優先）
      for (const child of tree.children) {
        let gid = settings.tasksItemMap![child.id];
        if (gid && remoteById.has(gid)) {
          await this.gtasks.upsertTasks(listId!, [{ id: gid, title: child.title, notes: child.notes }]);
        } else {
          // タイトル一致の既存があれば再利用
          const dup = remoteByTitle.get(child.title);
          if (dup?.id) {
            settings.tasksItemMap![child.id] = dup.id;
            await this.gtasks.upsertTasks(listId!, [{ id: dup.id, title: child.title, notes: child.notes }]);
          } else {
            await this.gtasks.upsertTasks(listId!, [{ title: child.title, notes: child.notes }]);
            // 新規挿入のID取得は batch では困難なため、簡易に再取得してマッピング（少数前提）
            const refreshed = await this.gtasks.listTasks(listId!);
            const found = refreshed.find(t => t.title === child.title && (t.notes || '') === (child.notes || ''));
            if (found?.id) settings.tasksItemMap![child.id] = found.id;
          }
        }
      }

      // リモート削除（ローカルに無い子で、当方マップ管理対象のみ）
      for (const [obsChildId, googleTaskId] of Object.entries(settings.tasksItemMap!)) {
        if (!localChildIds.has(obsChildId)) continue; // 別の親のもの
      }
      // 上のループは親区別が無いので、親の子だけのサブマップを作る
      const childMapEntries = Object.entries(settings.tasksItemMap!).filter(([cid]) => localChildIds.has(cid));
      for (const [cid, googleTaskId] of childMapEntries) {
        const stillExists = tree.children.some(c => c.id === cid);
        if (!stillExists && googleTaskId) {
          try { await this.gtasks.deleteTask(listId!, googleTaskId); } catch {}
          delete settings.tasksItemMap![cid];
        }
      }
    }

    await this.plugin.saveData(settings);
  }

  private async collectNestedTasks(): Promise<NestedTaskNode[]> {
    const out: NestedTaskNode[] = [];
    const files = this.app.vault.getMarkdownFiles();
    const checkboxRe = /^(\s*)-\s*\[(.| )\]\s*(.*)$/;
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      const stack: NestedTaskNode[] = [];
      let inFence = false;
      const fenceOpenRe = /^\s*(`{3,}|~{3,})/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fm = line.match(fenceOpenRe);
        if (fm) { inFence = !inFence; continue; }
        if (inFence) continue;

        const m = line.match(checkboxRe);
        if (m) {
          const indent = m[1].length;
          const title = (m[3] || '').trim();
          const id = this.makeId(file.path, i, line);
          const node: NestedTaskNode = { title, notes: undefined, children: [], indent, id, path: file.path };

          while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
          if (stack.length === 0) {
            out.push(node);
          } else {
            stack[stack.length - 1].children.push(node);
            // 直後の説明行を notes として収集（次のチェックボックス or 空行まで）
            const notes: string[] = [];
            let j = i + 1;
            while (j < lines.length && !checkboxRe.test(lines[j]) && lines[j].trim() !== '') {
              notes.push(lines[j].trim());
              j++;
            }
            if (notes.length) node.notes = notes.join('\n');
          }
          stack.push(node);
        }
      }
    }
    // 親となりうるノードのみ返す（直下に子があるもの）
    return out.filter(n => n.children.length > 0);
  }

  private makeId(path: string, index: number, line: string): string {
    let hash = 0;
    const raw = line.trim();
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch; hash |= 0;
    }
    return `obsidian-${path}-${index}-${hash}`;
  }
}
