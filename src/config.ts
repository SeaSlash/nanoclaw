import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Scheduler robustness knobs.
// Cap how many overdue tasks the scheduler enqueues per tick so a post-downtime
// backlog drains over several ticks instead of slamming the container queue.
export const SCHEDULER_MAX_CATCHUP_PER_TICK = Math.max(
  1,
  parseInt(process.env.SCHEDULER_MAX_CATCHUP_PER_TICK || '5', 10) || 5,
);
// Retention: completed one-shot tasks and old run logs are pruned by the scheduler.
export const TASK_RETENTION_MS = parseInt(
  process.env.TASK_RETENTION_MS || String(7 * 24 * 60 * 60 * 1000),
  10,
); // 7 days — how long to keep completed `once` tasks before deletion
export const TASK_LOG_RETENTION_MS = parseInt(
  process.env.TASK_LOG_RETENTION_MS || String(30 * 24 * 60 * 60 * 1000),
  10,
); // 30 days — how long to keep task_run_logs rows

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  // An explicitly configured zone (process.env or .env) is authoritative.
  const explicit = process.env.TZ || envConfig.TZ;
  if (explicit && isValidTimezone(explicit)) return explicit;

  // No valid explicit TZ: we must fall back to the host's system zone (or UTC).
  // That's silent date/weekday skew waiting to happen — scheduled-task firing
  // times, the container clock, and every proactive-message date all key off
  // TIMEZONE — so warn loudly rather than guessing quietly.
  console.warn(
    explicit
      ? `[config] TZ "${explicit}" is not a valid IANA timezone; falling back ` +
          'to the host system zone. Set a valid TZ in .env (e.g. ' +
          'TZ=America/Toronto) to avoid date/weekday skew.'
      : '[config] No TZ set in process.env or .env; falling back to the host ' +
          'system zone. Set TZ in .env (e.g. TZ=America/Toronto) to pin ' +
          'scheduled-task times and proactive-message dates.',
  );

  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (system && isValidTimezone(system)) return system;
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
