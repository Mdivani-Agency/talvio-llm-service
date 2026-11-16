import {
  abandonable,
  MAX_STEP_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelayMs,
} from './execution';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const past = new Date(NOW.getTime() - 1_000);
const future = new Date(NOW.getTime() + 1_000);

describe('retryDelayMs', () => {
  it('stays between half the ceiling and the ceiling, doubling per attempt', () => {
    expect(retryDelayMs(1, () => 0)).toBe(RETRY_BASE_MS / 2);
    expect(retryDelayMs(1, () => 1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2, () => 1)).toBe(RETRY_BASE_MS * 2);
  });

  it('never exceeds the cap, however many attempts', () => {
    expect(retryDelayMs(30, () => 1)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(30, () => 0)).toBe(RETRY_MAX_MS / 2);
  });

  it('allows three attempts per step', () => {
    expect(MAX_STEP_ATTEMPTS).toBe(3);
  });
});

describe('abandonable', () => {
  const job = (status: string, leaseExpiresAt: Date | null, availableAt: Date | null) => ({
    status,
    leaseExpiresAt,
    availableAt,
  });

  it('allows a job nothing is driving', () => {
    expect(abandonable(job('queued', null, null), NOW)).toBe(true);
    expect(abandonable(job('retry_wait', null, past), NOW)).toBe(true);
    expect(abandonable(job('running', past, null), NOW)).toBe(true);
  });

  it('refuses a job that has a live worker, a later retry or an external wait', () => {
    expect(abandonable(job('running', future, null), NOW)).toBe(false);
    expect(abandonable(job('retry_wait', null, future), NOW)).toBe(false);
    expect(abandonable(job('waiting_external', null, null), NOW)).toBe(false);
  });
});
