import { describe, test, expect } from 'vitest';
import { DateUtils, TaskMapUtils } from '../src/commonUtils';

describe('DateUtils.isSameDateTime', () => {
  test('returns true for same timestamp with different timezones', () => {
    const dt1 = '2023-01-01T12:00:00+09:00';
    const dt2 = '2023-01-01T03:00:00+00:00'; // same instant
    expect(DateUtils.isSameDateTime(dt1, dt2)).toBe(true);
  });

  test('returns false when timestamps differ', () => {
    const dt1 = '2023-01-01T12:00:00+09:00';
    const dt2 = '2023-01-01T12:01:00+09:00'; // different time
    expect(DateUtils.isSameDateTime(dt1, dt2)).toBe(false);
  });
});

describe('TaskMapUtils.updateTaskMap and removeFromTaskMap', () => {
  test('adds and updates mapping correctly', () => {
    const map: Record<string, string> = {};
    TaskMapUtils.updateTaskMap(map, 'task1', 'event1');
    expect(map).toEqual({ task1: 'event1' });

    // update existing mapping
    TaskMapUtils.updateTaskMap(map, 'task1', 'event2');
    expect(map).toEqual({ task1: 'event2' });
  });

  test('removes mapping correctly', () => {
    const map: Record<string, string> = { task1: 'event1', task2: 'event2' };
    TaskMapUtils.removeFromTaskMap(map, 'task1');
    expect(map).toEqual({ task2: 'event2' });
  });
});

