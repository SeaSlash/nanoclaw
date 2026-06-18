#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUP_FOLDER = 'fire-content';
const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const TASK_DEFINITIONS = [
  {
    id: 'task-fire-content-strategy-refresh',
    scheduleType: 'cron',
    scheduleValue: '15 6 * * 1,3,5',
    contextMode: 'isolated',
    prompt: `<task>Run the fire-content adaptive strategy refresh.</task>
<steps>
1. Run \`node scripts/sync-instagram-data.mjs --limit=100 --classify\`.
2. Run \`node scripts/content-intel.mjs strategy-refresh\`.
3. Run \`node scripts/content-intel.mjs list-drafts --status needs_review,needs_revision,approved\`.
4. Read \`strategy/current.md\`.
</steps>
<report channel="fire-content" max_words="180">
Send one concise update with:
- the top 2 posting windows
- one material change, or "no material change"
- pending draft counts by status
- only the approvals that are actually blocking today's publishing — i.e. a draft whose suggested window is today/tomorrow and still in needs_review. The point is to surface only what Steph must decide now, not re-list everything pending.
</report>`,
  },
  {
    id: 'task-fire-content-draft-batch',
    scheduleType: 'cron',
    scheduleValue: '0 9 * * 1,4',
    contextMode: 'isolated',
    prompt: `<task>Run the fire-content evergreen draft batch.</task>
<steps>
1. Read \`strategy/current.md\`. If it is missing or older than 3 days, run \`node scripts/content-intel.mjs strategy-refresh\` first.
2. Run \`node scripts/content-intel.mjs list-drafts --status needs_review,needs_revision,approved\`.
3. If there are already 4 or more pending drafts, don't create more — send a short queue-health summary instead.
4. Otherwise create 2 non-job (evergreen) drafts that fit the current strategy and real performance data. These are evergreen content, not recruitment/job ads.
5. Save each draft with \`node scripts/content-intel.mjs save-draft ...\`, giving each a distinct pillar, hypothesis, and visual brief.
6. Draft only — don't approve or publish anything.
</steps>
<example kind="good">Pillar: behind-the-scenes craft | Hypothesis: process shots out-save finished-product shots for this audience | Visual brief: close-up of a recruit lacing bunker boots at 5am in a dim hall.</example>
<example kind="avoid">"Now hiring — Toronto Fire recruit class open, apply today" — that's a job ad, not evergreen content.</example>
<report channel="fire-content">
Send a concise review batch with the new draft IDs, titles, hypotheses, and suggested publish windows.
</report>`,
  },
  {
    id: 'task-fire-content-friday-retro',
    scheduleType: 'cron',
    scheduleValue: '0 17 * * 5',
    contextMode: 'isolated',
    prompt: `<task>Run the weekly fire-content retro.</task>
<steps>
1. Run \`node scripts/sync-instagram-data.mjs --limit=100 --classify\`.
2. Run \`node scripts/content-intel.mjs match-performance\`.
3. Run \`node scripts/content-intel.mjs strategy-refresh\`.
4. Review published adaptive drafts, queued drafts, and \`strategy/current.md\`.
</steps>
<report channel="fire-content">
Send one concise retro with:
- what won this week
- what underperformed or is still under-tested
- the best current evergreen window
- the next experiment to run
If no adaptive drafts have published yet, say that clearly and focus on queue health instead.
</report>`,
  },
];

function ensureStoreExists() {
  if (!existsSync(STORE_DB_PATH)) {
    throw new Error(`NanoClaw store not found at ${STORE_DB_PATH}`);
  }
}

function computeNextRun(scheduleType, scheduleValue) {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) {
      throw new Error(`Invalid interval schedule: ${scheduleValue}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid once timestamp: ${scheduleValue}`);
    }
    return date.toISOString();
  }

  throw new Error(`Unsupported schedule type: ${scheduleType}`);
}

function formatLocal(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function upsertTask(db, group, task) {
  const nextRun = computeNextRun(task.scheduleType, task.scheduleValue);
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
    .get(task.id);

  if (existing) {
    db.prepare(`
      UPDATE scheduled_tasks
         SET group_folder = ?,
             chat_jid = ?,
             prompt = ?,
             schedule_type = ?,
             schedule_value = ?,
             context_mode = ?,
             next_run = ?,
             status = ?
       WHERE id = ?
    `).run(
      GROUP_FOLDER,
      group.jid,
      task.prompt,
      task.scheduleType,
      task.scheduleValue,
      task.contextMode,
      nextRun,
      'active',
      task.id,
    );
    return { action: 'updated', nextRun };
  }

  db.prepare(`
    INSERT INTO scheduled_tasks (
      id,
      group_folder,
      chat_jid,
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      next_run,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    GROUP_FOLDER,
    group.jid,
    task.prompt,
    task.scheduleType,
    task.scheduleValue,
    task.contextMode,
    nextRun,
    'active',
    now,
  );
  return { action: 'created', nextRun };
}

function main() {
  ensureStoreExists();
  const db = new Database(STORE_DB_PATH);

  try {
    const group = db
      .prepare(
        'SELECT jid, folder, name FROM registered_groups WHERE folder = ? LIMIT 1',
      )
      .get(GROUP_FOLDER);
    if (!group?.jid) {
      throw new Error(`Registered group not found for folder "${GROUP_FOLDER}"`);
    }

    console.log(
      `Installing fire-content scheduled tasks for ${group.name} (${group.jid}) in ${TIMEZONE}`,
    );

    for (const task of TASK_DEFINITIONS) {
      const result = upsertTask(db, group, task);
      console.log(
        `- ${result.action}: ${task.id} | ${task.scheduleType} ${task.scheduleValue} | next ${formatLocal(result.nextRun)}`,
      );
    }
  } finally {
    db.close();
  }
}

main();
