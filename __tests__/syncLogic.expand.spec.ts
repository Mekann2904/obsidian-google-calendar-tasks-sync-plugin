// __tests__/syncLogic.expand.spec.ts
process.env.TZ = 'Asia/Tokyo';
import { describe, test, expect } from 'vitest';
import moment from 'moment';

import { SyncLogic } from '../src/syncLogic';
import { GCalMapper } from '../src/gcalMapper';
import type { calendar_v3 } from 'googleapis';

type GoogleCalendarEventInput = Partial<calendar_v3.Schema$Event> & {
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?:   { date?: string; dateTime?: string; timeZone?: string };
};

const fakePlugin = {
  app: {} as any,
  settings: {
    defaultEventDurationMinutes: 60,
    calendarId: 'primary',
    includeDescriptionInIdentity: false,
    includeReminderInIdentity: false,
    interBatchDelay: 0,
    desiredBatchSize: 5,
    maxBatchPerHttp: 50,
    maxInFlightBatches: 1,
  },
  authService: { ensureAccessToken: async () => true },
  calendar: {} as any,
  gcalApi: { fetchGoogleCalendarEvents: async () => [] },
  setSyncing: () => void 0,
  isCurrentlySyncing: () => false,
  saveData: async () => void 0,
  refreshSettingsTab: () => void 0,
} as any;

class FakeGCalMapper extends GCalMapper {
  public toEventDateTime(m: moment.Moment) {
    return { dateTime: m.format('YYYY-MM-DDTHH:mm:ss'), timeZone: 'Asia/Tokyo' };
  }
}

describe('SyncLogic.expandEventForInsertion', () => {
  const sync = new SyncLogic(fakePlugin as any);
  const gmap = new FakeGCalMapper(fakePlugin.app, fakePlugin.settings);

  test('DAILY 3回を13:00~16:00で展開', () => {
    const task = {
      id: 't4', summary: 'テスト4', startDate: '2025-08-31', dueDate: '2025-09-02',
      timeWindowStart: '13:00', timeWindowEnd: '16:00'
    } as any;

    const payload: GoogleCalendarEventInput = {
      summary: 'テスト4',
      start: { dateTime: '2025-08-31T13:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-08-31T16:00:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3']
    };

    const out = (sync as any).expandEventForInsertion(payload, task, gmap) as GoogleCalendarEventInput[];
    expect(out.map(e => e.start!.dateTime)).toEqual([
      '2025-08-31T13:00:00','2025-09-01T13:00:00','2025-09-02T13:00:00'
    ]);
    expect(out.map(e => e.end!.dateTime)).toEqual([
      '2025-08-31T16:00:00','2025-09-01T16:00:00','2025-09-02T16:00:00'
    ]);
  });

  test('WEEKLY SU を期間内に展開', () => {
    const task = {
      id: 't5', summary: 'テスト5', startDate: '2025-08-31', dueDate: '2025-09-15',
      timeWindowStart: '08:00', timeWindowEnd: '10:00'
    } as any;

    const payload: GoogleCalendarEventInput = {
      summary: 'テスト5',
      start: { dateTime: '2025-08-31T08:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-08-31T10:00:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU']
    };

    const out = (sync as any).expandEventForInsertion(payload, task, gmap) as GoogleCalendarEventInput[];
    expect(out.map(e => e.start!.dateTime)).toEqual([
      '2025-08-31T08:00:00','2025-09-07T08:00:00','2025-09-14T08:00:00'
    ]);
  });

  test('24:00は翌日0:00', () => {
    const task = {
      id: 't2', summary: 'テスト2', startDate: '2025-08-31', dueDate: '2025-08-31',
      timeWindowStart: '12:00', timeWindowEnd: '24:00'
    } as any;

    const payload: GoogleCalendarEventInput = {
      summary: 'テスト2',
      start: { dateTime: '2025-08-31T12:00:00', timeZone: 'Asia/Tokyo' },
      end:   { dateTime: '2025-09-01T00:00:00', timeZone: 'Asia/Tokyo' },
    };

    const out = (sync as any).expandEventForInsertion(payload, task, gmap) as GoogleCalendarEventInput[];
    expect(out).toHaveLength(1);
    expect(out[0].end!.dateTime).toBe('2025-09-01T00:00:00');
  });
});
