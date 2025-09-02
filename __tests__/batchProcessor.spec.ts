import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchProcessor } from '../src/batchProcessor';
import { setDevLogging } from '../src/logger';

const settings = {
  showNotices: false,
  maxBatchPerHttp: 500,
  minDesiredBatchSize: 5,
  desiredBatchSize: 5,
  maxInFlightBatches: 1,
  latencySLAms: 1500,
  rateErrorCooldownMs: 0,
  interBatchDelay: 0,
};

describe('BatchProcessor executeBatches timing', () => {
  beforeEach(() => setDevLogging(true));
  afterEach(() => setDevLogging(false));

  test('timeEnd called even on error', async () => {
    const endSpy = vi.spyOn(console, 'timeEnd').mockImplementation(() => {});
    const processor = new BatchProcessor(settings as any);

    const ac = new AbortController();
    ac.abort();

    await expect(
      processor.executeBatches(
        [{ method: 'POST', path: '/test', operationType: 'insert' } as any],
        async () => [],
        ac.signal,
      )
    ).rejects.toThrow('AbortError');

    expect(endSpy).toHaveBeenCalledWith('BatchProcessor: Execute All Batches');
    endSpy.mockRestore();
  });
});
