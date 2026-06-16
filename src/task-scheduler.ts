import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  SCHEDULER_MAX_CATCHUP_PER_TICK,
  SCHEDULER_POLL_INTERVAL,
  TASK_LOG_RETENTION_MS,
  TASK_RETENTION_MS,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  pruneCompletedTasks,
  pruneOldTaskRunLogs,
  resetRetryCount,
  scheduleTaskRetry,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

// Process-wide overlap guard: task ids currently enqueued-or-running. The
// scheduler skips re-enqueuing a task that is still in flight, so a task whose
// runtime exceeds its interval never double-runs. Cleared in runTask's finally.
const runningTasks = new Set<string>();

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  try {
    await runTaskInner(task, deps);
  } finally {
    runningTasks.delete(task.id);
  }
}

async function runTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // Retry/backoff (opt-in). A failure is keyed strictly on `error` (set only when
  // the container reported status='error' or threw) — NOT on a null result, since
  // a gate that returns wakeAgent:false legitimately produces result:null.
  const maxRetries = task.max_retries ?? 0;
  const retryCount = task.retry_count ?? 0;
  if (error && retryCount < maxRetries) {
    const baseMs = task.retry_base_ms ?? 60_000;
    const nextRetryCount = retryCount + 1;
    const backoffMs = baseMs * Math.pow(2, retryCount); // 1x, 2x, 4x, ...
    const retryAt = new Date(Date.now() + backoffMs);
    const scheduled = computeNextRun(task);
    // Only retry if the backoff lands before the next scheduled run; otherwise
    // let the normal schedule take over.
    if (!scheduled || retryAt.getTime() < new Date(scheduled).getTime()) {
      scheduleTaskRetry(task.id, retryAt.toISOString(), nextRetryCount);
      logger.warn(
        {
          taskId: task.id,
          attempt: nextRetryCount,
          maxRetries,
          backoffMs,
          error,
        },
        'Scheduled task failed; retrying with backoff',
      );
      return;
    }
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
  // Clear any prior retry state after a clean run (or exhausted retries).
  if (retryCount > 0) {
    resetRetryCount(task.id);
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // sweep retention roughly hourly
  let lastPruneAt = 0;

  const loop = async () => {
    try {
      // Periodic retention sweep: drop old completed one-shot tasks and stale
      // run logs so the table doesn't grow unbounded (the */5 poll alone writes
      // ~288 log rows/day). Guarded so it runs ~hourly, not every tick.
      const now = Date.now();
      if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = now;
        try {
          const prunedTasks = pruneCompletedTasks(TASK_RETENTION_MS);
          const prunedLogs = pruneOldTaskRunLogs(TASK_LOG_RETENTION_MS);
          if (prunedTasks > 0 || prunedLogs > 0) {
            logger.info(
              { prunedTasks, prunedLogs },
              'Pruned old completed tasks and run logs',
            );
          }
        } catch (err) {
          logger.error({ err }, 'Retention sweep failed');
        }
      }

      // Cap catch-up per tick so a post-downtime backlog drains over several
      // ticks instead of slamming the queue all at once. computeNextRun already
      // coalesces missed windows, so remaining overdue tasks fire on later ticks.
      const dueTasks = getDueTasks().slice(0, SCHEDULER_MAX_CATCHUP_PER_TICK);
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Overlap guard: skip a task whose previous run is still in flight.
        if (runningTasks.has(currentTask.id)) {
          logger.debug(
            { taskId: currentTask.id },
            'Previous run still in flight, deferring (overlap)',
          );
          continue;
        }

        runningTasks.add(currentTask.id);
        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
