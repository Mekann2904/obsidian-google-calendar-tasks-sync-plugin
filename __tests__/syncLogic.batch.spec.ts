// __tests__/syncLogic.batching.spec.ts
import { describe, test, expect, beforeEach } from 'vitest';
import moment from 'moment';
import { SyncLogic } from '../src/syncLogic';

// すべてのテストで壁時計を固定
process.env.TZ = 'Asia/Tokyo';

// ----------------------
// テスト用プラグイン&マッパー
// ----------------------
const baseSettings = {
  calendarId: 'primary',
  defaultEventDurationMinutes: 60,
  includeDescriptionInIdentity: false,
  includeReminderInIdentity: false,
  interBatchDelay: 0,
  desiredBatchSize: 5,
  maxBatchPerHttp: 50,
  maxInFlightBatches: 1,
  syncNoticeSettings: { showSummary: false, showErrors: false },
};

const makePlugin = () =>
  ({
    app: {} as any,
    settings: { ...baseSettings },
  } as any);

// GCalMapper 互換（必要最小限）
class DummyMapper {
  constructor(_app: any, _settings: any) {}
  toEventDateTime(m: moment.Moment) {
    return { dateTime: m.format('YYYY-MM-DDTHH:mm:ss'), timeZone: 'Asia/Tokyo' };
  }
  mapObsidianTaskToGoogleEvent(task: any) {
    const start = moment(`${task.startDate} ${task.timeWindowStart || '09:00'}`, 'YYYY-MM-DD HH:mm');
    const end = moment(`${task.dueDate} ${task.timeWindowEnd || '10:00'}`, 'YYYY-MM-DD HH:mm');
    const ev: any = {
      summary: task.summary,
      start: this.toEventDateTime(start),
      end: this.toEventDateTime(end),
      extendedProperties: {
        private: { isGcalSync: 'true', obsidianTaskId: task.id },
      },
    };
    if (task.recurrenceRule) ev.recurrence = [task.recurrenceRule];
    return ev;
  }
}

// ----------------------
// ヘルパー
// ----------------------
type Req = {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: any;
  fullBody?: any;
  operationType: 'insert' | 'patch' | 'update' | 'delete';
  obsidianTaskId?: string;
  originalGcalId?: string;
};

const collect = (batch: Req[]) => ({
  posts: batch.filter(r => r.method === 'POST' && r.operationType === 'insert'),
  patches: batch.filter(r => r.method === 'PATCH'),
  deletes: batch.filter(r => r.method === 'DELETE'),
});

const mkExisting = (id: string, { summary, start, end, etag, recurrence }: any = {}) => ({
  id,
  summary: summary ?? '既存イベント',
  start: start ?? { dateTime: '2025-08-30T09:00:00', timeZone: 'Asia/Tokyo' },
  end: end ?? { dateTime: '2025-08-30T10:00:00', timeZone: 'Asia/Tokyo' },
  etag: etag ?? '"etag-1"',
  recurrence: recurrence ?? undefined,
  extendedProperties: { private: { isGcalSync: 'true', obsidianTaskId: 'X' } },
});

// ----------------------
// テスト
// ----------------------
describe('SyncLogic: 追加/更新/削除のバッチ構築', () => {
  let plugin: any;
  let sync: any;
  let gmap: any;

  beforeEach(() => {
    plugin = makePlugin();
    sync = new SyncLogic(plugin);
    gmap = new DummyMapper(plugin.app, plugin.settings);
  });

  test('新規タスク → POST 1件が積まれる（基本）', () => {
    const tasks = [
      { id: 'obs-add-1', summary: '追加テスト', startDate: '2025-08-31', dueDate: '2025-08-31', timeWindowStart: '09:00', timeWindowEnd: '10:00' },
    ];

    const googleEventMap = new Map<string, any>(); // まだ存在しない
    const taskMap: Record<string, string> = {};
    const batch: Req[] = [];
    const dedupeIndex = new Map<string, any>();

    const res = (sync as any).prepareBatchRequests(
      tasks, googleEventMap, taskMap, batch, gmap, plugin.settings, false, dedupeIndex,
    );

    const { posts, patches, deletes } = collect(batch);
    expect(res.skipped).toBeGreaterThanOrEqual(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toMatch(/\/calendars\/primary\/events$/);
    expect(posts[0].body?.summary).toBe('追加テスト');
    expect(patches).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  test('既存イベントがあり差分あり → PATCH（If-Match付き）', () => {
    const t = { id: 'obs-1', summary: 'タイトル変更', startDate: '2025-08-31', dueDate: '2025-08-31', timeWindowStart: '09:00', timeWindowEnd: '11:00' };
    const existing = mkExisting('gcal-1', {
      summary: '旧タイトル', // タイトル差分
      start: { dateTime: '2025-08-31T09:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-08-31T10:00:00', timeZone: 'Asia/Tokyo' },
      etag: '"etag-xyz"',
    });

    const googleEventMap = new Map<string, any>([[t.id, existing]]);
    const taskMap: Record<string, string> = { [t.id]: existing.id };
    const batch: Req[] = [];

    (sync as any).prepareBatchRequests(
      [t], googleEventMap, taskMap, batch, gmap, plugin.settings, false, new Map(),
    );

    const { posts, patches, deletes } = collect(batch);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toMatch(/\/calendars\/primary\/events\/gcal-1$/);
    expect(patches[0].headers?.['If-Match']).toBe('"etag-xyz"');
    expect(posts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  test('既存→DAILY へ変更：DELETE → 期間内に個別 POST（3件）', () => {
    const t = {
      id: 'obs-2',
      summary: '日次展開',
      startDate: '2025-08-31',
      dueDate: '2025-09-02', // 08/31, 09/01, 09/02 の3日
      timeWindowStart: '13:00',
      timeWindowEnd: '16:00',
      recurrenceRule: 'RRULE:FREQ=DAILY', // COUNT なしでも create 側/expand 側で埋める
    };

    const existing = mkExisting('gcal-2', {
      summary: '日次展開',
      start: { dateTime: '2025-08-31T13:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-08-31T14:00:00', timeZone: 'Asia/Tokyo' },
      etag: '"etag-old"',
      recurrence: undefined, // 旧: 単発 → 新: DAILY
    });

    const googleEventMap = new Map<string, any>([[t.id, existing]]);
    const taskMap: Record<string, string> = { [t.id]: existing.id };
    const batch: Req[] = [];

    (sync as any).prepareBatchRequests(
      [t], googleEventMap, taskMap, batch, gmap, plugin.settings, false, new Map(),
    );

    const { posts, patches, deletes } = collect(batch);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].headers?.['If-Match']).toBe('"etag-old"');

    // expand により 3 件の POST
    expect(posts).toHaveLength(3);
    const starts = posts.map(p => p.body?.start?.dateTime);
    const ends   = posts.map(p => p.body?.end?.dateTime);
    expect(starts).toEqual(['2025-08-31T13:00:00', '2025-09-01T13:00:00', '2025-09-02T13:00:00']);
    expect(ends).toEqual(['2025-08-31T16:00:00', '2025-09-01T16:00:00', '2025-09-02T16:00:00']);
    expect(patches).toHaveLength(0);
  });

  test('dedupeIndex に同一イベントがある場合：PATCH（既存IDに対して）', () => {
    const t = {
      id: 'obs-3',
      summary: '同一性再利用',
      startDate: '2025-08-31',
      dueDate: '2025-08-31',
      timeWindowStart: '09:00',
      timeWindowEnd: '10:30', // 既存と差分あり → PATCH させる
    };

    // 同一性キーが一致する「既存のGCalイベント」
    const dup = mkExisting('dup-1', {
      summary: '同一性再利用',
      start: { dateTime: '2025-08-31T09:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-08-31T10:00:00', timeZone: 'Asia/Tokyo' },
      etag: '"etag-dup"',
    });

    const googleEventMap = new Map<string, any>(); // 直接のマッピングは無い
    const taskMap: Record<string, string> = {};    // まだ紐付いていない
    const batch: Req[] = [];

    // identity キー生成は SyncLogic 内部。dedupeIndex にはイベントそのものを渡す。
    const dedupe = new Map<string, any>([
      // キーは buildIdentityKeyFromEvent/FromPayload で作られるが、
      // prepare 側で payload→key を作って dedupeIndex.get(key) を引くので
      // ここは payload と同等の key にヒットするよう「1件だけ」入れておけばOK。
      // 実際にはキー生成ロジック依存なので、ここでは1件だけ与えてヒットを期待する。
    ]);
    // 実運用上は buildDedupeIndex() の戻り値を使うが、テストでは最小限の挙動を検証するため
    // payload と等価キーになるように map の set を後から行う:
    (sync as any).buildDedupeIndex = () => new Map(); // 使わない
    // prepare 内部の buildIdentityKeyFromPayload を流用して key を決めて格納
    const tempPayload = (new DummyMapper({}, {})).mapObsidianTaskToGoogleEvent(t);
    const key = (sync as any).buildIdentityKeyFromPayload(tempPayload);
    dedupe.set(key, dup);

    (sync as any).prepareBatchRequests(
      [t], googleEventMap, taskMap, batch, new DummyMapper({}, {}), plugin.settings, false, dedupe,
    );

    const { posts, patches, deletes } = collect(batch);
    // 既存を再利用 → PATCH 一発。DELETE/POST は無し。
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toMatch(/\/calendars\/primary\/events\/dup-1$/);
    expect(patches[0].headers?.['If-Match']).toBe('"etag-dup"');
    expect(posts).toHaveLength(0);
    expect(deletes).toHaveLength(0);

    // 同時に taskMap がそのIDに差し替えられていること（再利用）
    expect(taskMap['obs-3']).toBe('dup-1');
  });

  test('完了タスク：既存イベントが無ければスキップ（POST されない）', () => {
    const t = {
      id: 'obs-done',
      summary: '完了済み',
      startDate: '2025-08-31',
      dueDate: '2025-08-31',
      timeWindowStart: '09:00',
      timeWindowEnd: '10:00',
      isCompleted: true,
    };
    const batch: Req[] = [];

    const res = (sync as any).prepareBatchRequests(
      [t], new Map(), {}, batch, gmap, plugin.settings, false, new Map(),
    );

    const { posts, patches, deletes } = collect(batch);
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0); // 既存が無いので PATCH もされない
    expect(deletes).toHaveLength(0);
    expect(res.skipped).toBeGreaterThan(0);
  });

  test('必須日付の欠落はスキップ', () => {
    const tasks = [
      { id: 'n1', summary: 'start 無し', startDate: null, dueDate: '2025-08-31' },
      { id: 'n2', summary: 'due 無し',   startDate: '2025-08-31', dueDate: null },
    ] as any[];
    const batch: Req[] = [];

    const res = (sync as any).prepareBatchRequests(
      tasks, new Map(), {}, batch, gmap, plugin.settings, false, new Map(),
    );

    expect(batch).toHaveLength(0);
    expect(res.skipped).toBe(2);
  });

  test('孤児イベント → DELETE が積まれる（If-Match も付与）', () => {
    const batch: Req[] = [];
    const taskMap: Record<string, string> = {}; // 今回のタスクには存在しない
    const currentIds = new Set<string>([]);
    const orphan = mkExisting('gcal-orphan', { etag: '"etag-orphan"' });
    const existing = [orphan];
    const idSet = new Set(['gcal-orphan']);

    (sync as any).prepareDeletionRequests(
      taskMap, currentIds, existing, idSet, batch, plugin.settings, false,
    );

    const { deletes } = collect(batch);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toMatch(/\/calendars\/primary\/events\/gcal-orphan$/);
    expect(deletes[0].headers?.['If-Match']).toBe('"etag-orphan"');
  });

  test('taskMap にあるが存在しない gId はその場で掃除される', () => {
    const batch: Req[] = [];
    const taskMap: Record<string, string> = { obsX: 'missing-gid' }; // もう存在しない
    const currentIds = new Set<string>([]); // 今回参照なし
    const existing: any[] = []; // カレンダー側にも無い
    const idSet = new Set<string>([]);

    (sync as any).prepareDeletionRequests(
      taskMap, currentIds, existing, idSet, batch, plugin.settings, false,
    );

    // リクエストは発生しないが、taskMap が掃除される
    expect(batch).toHaveLength(0);
    expect(taskMap.obsX).toBeUndefined();
  });
});
