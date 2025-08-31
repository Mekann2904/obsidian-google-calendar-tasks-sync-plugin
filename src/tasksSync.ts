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
      // 設定マップに残っているが marker 走査に出なかった古いリストIDも削除対象
      for (const [pid, lid] of Object.entries(settings.tasksListMap || {})) {
        if (!(pid in remoteIndex.parentToList)) {
          try { await this.gtasks.deleteList(lid); } catch {}
          delete settings.tasksListMap![pid];
        }
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
    // 設定マップに残っているが、ローカルに存在しない親に紐づく古いリストIDも削除
    for (const [pid, lid] of Object.entries(settings.tasksListMap || {})) {
      if (!localParentIds.has(pid) && !(pid in remoteIndex.parentToList)) {
        // リモートに検出されない＝管理対象ではない／既に削除済みと解釈し、API呼び出しは行わずマップだけ掃除
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
      for (const t of remote) { if (t.id) remoteById.set(t.id, t); }

      // ローカル子の集合
      const localChildIds = new Set<string>(tree.children.map(c => c.id));
      const managedIdsForParent = new Set<string>();
      for (const cid of localChildIds) {
        const tid = settings.tasksItemMap![cid];
        if (tid) managedIdsForParent.add(tid);
      }
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
          await this.gtasks.patchTask(listId!, { id: gid, title: node.title, notes: this.buildManagedNotes(node.notes, node.id), due: dueIso });
          await this.gtasks.moveTask(listId!, gid, parentTaskId);
          reservedRemoteIds.add(gid);
        } else {
          // 既存IDがない/失効 → 新規作成
          gid = await this.gtasks.insertTask(listId!, { title: node.title, notes: this.buildManagedNotes(node.notes, node.id), due: dueIso, parentId: parentTaskId });
          settings.tasksItemMap![node.id] = gid;
          reservedRemoteIds.add(gid);
        }
        for (const childNode of node.children) {
          await processNode(childNode, gid, effectiveDue);
        }
      };

      for (const child of tree.children) {
        await processNode(child, undefined, tree.dueDate || startMatch[1]);
      }

      // 不要なリモート（今回の同期で予約されなかったタスク）を一括削除
      for (const t of remote) {
        if (!t.id) continue;
        if (reservedRemoteIds.has(t.id)) continue;
        try { await this.gtasks.deleteTask(listId!, t.id); } catch {}
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
    // マーカー/notes に依存しない設計へ移行: 自然修復は設定マップとローカルから行うため、ここでは空インデックスを返す
    return { parentToList: {}, childToTask: {} };
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
    // まずマーカーで検出（タイトルや古いIDに依存しない）
    let listId = await this.gtasks.findListByMarker(parentId);
    if (!listId) {
      // 見つからなければ作成
      listId = await this.gtasks.getOrCreateList(title);
      try { await this.gtasks.ensureMarkerTask(listId, parentId); } catch {}
    }
    settings.tasksListMap![parentId] = listId;
    await this.plugin.saveData(settings);
    return listId;
  }

  private buildManagedNotes(userNotes: string | undefined, _obsidianTaskId: string): string {
    // ユーザーが記述した notes のみを送る（管理マーカーは付与しない）
    return userNotes || '';
  }
}
