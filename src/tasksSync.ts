import { App } from 'obsidian';
import GoogleCalendarTasksSyncPlugin from './main';
import { GoogleTasksService } from './tasksApi';

interface NestedTaskNode {
  title: string;
  notes?: string;
  children: NestedTaskNode[];
  indent: number;
}

export class TasksSync {
  constructor(private app: App, private plugin: GoogleCalendarTasksSyncPlugin, private gtasks: GoogleTasksService) {}

  async syncNestedToGoogleTasks(): Promise<void> {
    const trees = await this.collectNestedTasks();
    for (const tree of trees) {
      if (tree.children.length === 0) continue;
      const listId = await this.gtasks.getOrCreateList(tree.title);
      const items = tree.children.map(c => ({ title: c.title, notes: c.notes }));
      await this.gtasks.upsertTasks(listId, items);
    }
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
          const node: NestedTaskNode = { title, notes: undefined, children: [], indent };

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
}

