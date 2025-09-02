import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SyncLogic } from '../src/syncLogic';

const baseSettings = {
  calendarId: 'primary',
  defaultEventDurationMinutes: 60,
  includeDescriptionInIdentity: false,
  includeReminderInIdentity: false,
  interBatchDelay: 0,
  desiredBatchSize: 5,
  maxBatchPerHttp: 500,
  maxInFlightBatches: 1,
  syncNoticeSettings: { showManualSyncProgress: false, showAutoSyncSummary: false, showErrors: false, minSyncDurationForNotice: 0 },
};

const makePlugin = () => ({
  app: {} as any,
  settings: { ...baseSettings },
  gcalApi: { fetchGoogleCalendarEvents: vi.fn() },
  taskParser: { getObsidianTasks: vi.fn() },
} as any);

describe('SyncLogic phase helpers', () => {
  let plugin: any;
  let sync: any;

  beforeEach(() => {
    plugin = makePlugin();
    sync = new SyncLogic(plugin);
  });

  test('fetchGoogleEvents filters unmanaged events and builds maps', async () => {
    plugin.gcalApi.fetchGoogleCalendarEvents.mockResolvedValue([
      { id: 'a', summary: 'managed', status: 'confirmed', extendedProperties: { private: { isGcalSync: 'true', obsidianTaskId: 't1' } } },
      { id: 'b', summary: 'ignored', status: 'confirmed', extendedProperties: { private: { } } },
    ]);
    const result = await (sync as any).fetchGoogleEvents(plugin.settings, false, {}, true);
    expect(result.existingEvents).toHaveLength(1);
    expect(result.googleEventMap.get('t1')?.id).toBe('a');
    expect(result.existingGIdSet.has('a')).toBe(true);
  });

  test('processBatchRequests updates taskMap', async () => {
    const batchRequests = [
      { method: 'POST', path: '/p', operationType: 'insert', obsidianTaskId: 't1' },
      { method: 'DELETE', path: '/d', operationType: 'delete', obsidianTaskId: 't2', originalGcalId: 'gid2' },
    ];
    const taskMap: Record<string, string> = { t2: 'gid2' };
    (sync as any).executeBatchesWithRetry = vi.fn().mockResolvedValue({
      results: [
        { status: 200, body: { id: 'new1' } },
        { status: 200, body: {} },
      ],
      created: 1,
      updated: 0,
      deleted: 1,
      errors: 0,
      skipped: 0,
      metrics: { sentSubBatches: 1, attempts: 1, retriedItems: 0, retryDelays: [] },
    });
    const counts = await (sync as any).processBatchRequests(batchRequests, taskMap, new Map(), plugin.settings, false);
    expect(counts.createdCount).toBe(1);
    expect(counts.deletedCount).toBe(1);
    expect(taskMap['t1']).toBe('new1');
    expect(taskMap['t2']).toBeUndefined();
  });
});

