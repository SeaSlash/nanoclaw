import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getLastTaskRun,
  logTaskRun,
} from './db.js';
import { looksLikeAuthFailure } from './router.js';

function seedTask(id: string): void {
  createTask({
    id,
    group_folder: 'personal',
    chat_jid: 'dc:123',
    prompt: 'run',
    schedule_type: 'cron',
    schedule_value: '0 7 * * *',
    context_mode: 'isolated',
    next_run: '2026-06-19T11:00:00.000Z',
    status: 'active',
    created_at: '2026-06-18T00:00:00.000Z',
  });
}

describe('looksLikeAuthFailure', () => {
  it('matches known auth/credential failure strings', () => {
    expect(looksLikeAuthFailure('Not logged in · Please run /login')).toBe(
      true,
    );
    expect(looksLikeAuthFailure('please run /login')).toBe(true);
    expect(looksLikeAuthFailure('invalid x-api-key')).toBe(true);
    expect(looksLikeAuthFailure('authentication_error: bad token')).toBe(true);
    expect(looksLikeAuthFailure('Your OAuth token has expired')).toBe(true);
  });

  it('does not match normal assistant output', () => {
    expect(looksLikeAuthFailure('')).toBe(false);
    expect(looksLikeAuthFailure('🌅 AM Brief — Thursday, Jun 18')).toBe(false);
    expect(
      looksLikeAuthFailure('You have 3 overdue tasks and 2 unread emails.'),
    ).toBe(false);
  });
});

describe('getLastTaskRun', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined when a task has no run logs', () => {
    expect(getLastTaskRun('never-ran')).toBeUndefined();
  });

  it('returns the most recent run row for a task', () => {
    seedTask('t1');
    seedTask('t2');
    logTaskRun({
      task_id: 't1',
      run_at: '2026-06-18T07:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 't1',
      run_at: '2026-06-18T12:00:00.000Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'delivery_failed: dc:123',
    });
    // unrelated task should not interfere
    logTaskRun({
      task_id: 't2',
      run_at: '2026-06-18T13:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const last = getLastTaskRun('t1');
    expect(last?.run_at).toBe('2026-06-18T12:00:00.000Z');
    expect(last?.status).toBe('error');
    expect(last?.error).toBe('delivery_failed: dc:123');
  });
});
