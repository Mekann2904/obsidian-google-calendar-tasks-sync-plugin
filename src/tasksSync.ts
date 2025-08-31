import { App } from 'obsidian';
import { tasks_v1 } from 'googleapis';
import GoogleCalendarTasksSyncPlugin from './main';
import { GoogleTasksService } from './tasksApi';

interface NestedTaskNode {
  title: string;
  notes?: string;
  children: NestedTaskNode[];
  indent: number;
  id: string;
  path: string;
  done: boolean;
  startDate?: string | null;
  dueDate?: string | null;
}

export class TasksSync {
  constructor(private app: App, private plugin: GoogleCalendarTasksSyncPlugin, private gtasks: GoogleTasksService) {}

  async syncNestedToGoogleTasks(): Promise<void> {
    const trees = await this.collectNestedTasks();
    const settings = this.plugin.settings;
    settings.tasksListMap = settings.tasksListMap || {};
    settings.tasksItemMap = settings.tasksItemMap || {};

    // リモートインデックスを構築（管理マーカーに基づく全件スキャン）
    const remoteIndex = await this.buildRemoteIndex();
    // 設定マップを最新の検出結果で更新（壊れているIDを自然修復）
    for (const [pid, lid] of Object.entries(remoteIndex.parentToList)) settings.tasksListMap[pid] = lid;
    for (const [cid, tid] of Object.entries(remoteIndex.childToTask)) settings.tasksItemMap[cid] = tid;

    // ローカルに親が一つも無い（全削除）場合、管理対象の全リストを削除
    const localParentIds = new Set<string>(trees.map(t => t.id));
    if (localParentIds.size === 0 && Object.keys(remoteIndex.parentToList).length > 0) {
      for (const [pid, lid] of Object.entries(remoteIndex.parentToList)) {
        try { await this.gtasks.deleteList(lid); } catch {}
        delete settings.tasksListMap![pid];
      }
      await this.plugin.saveData(settings);
      return; // すべて削除したので今回の同期は終了
    }

    // ローカルに存在しない親のリストは削除（部分的な全削除）
    for (const [pid, lid] of Object.entries(remoteIndex.parentToList)) {
      if (!localParentIds.has(pid)) {
        try { await this.gtasks.deleteList(lid); } catch {}
        delete settings.tasksListMap![pid];
      }
    }

    for (const tree of trees) {
      if (tree.children.length === 0) continue;
      // 親タスクの条件: 🛫 と 📅 がある（同一日である必要はない）
      const startMatch = tree.title.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
      const dueMatch = tree.title.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
      if (!startMatch || !dueMatch) continue;

      // 親→リストIDの確定（マップIDの有効性検証→マーカー検索→作成）
      let listId = await this.ensureListForParent(tree.id, tree.title);

      // リモートの既存タスク一覧（重複抑止・再利用）
      let remote: tasks_v1.Schema$Task[] = [];
      try {
        remote = await this.gtasks.listTasks(listId);
      } catch (e: any) {
        // ステールな listId の可能性（404）。マーカー検出→作成へフォールバック
        try {
          listId = await this.ensureListForParent(tree.id, tree.title);
          remote = await this.gtasks.listTasks(listId);
        } catch {
          // フォールバック失敗時はこの親をスキップ
          continue;
        }
      }
      const remoteById = new Map<string, tasks_v1.Schema$Task>();
      const remoteByTitle = new Map<string, tasks_v1.Schema$Task>();
      for (const t of remote) {
        if (t.id) remoteById.set(t.id, t);
        if (t.title && this.isManagedTask(t)) remoteByTitle.set(t.title, t);
      }

      // ローカル子の集合
      const localChildIds = new Set<string>(tree.children.map(c => c.id));
      const reservedRemoteIds = new Set<string>();

      // 再帰的に（親→子→孫）を処理。due は親から継承
      const processNode = async (node: NestedTaskNode, parentTaskId: string | undefined, inheritedDue: string | undefined) => {
        if (node.done) {
          const gidDel = settings.tasksItemMap![node.id];
          if (gidDel) { try { await this.gtasks.deleteTask(listId!, gidDel); } catch {} delete settings.tasksItemMap![node.id]; }
          return;
        }
        const effectiveDue = node.dueDate || inheritedDue;
        const dueIso = effectiveDue ? new Date(`${effectiveDue}T23:59:00`).toISOString() : undefined;

        let gid = settings.tasksItemMap![node.id];
        if (gid && remoteById.has(gid)) {
          await this.gtasks.upsertTasks(listId!, [{ id: gid, title: node.title, notes: this.buildManagedNotes(node.notes, node.id), due: dueIso, parentId: parentTaskId }]);
          reservedRemoteIds.add(gid);
        } else {
          const dup = remoteByTitle.get(node.title);
          if (dup?.id) {
            settings.tasksItemMap![node.id] = dup.id;
            await this.gtasks.upsertTasks(listId!, [{ id: dup.id, title: node.title, notes: this.buildManagedNotes(node.notes, node.id), due: dueIso, parentId: parentTaskId }]);
            gid = dup.id;
            reservedRemoteIds.add(dup.id);
          } else {
            await this.gtasks.upsertTasks(listId!, [{ title: node.title, notes: this.buildManagedNotes(node.notes, node.id), due: dueIso, parentId: parentTaskId }]);
            const refreshed = await this.gtasks.listTasks(listId!);
            const found = refreshed.find(t => t.title === node.title && (t.notes || '').includes(`obsidianTaskId=${node.id}`));
            if (found?.id) { gid = settings.tasksItemMap![node.id] = found.id; reservedRemoteIds.add(found.id); }
          }
        }
        for (const childNode of node.children) {
          await processNode(childNode, gid, effectiveDue);
        }
      };

      for (const child of tree.children) {
        await processNode(child, undefined, tree.dueDate || startMatch[1]);
      }

      // 不要なリモート（今回の同期で予約されなかった管理タスク）だけ削除
      for (const t of remote) {
        if (!this.isManagedTask(t) || !t.id) continue;
        if (t.title === '[ogcts:list-marker]') continue;
        if (!reservedRemoteIds.has(t.id)) {
          try { await this.gtasks.deleteTask(listId!, t.id); } catch {}
        }
      }

      // 子が全て完了ならリストを削除
      const anyActive = tree.children.some(c => !this.isAllDoneRecursive(c));
      if (!anyActive) {
        try { await this.gtasks.deleteList(listId!); } catch {}
        delete settings.tasksListMap![tree.id];
      }
    }

    await this.plugin.saveData(settings);
  }

  private async buildRemoteIndex(): Promise<{ parentToList: Record<string, string>; childToTask: Record<string, string> }> {
    const parentToList: Record<string, string> = {};
    const childToTask: Record<string, string> = {};
    try {
      const lists = await this.gtasks.listLists(100);
      for (const l of lists) {
        if (!l.id) continue;
        let items: tasks_v1.Schema$Task[] = [];
        try { items = await this.gtasks.listTasks(l.id); } catch { continue; }
        const hasMarker = items.some(t => t.title === '[ogcts:list-marker]' && (t.notes || '').includes('[ogcts]'));
        if (!hasMarker) continue;
        const marker = items.find(t => t.title === '[ogcts:list-marker]' && (t.notes || '').includes('parentObsidianTaskId='));
        const pMatch = marker?.notes?.match(/parentObsidianTaskId=([^\s]+)/);
        const parentId = pMatch ? pMatch[1] : undefined;
        if (parentId) parentToList[parentId] = l.id;
        for (const t of items) {
          if (!this.isManagedTask(t) || !t.id || !t.notes) continue;
          const m = t.notes.match(/obsidianTaskId=([^\s]+)/);
          if (m) childToTask[m[1]] = t.id;
        }
      }
    } catch {}
    return { parentToList, childToTask };
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
          const mark = (m[2] || '').trim();
          const title = (m[3] || '').trim();
          const done = /x|X|✓|✔/.test(mark);
          const id = this.makeId(file.path, i, line);
          const node: NestedTaskNode = { title, notes: undefined, children: [], indent, id, path: file.path, done };
          const sm = title.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
          const dm = title.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
          node.startDate = sm ? sm[1] : null;
          node.dueDate = dm ? dm[1] : null;

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

  private isAllDoneRecursive(n: NestedTaskNode): boolean {
    if (!n) return true;
    if (!n.done) return false;
    return n.children.every(c => this.isAllDoneRecursive(c));
  }

  private async ensureListForParent(parentId: string, title: string): Promise<string> {
    const settings = this.plugin.settings;
    let listId = settings.tasksListMap?.[parentId];
    if (listId) {
      const ok = await this.gtasks.getList(listId);
      if (!ok) listId = undefined as any;
    }
    if (!listId) {
      listId = await this.gtasks.findListByMarker(parentId) || await this.gtasks.getOrCreateList(title);
      settings.tasksListMap![parentId] = listId;
      await this.plugin.saveData(settings);
    }
    // マーカーを確保
    try { await this.gtasks.ensureMarkerTask(listId, parentId); } catch {}
    return listId;
  }

  private buildManagedNotes(userNotes: string | undefined, obsidianTaskId: string): string {
    const meta = `[ogcts] appId=obsidian-gcal-tasks isGtasksSync=true obsidianTaskId=${obsidianTaskId} version=1`;
    return userNotes && userNotes.trim().length > 0 ? `${userNotes}\n\n${meta}` : meta;
  }

  private isManagedTask(t: tasks_v1.Schema$Task): boolean {
    return !!(t.notes && /\[ogcts\]\s+appId=obsidian-gcal-tasks/.test(t.notes));
  }
}
