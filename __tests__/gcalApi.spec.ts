import { describe, it, expect, vi } from 'vitest';
import { GCalApiService } from '../src/gcalApi';
import type { calendar_v3 } from 'googleapis';

describe('GCalApiService.fetchGoogleCalendarEvents', () => {
  it('falls back to full fetch when syncToken is invalid', async () => {
    const plugin = {
      calendar: {},
      authService: { initializeCalendarApi: vi.fn() },
      settings: { syncToken: 'old-token' },
      saveData: vi.fn().mockResolvedValue(undefined),
    } as any;
    const service = new GCalApiService(plugin);

    const invalidTokenError = new Error('Sync token is no longer valid') as any;
    invalidTokenError.response = { status: 410 };

    const spy = vi
      .spyOn(service as any, 'eventsListWithRetry')
      .mockRejectedValueOnce(invalidTokenError)
      .mockResolvedValueOnce({ data: { items: [{ id: '1' }], nextSyncToken: 'new-token' } } as any);

    const settings = { calendarId: 'cid', useSyncToken: true } as any;
    const events = await service.fetchGoogleCalendarEvents(settings);

    expect(events).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);

    const firstCall = spy.mock.calls[0][0];
    expect(firstCall.syncToken).toBe('old-token');
    expect(firstCall.showDeleted).toBe(true);

    const secondCall = spy.mock.calls[1][0];
    expect(secondCall.syncToken).toBeUndefined();
    expect(secondCall.showDeleted).toBe(false);

    expect(plugin.settings.syncToken).toBe('new-token');
  });
});

describe('GCalApiService.eventsListWithRetry', () => {
  const makeService = () => {
    const plugin = {
      calendar: { events: { list: vi.fn() } },
    } as any;
    return { service: new GCalApiService(plugin), plugin };
  };

  it('retries on server errors and eventually succeeds', async () => {
    const { service, plugin } = makeService();
    const err = { message: 'server', response: { status: 500, data: {} } };
    plugin.calendar.events.list
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { items: [] } } as any);

    vi.useFakeTimers();
    const promise = (service as any).eventsListWithRetry({ calendarId: 'c' } as calendar_v3.Params$Resource$Events$List);
    await vi.runAllTimersAsync();
    const res = await promise;
    vi.useRealTimers();

    expect(res.data.items).toEqual([]);
    expect(plugin.calendar.events.list).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    const { service, plugin } = makeService();
    const err = { message: 'server', response: { status: 500, data: {} } };
    plugin.calendar.events.list.mockRejectedValue(err);

    vi.useFakeTimers();
    const promise = (service as any).eventsListWithRetry({ calendarId: 'c' } as calendar_v3.Params$Resource$Events$List);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow(/events.list failed/);
    vi.useRealTimers();

    expect(plugin.calendar.events.list).toHaveBeenCalledTimes(3);
  });
});

