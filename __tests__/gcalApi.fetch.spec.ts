import { describe, test, expect, vi, beforeEach } from 'vitest';
import { GCalApiService } from '../src/gcalApi';

// minimal plugin stub
const makePlugin = () => ({
  calendar: { events: { list: vi.fn() } },
  settings: { calendarId: 'cal', syncToken: 'TOK1' } as any,
  saveData: vi.fn().mockResolvedValue(undefined),
  authService: { initializeCalendarApi: vi.fn() },
} as any);

describe('GCalApiService.fetchGoogleCalendarEvents', () => {
  let plugin: any;
  let api: GCalApiService;

  beforeEach(() => {
    plugin = makePlugin();
    api = new GCalApiService(plugin);
  });

  test('syncTokenを利用した増分取得', async () => {
    plugin.calendar.events.list
      .mockResolvedValueOnce({ data: { items: [{ id: 'e1' }], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { items: [{ id: 'e2' }], nextSyncToken: 'NEXT' } });

    const settings = { calendarId: 'cal', useSyncToken: true } as any;
    const events = await api.fetchGoogleCalendarEvents(settings);

    expect(events.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(plugin.calendar.events.list).toHaveBeenCalledTimes(2);
    expect(plugin.calendar.events.list.mock.calls[0][0].syncToken).toBe('TOK1');
    expect(plugin.settings.syncToken).toBe('NEXT');
  });

  test('syncToken無効時はフォールバック', async () => {
    const err: any = new Error('Sync token is no longer valid');
    err.response = { status: 410, data: { error: { message: 'Sync token is no longer valid' } } };
    plugin.calendar.events.list
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { items: [{ id: 'f1' }], nextSyncToken: 'NEW' } });

    const settings = { calendarId: 'cal', useSyncToken: true } as any;
    const events = await api.fetchGoogleCalendarEvents(settings);

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('f1');
    expect(plugin.calendar.events.list).toHaveBeenCalledTimes(2);
    expect(plugin.calendar.events.list.mock.calls[0][0].syncToken).toBe('TOK1');
    expect(plugin.calendar.events.list.mock.calls[1][0].syncToken).toBeUndefined();
    expect(plugin.settings.syncToken).toBe('NEW');
  });
});
