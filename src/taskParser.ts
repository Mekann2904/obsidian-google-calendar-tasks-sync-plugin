import { App } from 'obsidian';
import { createHash } from 'crypto';
import moment from 'moment';
import { RRule, RRuleSet, rrulestr, Frequency, Options as RRuleOptions, Weekday } from 'rrule';
import { ObsidianTask } from './types';

export class TaskParser {
    private app: App;
    private generateId(input: string): string {
        return createHash('sha1').update(input).digest('hex').slice(0, 8);
    }

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

        // 読み込み負荷のスロットリング（同時 16 本）
        const CONCURRENCY = 16;
        const chunks: typeof mdFiles[] = Array.from({ length: Math.ceil(mdFiles.length / CONCURRENCY) }, (_, i) => mdFiles.slice(i * CONCURRENCY, (i + 1) * CONCURRENCY));
        for (const group of chunks) {
            const results = await Promise.all(group.map(async (file) => {
                const normalized = file.path.replace(/\\/g, '/').toLowerCase();
                if (normalized.startsWith('templates/')) {
                    return [] as ObsidianTask[];
                }
                try {
                    const content = await this.app.vault.read(file);
                    const lines = content.split('\n');
                    const fileTasks: ObsidianTask[] = [];
                    // フェンスドコードブロック (``` や ~~~) 内は同期対象外
                    let inFence = false;
                    let fenceChar: '`' | '~' | '' = '';
                    let fenceLen = 0;
                    const fenceOpenRe = /^\s*(`{3,}|~{3,})/;
                    lines.forEach((line, index) => {
                        const open = line.match(fenceOpenRe);
                        if (open) {
                            const marker = open[1];
                            const ch = marker[0] as '`' | '~';
                            const len = marker.length;
                            if (!inFence) { inFence = true; fenceChar = ch; fenceLen = len; return; }
                            if (inFence && fenceChar === ch && len >= fenceLen) { inFence = false; fenceChar = ''; fenceLen = 0; return; }
                        }

                        if (inFence) return; // コードブロック内は無視

                        // 継続行（連続するインデント行）を結合（時間帯/🔁/終日は結合、その他は自由記述として収集）
                        let combined = line;
                        let extraDetailFromNext: string | null = null;
                        const details: string[] = [];
                        const SUBTASK_RE = /^\s*-\s*\[[ xX]\]/; // ネストしたタスク
                        const CONTROL_RE = /(?:\d{1,2}:\d{2})\s*(?:-|–|—|~|〜|～|to)\s*(?:\d{1,2}:\d{2}|24:00)|🔁|(?:終日|全日|all[-\s]?day)/iu;
                        let k = index + 1;
                        while (k < lines.length && /^\s+/.test(lines[k])) {
                            const raw = lines[k];
                            const trimmed = raw.trim();
                            if (trimmed.length === 0) { k++; continue; }
                            if (SUBTASK_RE.test(trimmed)) break; // サブタスク開始で親の連結は終わり
                            if (CONTROL_RE.test(trimmed)) {
                                combined = `${combined} ${trimmed}`;
                            } else {
                                details.push(trimmed);
                            }
                            k++;
                        }
                        if (details.length > 0) extraDetailFromNext = details.join('\n');

                        const task = this.parseObsidianTask(combined, file.path, index);
                        if (task) {
                            if (extraDetailFromNext && !task.extraDetail) task.extraDetail = extraDetailFromNext;
                            // インデント側の #tag を反映
                            if (extraDetailFromNext) {
                                const extraTags = extraDetailFromNext.match(/#[^\s#]+/g) || [];
                                if (extraTags.length) {
                                    const merged = new Set([...(task.tags || []), ...extraTags.map(t => t.slice(1))]);
                                    task.tags = Array.from(merged);
                                }
                            }
                            fileTasks.push(task);
                        }
                    });
                    return fileTasks;
                } catch (e) {
                    console.warn(`ファイル "${file.path}" の読み込み/解析ができませんでした`, e);
                    return [] as ObsidianTask[];
                }
            }));
            results.forEach(fileTasks => tasks.push(...fileTasks));
        }

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
        const isCompleted = /^(x|X|✓)$/.test(checkbox);

        // FIX: ISO拡張の余計な空白を除去し、秒・小数秒・タイムゾーンを正しくオプショナルに
        // 拡張: 'YYYY-MM-DD HH:mm' 形式も許容（T または空白区切り）
        const isoOrSimpleDateRegex = `\\d{4}-\\d{2}-\\d{2}(?:[T\\s]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?`;
        const simpleDateRegexOnly = `\\d{4}-\\d{2}-\\d{2}`;

        // メタデータの抽出（最後の出現を採用）
        const extractLast = (content: string, pattern: RegExp): { value: string | null, remainingContent: string } => {
            let flags = pattern.flags;
            if (!flags.includes('g')) flags += 'g';
            if (!flags.includes('u')) flags += 'u';
            const re = new RegExp(pattern.source, flags);
            let m: RegExpExecArray | null;
            let last: RegExpExecArray | null = null;
            while ((m = re.exec(content))) last = m;
            if (last && last[1]) {
                const value = last[1];
                const before = content.slice(0, last.index);
                const after = content.slice(last.index + last[0].length);
                return { value, remainingContent: (before + after).trim() };
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
        let timeWindowStart: string | null = null;
        let timeWindowEnd: string | null = null;
        let blockLink: string | null = null;

        // 日付を抽出（Unicode フラグを追加して絵文字を正しく処理）
        ({ value: dueDate, remainingContent } = extractLast(remainingContent, new RegExp(`(?:📅|due:)\\s*(${isoOrSimpleDateRegex})`, 'u')));
        ({ value: startDate, remainingContent } = extractLast(remainingContent, new RegExp(`(?:🛫|start:)\\s*(${isoOrSimpleDateRegex})`, 'u')));
        ({ value: scheduledDate, remainingContent } = extractLast(remainingContent, new RegExp(`(?:⏳|scheduled:)\\s*(${isoOrSimpleDateRegex})`, 'u')));
        ({ value: createdDate, remainingContent } = extractLast(remainingContent, new RegExp(`(?:➕|created:)\\s*(${simpleDateRegexOnly})`, 'u')));
        ({ value: completionDate, remainingContent } = extractLast(remainingContent, new RegExp(`(?:✅|done:)\\s*(${simpleDateRegexOnly})`, 'u')));

        // 優先度を抽出（Unicode フラグを追加）
        const priorityMatch = remainingContent.match(/(?:🔺|⏫|🔼|🔽|⏬)/u);
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
        ({ value: recurrenceRuleText, remainingContent } = extractLast(remainingContent, /(?:🔁|repeat:|recur:)\s*([^📅🛫⏳➕✅🔺⏫🔼🔽⏬⏰#^]+)/ug));
        // 🔁 拡張: "hh:mm~hh:mm" を抽出（例: "every day 15:00~24:00" または "15:00~24:00"）
        if (recurrenceRuleText) {
            const m = recurrenceRuleText.match(/(\d{1,2}:\d{2})\s*(?:-|–|—|~|〜|～|to)\s*(\d{1,2}:\d{2}|24:00)/iu);
            if (m) {
                timeWindowStart = m[1];
                timeWindowEnd = m[2];
                recurrenceRuleText = recurrenceRuleText.replace(m[0], '').trim();
                if (recurrenceRuleText.length === 0) recurrenceRuleText = null;
            }
        }

        // 独立した時間帯記法（⏰ 任意）を抽出（未設定時のみ）
        if (!timeWindowStart || !timeWindowEnd) {
            const tw = remainingContent.match(/(?:⏰\s*)?(\d{1,2}:\d{2})\s*(?:-|–|—|~|〜|～|to)\s*(\d{1,2}:\d{2}|24:00)/iu);
            if (tw) {
                timeWindowStart = tw[1];
                timeWindowEnd = tw[2];
                remainingContent = remainingContent.replace(tw[0], '').trim();
            } else {
                // フォールバック: 元のタスクコンテンツ全体からも探索
                const tw2 = taskContent.match(/(?:⏰\s*)?(\d{1,2}:\d{2})\s*(?:-|–|—|~|〜|～|to)\s*(\d{1,2}:\d{2}|24:00)/iu);
                if (tw2) {
                    timeWindowStart = tw2[1];
                    timeWindowEnd = tw2[2];
                }
            }
        }

        // 追加仕様: startDate に時刻があり、時間帯指定がない場合、終日(24:00)までとする
        if (startDate && startDate.includes(' ') && !timeWindowStart && !timeWindowEnd) {
            const timePart = startDate.split(' ')[1];
            if (timePart && timePart.includes(':')) {
                timeWindowStart = timePart.substring(0, 5); // HH:mm
                timeWindowEnd = '24:00';
            }
        }

        // ブロックリンクを抽出 (行末)
        const blockLinkMatch = remainingContent.match(/\s+(\^[a-zA-Z0-9-]+)$/);
        if (blockLinkMatch) {
            blockLink = blockLinkMatch[1];
            remainingContent = remainingContent.replace(blockLinkMatch[0], '').trim();
        }

        // タグを抽出
        const tagsMatch = remainingContent.match(/#[^\s#]+/g);
        const tags = tagsMatch ? tagsMatch.map(t => t.substring(1)) : [];
        remainingContent = remainingContent.replace(/#[^\s#]+/g, '');

        // サマリー: 残った内容を整理（「終日/全日/all day」を強制除去）
        let summary = remainingContent;
        summary = summary.replace(/(?:終日|全日|all[-\s]?day)/gi, ' ');
        summary = summary.replace(/\s{2,}/g, ' ').trim();

        // extraDetail: 直前の継続行結合で summary から取り除かれた自由記述は、現状ではパース時点で取得できないため null（将来: 呼出側で行配列を渡すと良い）
        let extraDetail: string | null = null;

        // 追加仕様: dueDate があり startDate がない場合、startDate を dueDate と同じにする
        if (dueDate && !startDate) {
            startDate = dueDate;
            console.log(`タスク "${summary.substring(0, 20)}..." の startDate が dueDate から補完されました: ${startDate}`);
        }

        // 繰り返しルールを解析
        // DTSTART の起点は startDate を優先。ない場合のみ due/scheduled を使用
        const recurrenceRefDate = startDate ? startDate : (dueDate || scheduledDate);
        const recurrenceRule = recurrenceRuleText ? this.parseRecurrenceRule(recurrenceRuleText, recurrenceRefDate) : null;

        // タスクID生成（ブロックリンク優先 + 安定ハッシュ）
        const idBasis = blockLink
            ? `${filePath}:${blockLink}`
            : `${filePath}:${(summary || '')}:${startDate ?? ''}:${dueDate ?? ''}:${timeWindowStart ?? ''}-${timeWindowEnd ?? ''}`;
        const taskId = `obsidian-${this.generateId(idBasis)}`;

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
            timeWindowStart,
            timeWindowEnd,
            extraDetail,
            tags: tags,
            blockLink: blockLink,
            sourcePath: filePath,
            sourceLine: lineNumber
        };
    }

    /**
     * 繰り返しルールのテキストを解析し、iCalendar RRULE 文字列に変換。
     * - 既存の RRULE 形式（"RRULE:..." または "FREQ=..."）を優先してパース
     * - それが失敗した場合は簡易的な自然言語（every day/week/month/year 等）でパース
     */
    parseRecurrenceRule(ruleText: string, dtstartHint: string | null): string | null {
        ruleText = ruleText.trim(); // 元のケースを保持
        let finalRruleString: string | null = null;

        // 既存の RRULE 文字列を優先的にパース
        if (ruleText.toUpperCase().startsWith('RRULE:') || ruleText.toUpperCase().startsWith('FREQ=')) {
            try {
                const ruleInput = ruleText.toUpperCase().startsWith('RRULE:') ? ruleText : `RRULE:${ruleText}`;
                // forceset: true だと RRuleSet が返ることがあるため両方に対応
                const parsed = rrulestr(ruleInput, { forceset: true });

                // RRule インスタンスを取り出す
                let baseRule: RRule | null = null;
                if (parsed instanceof RRule) {
                    baseRule = parsed;
                } else if (parsed && typeof parsed === 'object' && 'rrules' in parsed) {
                    const rules = (parsed as RRuleSet).rrules();
                    if (rules.length > 0) {
                        baseRule = rules[0];
                    }
                }

                // 見つからなければ失敗扱い（自然言語パースへ）
                if (!baseRule) {
                    throw new Error('No RRule found in parsed value');
                }

                // DTSTART の処理（既存に無ければ補完）
                let dtstart: Date | undefined = baseRule.options.dtstart;
                if (!dtstart && dtstartHint) {
                    const pDate = moment(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true);
                    if (pDate.isValid()) {
                        dtstart = pDate.toDate();
                    } else {
                        console.warn(`RRULE 解析のための無効な dtstartHint "${dtstartHint}"。今日を使用します。`);
                        dtstart = moment().startOf('day').toDate(); // ローカルタイムの今日
                    }
                } else if (!dtstart) {
                    console.warn(`RRULE "${ruleText}" に DTSTART がありません。今日を使用します。`);
                    dtstart = moment().startOf('day').toDate();
                }

                // 既存オプションを再構成して新しい RRule を生成（副作用を避ける）
                const opts = { ...baseRule.options, dtstart } as RRuleOptions;
                const normalized = new RRule(opts);
                finalRruleString = normalized.toString(); // RRULE:... を返す
                return finalRruleString;
            } catch (e) {
                console.warn(`直接的な RRULE パースに失敗: "${ruleText}"`, e);
                // 失敗したら自然言語パースへフォールバック
            }
        }

        // --- 自然言語パース (フォールバック) ---
        ruleText = ruleText.toLowerCase();
        let dtstartDate: Date;
        if (dtstartHint) {
            // FIX: moment.utc() を moment() に変更。
            // 日付のみのヒント("2023-12-25"など)をUTC0時ではなく、ローカルタイムゾーンの0時として解釈させる。
            // これにより、タイムゾーンがUTCより西にあるユーザーで日付が1日ずれる問題を修正。
            const pDate = moment(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true);
            dtstartDate = pDate.isValid() ? pDate.toDate() : moment().startOf('day').toDate(); // Local Time
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

        // 追加: count/until の簡易対応
        const countM = ruleText.match(/\bfor\s+(\d+)\s+(?:times|occurrences?)\b/);
        if (countM) options.count = parseInt(countM[1], 10);
        const untilM = ruleText.match(/\buntil\s+(\d{4}-\d{2}-\d{2})\b/);
        if (untilM) options.until = moment(untilM[1], 'YYYY-MM-DD', true).endOf('day').toDate();

        if (freq !== null) {
            options.freq = freq;
            options.interval = interval > 0 ? interval : 1;
            try {
                // RRuleOptions を安全に構成（null を入れない）
                const finalOptions: RRuleOptions = {
                    freq: options.freq!,
                    dtstart: options.dtstart || new Date(),
                    interval: options.interval!,
                } as RRuleOptions;

                if (options.wkst !== undefined) (finalOptions as any).wkst = options.wkst;
                if (options.count !== undefined) finalOptions.count = options.count;
                if (options.until !== undefined) finalOptions.until = options.until;
                if ((options as any).tzid !== undefined) (finalOptions as any).tzid = (options as any).tzid;
                if (options.bysetpos !== undefined) finalOptions.bysetpos = options.bysetpos;
                if (options.bymonth !== undefined) finalOptions.bymonth = options.bymonth;
                if (options.bymonthday !== undefined) finalOptions.bymonthday = options.bymonthday;
                if (options.byyearday !== undefined) finalOptions.byyearday = options.byyearday;
                if (options.byweekno !== undefined) finalOptions.byweekno = options.byweekno;
                if (options.byweekday !== undefined) finalOptions.byweekday = options.byweekday as any;
                if (options.byhour !== undefined) finalOptions.byhour = options.byhour;
                if (options.byminute !== undefined) finalOptions.byminute = options.byminute;
                if (options.bysecond !== undefined) finalOptions.bysecond = options.bysecond;
                if ((options as any).byeaster !== undefined) (finalOptions as any).byeaster = (options as any).byeaster;

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

// テスト用の薄いラッパ（Markdown文字列からタスクリストを作る）
export function parseTasksFromMarkdown(markdown: string): ObsidianTask[] {
    // 簡易: 1つの仮想ファイルに見立てて各行を流す
    const parser = new TaskParser({} as any);
    const lines = markdown.split(/\r?\n/);
    const out: ObsidianTask[] = [];
    let inFence = false; let fenceChar = ''; let fenceLen = 0;
    lines.forEach((line, idx) => {
        const open = line.match(/^\s*([`~]{3,})/);
        if (open) {
            const marker = open[1];
            const ch = marker[0] as '`' | '~';
            const len = marker.length;
            if (!inFence) { inFence = true; fenceChar = ch; fenceLen = len; return; }
            if (inFence && fenceChar === ch && len >= fenceLen) { inFence = false; fenceChar = ''; fenceLen = 0; return; }
        }
        if (inFence) return;
        // 継続行（連続するインデント行）を解釈
        let combined = line;
        let extraDetailFromNext: string | null = null;
        const details: string[] = [];
        const SUBTASK_RE = /^\s*-\s*\[[ xX]\]/; // ネストしたタスク
        const CONTROL_RE = /(?:\d{1,2}:\d{2})\s*(?:-|–|—|~|〜|～|to)\s*(?:\d{1,2}:\d{2}|24:00)|🔁|(?:終日|全日|all[-\s]?day)/iu;
        let k = idx + 1;
        while (k < lines.length && /^\s+/.test(lines[k])) {
            const raw = lines[k];
            const trimmed = raw.trim();
            if (trimmed.length === 0) { k++; continue; }
            if (SUBTASK_RE.test(trimmed)) break;
            if (CONTROL_RE.test(trimmed)) combined = `${combined} ${trimmed}`;
            else details.push(trimmed);
            k++;
        }
        if (details.length > 0) extraDetailFromNext = details.join('\n');

        const task = parser.parseObsidianTask(combined, 'inline.md', idx);
        if (task) {
            if (extraDetailFromNext && !(task as any).extraDetail) {
                (task as any).extraDetail = extraDetailFromNext;
            }
            // インデント側の #tag を反映
            if (extraDetailFromNext) {
                const extraTags = extraDetailFromNext.match(/#[^\s#]+/g) || [];
                if (extraTags.length) {
                    const merged = new Set([...(task.tags || []), ...extraTags.map(t => t.slice(1))]);
                    (task as any).tags = Array.from(merged);
                }
            }
            out.push(task);
        }
    });
    return out;
}
