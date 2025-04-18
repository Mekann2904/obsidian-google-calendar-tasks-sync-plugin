import { App } from 'obsidian';
import moment from 'moment';
import { RRule, RRuleSet, rrulestr, Frequency, Options as RRuleOptions, Weekday } from 'rrule';
import { ObsidianTask } from './types';

export class TaskParser {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Vault 内のすべての Markdown ファイルからタスクを抽出します。
     * 'templates/' パスを含むファイルはスキップします。
     * @returns {Promise<ObsidianTask[]>} 解析されたタスクの配列
     */
    async getObsidianTasks(): Promise<ObsidianTask[]> {
        console.time("getObsidianTasks");
        const tasks: ObsidianTask[] = [];
        const mdFiles = this.app.vault.getMarkdownFiles();

        const filePromises = mdFiles.map(async (file) => {
            if (file.path.toLowerCase().includes('templates/')) {
                return [];
            }
            try {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const fileTasks: ObsidianTask[] = [];
                lines.forEach((line, index) => {
                    const task = this.parseObsidianTask(line, file.path, index);
                    if (task) {
                        fileTasks.push(task);
                    }
                });
                return fileTasks;
            } catch (e) {
                console.warn(`ファイル "${file.path}" の読み込み/解析ができませんでした`, e);
                return [];
            }
        });

        const results = await Promise.all(filePromises);
        results.forEach(fileTasks => tasks.push(...fileTasks));

        console.timeEnd("getObsidianTasks");
        console.log(`Vault 内で ${tasks.length} 個のタスクが見つかりました。`);
        return tasks;
    }

    /**
     * Markdown の1行を解析して ObsidianTask オブジェクトに変換します。
     * @param {string} line 解析する行のテキスト
     * @param {string} filePath タスクが含まれるファイルのパス
     * @param {number} lineNumber タスクが含まれるファイルの行番号 (0-based)
     * @returns {ObsidianTask | null} 解析されたタスクオブジェクト、またはタスクでない場合は null
     */
    parseObsidianTask(line: string, filePath: string, lineNumber: number): ObsidianTask | null {
        const taskRegex = /^\s*-\s*\[(.)\]\s*(.*)/;
        const match = line.match(taskRegex);
        if (!match) return null;

        const checkbox = match[1].trim();
        let taskContent = match[2].trim();
        const isCompleted = checkbox !== ' ' && checkbox !== '';

        const isoOrSimpleDateRegex = `\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?`;
        const simpleDateRegexOnly = `\\d{4}-\\d{2}-\\d{2}`;

        // メタデータの抽出関数
        const extractMetadata = (content: string, pattern: RegExp): { value: string | null, remainingContent: string } => {
            const m = content.match(pattern);
            if (m && m[1]) {
                const fullMatch = m[0]; // マッチした全体 (e.g., "📅 2023-12-25")
                const value = m[1]; // キャプチャグループの値 (e.g., "2023-12-25")
                return { value, remainingContent: content.replace(fullMatch, '').trim() };
            }
            return { value: null, remainingContent: content };
        };

        let remainingContent = taskContent;
        let dueDate: string | null = null;
        let startDate: string | null = null;
        let scheduledDate: string | null = null;
        let createdDate: string | null = null;
        let completionDate: string | null = null;
        let priority: ObsidianTask['priority'] = null;
        let recurrenceRuleText: string | null = null;
        let blockLink: string | null = null;

        // 日付を抽出
        ({ value: dueDate, remainingContent } = extractMetadata(remainingContent, new RegExp(`(?:📅|due:)\\s*(${isoOrSimpleDateRegex})`)));
        ({ value: startDate, remainingContent } = extractMetadata(remainingContent, new RegExp(`(?:🛫|start:)\\s*(${isoOrSimpleDateRegex})`)));
        ({ value: scheduledDate, remainingContent } = extractMetadata(remainingContent, new RegExp(`(?:⏳|scheduled:)\\s*(${isoOrSimpleDateRegex})`)));
        ({ value: createdDate, remainingContent } = extractMetadata(remainingContent, new RegExp(`(?:➕|created:)\\s*(${simpleDateRegexOnly})`)));
        ({ value: completionDate, remainingContent } = extractMetadata(remainingContent, new RegExp(`(?:✅|done:)\\s*(${simpleDateRegexOnly})`)));

        // 優先度を抽出
        const priorityMatch = remainingContent.match(/(?:🔺|⏫|🔼|🔽|⏬)/);
        const priorityEmoji = priorityMatch ? priorityMatch[0] : null;
        if (priorityEmoji) {
            switch (priorityEmoji) {
                case '🔺': priority = 'highest'; break;
                case '⏫': priority = 'high'; break;
                case '🔼': priority = 'medium'; break;
                case '🔽': priority = 'low'; break;
                case '⏬': priority = 'lowest'; break;
            }
            remainingContent = remainingContent.replace(priorityEmoji, '').trim();
        }

        // 繰り返しルールを抽出
        ({ value: recurrenceRuleText, remainingContent } = extractMetadata(remainingContent, /(?:🔁|repeat:|recur:)\s*([^📅🛫⏳➕✅🔺⏫🔼🔽⏬#^]+)/));

        // ブロックリンクを抽出 (行末)
        const blockLinkMatch = remainingContent.match(/\s+(\^[a-zA-Z0-9-]+)$/);
        if (blockLinkMatch) {
            blockLink = blockLinkMatch[1];
            remainingContent = remainingContent.replace(blockLinkMatch[0], '').trim();
        }

        // タグを抽出
        const tagsMatch = remainingContent.match(/#[^\s#]+/g);
        const tags = tagsMatch ? tagsMatch.map(t => t.substring(1)) : [];
        if (tagsMatch) {
            tagsMatch.forEach(tag => {
                remainingContent = remainingContent.replace(tag, '');
            });
        }

        // サマリー: 残った内容を整理
        const summary = remainingContent.replace(/\s{2,}/g, ' ').trim();

        // 繰り返しルールを解析
        const recurrenceRefDate = startDate || dueDate || scheduledDate;
        const recurrenceRule = recurrenceRuleText ? this.parseRecurrenceRule(recurrenceRuleText, recurrenceRefDate) : null;

        // タスクID生成
        const rawTextForHash = line.trim();
        let hash = 0;
        for (let i = 0; i < rawTextForHash.length; i++) {
            const char = rawTextForHash.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        const taskId = `obsidian-${filePath}-${lineNumber}-${hash}`;

        return {
            id: taskId,
            rawText: line,
            summary: summary || "無題のタスク",
            isCompleted: isCompleted,
            dueDate: dueDate,
            startDate: startDate,
            scheduledDate: scheduledDate,
            createdDate: createdDate,
            completionDate: completionDate,
            priority: priority,
            recurrenceRule: recurrenceRule,
            tags: tags,
            blockLink: blockLink,
            sourcePath: filePath,
            sourceLine: lineNumber
        };
    }

    /**
     * 繰り返しルールのテキストを解析し、iCalendar RRULE 文字列に変換。
     */
     parseRecurrenceRule(ruleText: string, dtstartHint: string | null): string | null {
        ruleText = ruleText.trim(); // 元のケースを保持してパースを試みる
        let finalRruleString: string | null = null;

        // 既存の RRULE 文字列を優先的にパース
        if (ruleText.toUpperCase().startsWith('RRULE:') || ruleText.toUpperCase().startsWith('FREQ=')) {
            try {
                const ruleInput = ruleText.toUpperCase().startsWith('RRULE:') ? ruleText : `RRULE:${ruleText}`;
                const rule = rrulestr(ruleInput, { forceset: true });

                // DTSTART の処理
                if (!rule.options.dtstart && dtstartHint) {
                    const pDate = moment(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true).utc();
                    if(pDate.isValid()) {
                        rule.options.dtstart = pDate.toDate();
                    } else {
                         // ヒントが無効な場合は今日の日付を使用
                        console.warn(`RRULE 解析のための無効な dtstartHint "${dtstartHint}"。今日を使用します。`);
                        rule.options.dtstart = moment().startOf('day').toDate(); // ローカルタイムの今日
                    }
                } else if (!rule.options.dtstart) {
                    rule.options.dtstart = moment().startOf('day').toDate(); // ローカルタイムの今日
                    console.warn(`RRULE "${ruleText}" に DTSTART がありません。今日を使用します。`);
                }
                finalRruleString = rule.toString(); // DTSTART が追加された可能性のある RRULE 文字列
                return finalRruleString; // パース成功したら返す
            } catch (e) {
                console.warn(`直接的な RRULE パースに失敗: "${ruleText}"`, e);
                // 失敗したら自然言語パースへフォールバック
            }
        }

        // --- 自然言語パース (フォールバック) ---
         ruleText = ruleText.toLowerCase(); // 自然言語は小文字で処理
        let dtstartDate: Date;
        if (dtstartHint) {
            const pDate = moment.utc(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true);
            dtstartDate = pDate.isValid() ? pDate.toDate() : moment().startOf('day').toDate(); // UTC or Local Today
        } else {
            dtstartDate = moment().startOf('day').toDate(); // Local Today
        }

        let options: Partial<RRuleOptions> = { dtstart: dtstartDate };
        let freq: Frequency | null = null;
        let interval = 1;

        const intMatch = ruleText.match(/every\s+(\d+)\s+(day|week|month|year)s?/);
        if (intMatch) {
            interval = parseInt(intMatch[1], 10);
            const unit = intMatch[2];
            if (unit === 'day') freq = Frequency.DAILY;
            else if (unit === 'week') freq = Frequency.WEEKLY;
            else if (unit === 'month') freq = Frequency.MONTHLY;
            else if (unit === 'year') freq = Frequency.YEARLY;
        } else {
            const simpleIntMatch = ruleText.match(/every\s+(day|week|month|year)s?/);
            if (simpleIntMatch) {
                interval = 1;
                const unit = simpleIntMatch[1];
                if (unit === 'day') freq = Frequency.DAILY;
                else if (unit === 'week') freq = Frequency.WEEKLY;
                else if (unit === 'month') freq = Frequency.MONTHLY;
                else if (unit === 'year') freq = Frequency.YEARLY;
            } else {
                if (ruleText.includes('daily')) freq = Frequency.DAILY;
                else if (ruleText.includes('weekly')) freq = Frequency.WEEKLY;
                else if (ruleText.includes('monthly')) freq = Frequency.MONTHLY;
                else if (ruleText.includes('yearly') || ruleText.includes('annually')) freq = Frequency.YEARLY;

                const altIntMatch = ruleText.match(/every\s*(\d+)\s*weeks?/);
                if (altIntMatch && freq === Frequency.WEEKLY) {
                    interval = parseInt(altIntMatch[1], 10);
                }
            }
        }

        // 修飾子 (簡単なもののみ)
        if (freq === Frequency.MONTHLY) {
            const dMatch = ruleText.match(/on the\s+(\d+)(?:st|nd|rd|th)?/);
            if (dMatch) {
                const day = parseInt(dMatch[1], 10);
                if (day >= 1 && day <= 31) options.bymonthday = [day];
            }
        }
        if (freq === Frequency.WEEKLY) {
            const wdMap: { [k: string]: Weekday } = { mon: RRule.MO, tue: RRule.TU, wed: RRule.WE, thu: RRule.TH, fri: RRule.FR, sat: RRule.SA, sun: RRule.SU };
            const wds: Weekday[] = [];
            if (ruleText.includes('weekday')) wds.push(RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR);
            else if (ruleText.includes('weekend')) wds.push(RRule.SA, RRule.SU);
            else {
                Object.keys(wdMap).forEach(dayKey => {
                    if (ruleText.includes(dayKey)) {
                        const rDay = wdMap[dayKey];
                        if (!wds.some(ex => ex.weekday === rDay.weekday)) {
                            wds.push(rDay);
                        }
                    }
                });
            }
            if (wds.length > 0) options.byweekday = wds;
        }

        if (freq !== null) {
            options.freq = freq;
            options.interval = interval > 0 ? interval : 1;
            try {
                // RRuleOptions にキャストする際に不足している必須プロパティがないか確認
                const finalOptions: RRuleOptions = {
                    freq: options.freq,
                    dtstart: options.dtstart || new Date(), // dtstart は必須
                    interval: options.interval,
                    wkst: options.wkst ?? null,
                    count: options.count ?? null,
                    until: options.until ?? null,
                    tzid: options.tzid ?? null,
                    bysetpos: options.bysetpos ?? null,
                    bymonth: options.bymonth ?? null,
                    bymonthday: options.bymonthday ?? null,
                    byyearday: options.byyearday ?? null,
                    byweekno: options.byweekno ?? null,
                    byweekday: options.byweekday ?? null,
                    byhour: options.byhour ?? null,
                    byminute: options.byminute ?? null,
                    bysecond: options.bysecond ?? null,
                    byeaster: options.byeaster ?? null,
                    bynmonthday: null,
                    bynweekday: null,
                };
                const rule = new RRule(finalOptions);
                finalRruleString = rule.toString();
            } catch (e) {
                console.warn(`解析されたオプションからの RRULE 生成に失敗:`, options, e);
                finalRruleString = null;
            }
        } else {
            console.warn(`ルールテキストから頻度を決定できませんでした: "${ruleText}"`);
            finalRruleString = null;
        }
        return finalRruleString;
    }
}
