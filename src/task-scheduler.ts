import { ChildProcess } from 'child_process';
import { request as httpRequest } from 'http';

import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ACTIVE_CONVERSATION_WINDOW_MS,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
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
import { detectAuthMode } from './credential-proxy.js';
import { PROXY_BIND_HOST } from './container-runtime.js';
import {
  getAllTasks,
  getDueTasks,
  getLastTaskRun,
  getLastUserMessageTimestamp,
  getRouterState,
  getTaskById,
  logTaskRun,
  pruneCompletedTasks,
  pruneOldTaskRunLogs,
  resetRetryCount,
  scheduleTaskRetry,
  setRouterState,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { looksLikeAuthFailure } from './router.js';
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
  sendMessage: (jid: string, text: string) => Promise<boolean>;
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

  // Don't let a proactive nudge interrupt an active conversation. Script-gated
  // tasks (the */5 poll) are "wake only if needed" sweeps; if Steph messaged this
  // chat within the active window, defer this tick — the pending items persist
  // server-side and the poll picks them up once the conversation lulls. Logged as
  // a no-op success so the heartbeat still sees the poll running.
  if (task.script) {
    const lastUserMsg = getLastUserMessageTimestamp(task.chat_jid);
    if (
      lastUserMsg &&
      Date.now() - new Date(lastUserMsg).getTime() <
        ACTIVE_CONVERSATION_WINDOW_MS
    ) {
      logger.info(
        { taskId: task.id, lastUserMsg },
        'Deferring proactive task — active conversation',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: 0,
        status: 'success',
        result: null,
        error: null,
      });
      updateTaskAfterRun(
        task.id,
        computeNextRun(task),
        'Deferred (active conversation)',
      );
      return;
    }
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
  let deliveryFailed = false;
  let authFailure = false;

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
          if (looksLikeAuthFailure(streamedOutput.result)) {
            // Expired/invalid token surfaced as normal text — do NOT post it to
            // the user. Mark the run failed so the heartbeat sees it and the poll
            // (if any) won't ack; the hourly OAuth probe sends the fix steps.
            authFailure = true;
            error = 'auth_failure';
            scheduleClose();
          } else {
            result = streamedOutput.result;
            // Forward to the user and capture whether delivery actually succeeded.
            const delivered = await deps.sendMessage(
              task.chat_jid,
              streamedOutput.result,
            );
            if (!delivered) deliveryFailed = true;
            scheduleClose();
          }
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
    } else if (output.result && !authFailure) {
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

  // A non-empty result that failed to deliver is a failed run — visible to the
  // heartbeat and eligible for the existing retry/backoff below.
  if (deliveryFailed && !error) {
    error = `delivery_failed: ${task.chat_jid}`;
  }
  // Auth failure: suppress the captured "Not logged in" text and confirm/alert
  // out-of-band (the probe only alerts if the token is genuinely 401).
  if (authFailure) {
    result = null;
    void maybeProbeOauth(deps).catch(() => {});
  }

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

// --- Reliability: host-side alerts, OAuth health probe, daily heartbeat ---
// All alerts go to the main group (registeredGroups is keyed by jid) via the
// existing deps.sendMessage wiring — no new send path, no new tables.

function mainGroupJid(deps: SchedulerDependencies): string | undefined {
  for (const [jid, g] of Object.entries(deps.registeredGroups())) {
    if (g.isMain === true) return jid;
  }
  return undefined;
}

const OAUTH_ALERT_KEY = 'oauth_alert_state';
const OAUTH_REALERT_MS = 12 * 60 * 60 * 1000; // re-alert at most ~twice/day while dead
// The proxy binds to PROXY_BIND_HOST (the container-bridge IP on macOS/Apple
// Container, or 0.0.0.0 elsewhere). Probe that exact host — 127.0.0.1 would miss
// a bridge-bound proxy and always read 'transient' (never detecting a dead token).
const PROBE_HOST =
  PROXY_BIND_HOST === '0.0.0.0' ? '127.0.0.1' : PROXY_BIND_HOST;

// Probe the credential proxy with a placeholder Bearer token; the proxy swaps in
// the real OAuth token, so 200 = healthy, 401 = expired/invalid, anything else =
// transient (network/upstream) which must NOT be read as a dead token.
function probeCredentialProxy(): Promise<'healthy' | 'dead' | 'transient'> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const req = httpRequest(
      {
        host: PROBE_HOST,
        port: CREDENTIAL_PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        timeout: 15000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer placeholder',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        res.resume(); // drain
        resolve(code === 200 ? 'healthy' : code === 401 ? 'dead' : 'transient');
      },
    );
    req.on('error', () => resolve('transient'));
    req.on('timeout', () => {
      req.destroy();
      resolve('transient');
    });
    req.write(body);
    req.end();
  });
}

// Alert Steph that the OAuth token is dead, with the exact refresh steps.
// De-duped via router_state (edge + ~12h) so an outage doesn't spam.
async function alertOauthExpired(deps: SchedulerDependencies): Promise<void> {
  const now = Date.now();
  let state: { status?: string; at?: number } = {};
  try {
    state = JSON.parse(getRouterState(OAUTH_ALERT_KEY) || '{}');
  } catch {
    state = {};
  }
  if (
    state.status === 'dead' &&
    state.at &&
    now - state.at < OAUTH_REALERT_MS
  ) {
    return; // already alerted recently
  }
  const jid = mainGroupJid(deps);
  if (!jid) {
    logger.error('OAuth token appears expired but no main group to alert');
    return;
  }
  const msg =
    '⚠️ Nova auth problem: the Claude OAuth token looks expired or invalid, so scheduled tasks can’t reach the model. Fix it: run `claude setup-token`, then `bash scripts/refresh-oauth-token.sh` (it updates .env and restarts the service).';
  const delivered = await deps.sendMessage(jid, msg);
  if (delivered) {
    setRouterState(
      OAUTH_ALERT_KEY,
      JSON.stringify({ status: 'dead', at: now }),
    );
    logger.warn('Alerted main group: OAuth token expired');
  }
}

function clearOauthAlert(): void {
  try {
    const state = JSON.parse(getRouterState(OAUTH_ALERT_KEY) || '{}');
    if (state.status === 'dead') {
      setRouterState(
        OAUTH_ALERT_KEY,
        JSON.stringify({ status: 'ok', at: Date.now() }),
      );
      logger.info('OAuth token healthy again');
    }
  } catch {
    /* ignore */
  }
}

// Hourly in OAuth mode: probe and alert on a dead token before the next brief
// tries to run. Host-side so it still fires when the token is dead.
async function maybeProbeOauth(deps: SchedulerDependencies): Promise<void> {
  if (detectAuthMode() !== 'oauth') return;
  const status = await probeCredentialProxy();
  if (status === 'dead') await alertOauthExpired(deps);
  else if (status === 'healthy') clearOauthAlert();
}

const HEARTBEAT_KEY = 'heartbeat_last_run';
const HR = 60 * 60 * 1000;
// Routines whose runs we expect. The poll logs a run every 5 min around the clock
// (gate-skipped quiet-hours runs still log success), so a stale poll means the
// whole scheduler/container path is down.
const HEARTBEAT_CHECKS: { id: string; label: string; maxAgeMs: number }[] = [
  { id: 'routine-morning-brief', label: '7am brief', maxAgeMs: 26 * HR },
  { id: 'routine-triage-digest', label: 'noon digest', maxAgeMs: 26 * HR },
  { id: 'routine-wrap-up', label: '9pm wrap-up', maxAgeMs: 26 * HR },
  { id: 'task-openclaw-proactive-poll', label: '5-min poll', maxAgeMs: 2 * HR },
];

function localDateHour(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const hour = parseInt(get('hour'), 10) % 24; // some ICU builds emit "24" at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

// Once/day after the evening routines, confirm each expected routine ran and
// succeeded recently; alert naming only what broke. Silent when all green.
async function runHeartbeat(deps: SchedulerDependencies): Promise<void> {
  const { date, hour } = localDateHour();
  if (hour < 22) return; // wait until after the 9pm wrap-up
  if (getRouterState(HEARTBEAT_KEY) === date) return; // already checked today

  const now = Date.now();
  const problems: string[] = [];
  for (const c of HEARTBEAT_CHECKS) {
    const last = getLastTaskRun(c.id);
    if (!last) {
      problems.push(`${c.label}: no runs recorded`);
      continue;
    }
    const ageMs = now - new Date(last.run_at).getTime();
    if (ageMs > c.maxAgeMs) {
      problems.push(`${c.label}: last ran ${Math.round(ageMs / HR)}h ago`);
    } else if (last.status === 'error') {
      problems.push(`${c.label}: failed (${last.error || 'error'})`);
    }
  }

  if (problems.length === 0) {
    setRouterState(HEARTBEAT_KEY, date); // healthy — don't recheck today
    return;
  }
  const jid = mainGroupJid(deps);
  if (!jid) {
    logger.error({ problems }, 'Heartbeat found problems but no main group');
    return;
  }
  const msg = `⚠️ Nova self-check (${date}) found routine problems:\n• ${problems.join('\n• ')}\n\nCheck logs/nanoclaw.log or task_run_logs.`;
  const delivered = await deps.sendMessage(jid, msg);
  if (delivered) setRouterState(HEARTBEAT_KEY, date);
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

        // OAuth token health (oauth mode only) + daily heartbeat self-monitor.
        // Best-effort and network-bound, so run them without blocking the tick.
        void maybeProbeOauth(deps).catch((err) =>
          logger.error({ err }, 'OAuth health probe failed'),
        );
        void runHeartbeat(deps).catch((err) =>
          logger.error({ err }, 'Heartbeat self-monitor failed'),
        );
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
