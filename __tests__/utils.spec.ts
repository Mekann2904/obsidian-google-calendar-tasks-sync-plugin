import { describe, test, expect } from 'vitest';
import moment from 'moment';
import { isGaxiosError, validateMoment } from '../src/utils';

describe('isGaxiosError', () => {
  test('returns true for object with message and response', () => {
    const err = { message: 'error', response: {} };
    expect(isGaxiosError(err)).toBe(true);
  });

  test('returns false for simple Error object', () => {
    const err = new Error('error');
    expect(isGaxiosError(err)).toBe(false);
  });
});

describe('validateMoment', () => {
  test('returns moment for valid date string', () => {
    const res = validateMoment('2024-05-20', 'YYYY-MM-DD', 'test');
    expect(res).not.toBeNull();
    expect(res && moment.isMoment(res) && res.isValid()).toBe(true);
  });

  test('returns null for invalid date string', () => {
    const res = validateMoment('invalid-date', 'YYYY-MM-DD', 'test');
    expect(res).toBeNull();
  });
});

