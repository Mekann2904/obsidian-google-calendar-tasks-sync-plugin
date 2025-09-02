// __tests__/taskParser.spec.ts
import { describe, test, expect } from 'vitest';
import { parseTasksFromMarkdown } from '../src/taskParser';

type Task = any;

const input = `
- [ ] テスト1 🛫 2025-08-31 📅 2025-08-31 
      終日
- [ ] テスト2🛫 2025-08-31 12:00 📅 2025-08-31 
      12:00~24:00
- [ ] テスト3🛫 2025-08-31 17:00 📅 2025-08-31 23:00
      17:00~23:00
- [ ] テスト4🛫 2025-08-31 📅 2025-09-02 🔁 every day 13:00~16:00
      08/31 , 09/01 , 09/02 ３日間にたいして13:00~16:00
- [ ] テスト5🛫 2025-08-31 📅 2025-09-15🔁 every week on Sunday 08:00~10:00
- [ ] テスト6🛫 2025-08-31 
      これは作成されない
- [ ] テスト7📅 2025-08-31 
      終日

\`\`\`
- [ ] テスト8📅 2025-08-31 
      これは作成されない
      コードブロックはスキップ
\`\`\`

- [x] テスト9 📅 2025-08-31 ✅ 2025-09-02
      完了扱いに

- [ ] テスト10 🛫 2025-08-31 📅 2025-09-01
      テスト10の詳細... インデントで #tag10a
      ここもテスト10の詳細 #tag10b
\t- [ ] テスト11 🛫 2025-08-31 📅 2025-09-01

- [ ] テスト12 🛫 2025-08-31 📅 2025-08-31
      09:00 to 10:00

- [ ] テスト13 📅 2025-08-31 全日

- [ ] テスト14 📅 2025-08-31 all day
- [ ] テスト15🛫 2025-08-31 15:00 📅 2025-08-31
`.trim();

function bySummary(tasks: Task[], summary: string): Task {
  const t = tasks.find(x => x.summary === summary);
  if (!t) throw new Error(`Task not found: ${summary}`);
  return t;
}

describe('TaskParser: 正しく解釈できること', () => {
  test('サンプル入力をパース', () => {
    const tasks = parseTasksFromMarkdown(input) as Task[];

    const t1 = bySummary(tasks, 'テスト1');
    expect(t1.startDate).toBe('2025-08-31');
    expect(t1.dueDate).toBe('2025-08-31');

    const t2 = bySummary(tasks, 'テスト2');
    expect(t2.timeWindowStart).toBe('12:00');
    expect(t2.timeWindowEnd).toBe('24:00');

    const t3 = bySummary(tasks, 'テスト3');
    expect(t3.timeWindowStart).toBe('17:00');
    expect(t3.timeWindowEnd).toBe('23:00');

    const t4 = bySummary(tasks, 'テスト4');
    expect(t4.startDate).toBe('2025-08-31');
    expect(t4.dueDate).toBe('2025-09-02');
    expect(t4.timeWindowStart).toBe('13:00');
    expect(t4.timeWindowEnd).toBe('16:00');

    const t5 = bySummary(tasks, 'テスト5');
    expect(t5.startDate).toBe('2025-08-31');
    expect(t5.dueDate).toBe('2025-09-15');
    expect(t5.timeWindowStart).toBe('08:00');
    expect(t5.timeWindowEnd).toBe('10:00');

    const t6 = bySummary(tasks, 'テスト6');
    expect(t6.startDate).toBe('2025-08-31');
    expect(t6.dueDate).toBeNull();

    const t7 = bySummary(tasks, 'テスト7');
    expect(t7.startDate).toBe('2025-08-31');
    expect(t7.dueDate).toBe('2025-08-31');

    expect(() => bySummary(tasks, 'テスト8')).toThrow(/not found/);

    const t9 = bySummary(tasks, 'テスト9');
    expect(t9.isCompleted).toBe(true);

    const t10 = bySummary(tasks, 'テスト10');
    expect(t10.startDate).toBe('2025-08-31');
    expect(t10.dueDate).toBe('2025-09-01');
    // カレンダー説明（extraDetail相当）に継続行が含まれる
    const notes10 = (t10.extraDetail || t10.notes || '') as string;
    expect(notes10).toMatch(/テスト10の詳細\.\.\. インデントで/);
    expect(notes10).toMatch(/ここもテスト10の詳細/);
    expect(notes10).not.toMatch(/テスト11/);
    const tags10 = (t10.tags || []) as string[];
    expect(tags10).toEqual(expect.arrayContaining(['tag10a', 'tag10b']));

    const t11 = bySummary(tasks, 'テスト11');
    expect(t11.startDate).toBe('2025-08-31');
    expect(t11.dueDate).toBe('2025-09-01');
    const t12 = tasks.find((x: any) => String(x.summary).startsWith('テスト12')) as any;
    expect(t12).toBeTruthy();
    expect(t12.timeWindowStart).toBe('09:00');
    expect(t12.timeWindowEnd).toBe('10:00');
    const t13 = bySummary(tasks, 'テスト13');
    expect(t13.summary).toBe('テスト13');
    const t14 = bySummary(tasks, 'テスト14');
    expect(t14.summary).toBe('テスト14');

    const t15 = bySummary(tasks, 'テスト15');
    expect(t15.startDate).toBe('2025-08-31 15:00');
    expect(t15.dueDate).toBe('2025-08-31');
    expect(t15.timeWindowStart).toBe('15:00');
    expect(t15.timeWindowEnd).toBe('24:00');
  });
});
