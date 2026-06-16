#!/usr/bin/env node
//
// Installs Friday's read-only proactive daily routines for the `personal` group.
//
// These are NEW scheduled tasks, fully separate from the protected */5
// `/pending` proactive-poll task (scripts/install-openclaw-poll-task.mjs) — they
// do NOT touch /pending or /ack and use a different delivery model. Each routine
// is a fixed-time daily wake (no pre-LLM bash gate): the agent fetches via a
// READ-ONLY Oslo MCP tool and the digest is its final reply, which the scheduler
// auto-forwards to Discord (formatOutbound strips <internal>…</internal>, so an
// all-internal reply posts nothing). Routines NEVER send/modify anything — they
// digest and ask; any outbound/destructive Oslo tool stays behind Steph's
// confirmation (reinforced in groups/personal/CLAUDE.md).
//
// Idempotent: re-running updates each task in place and preserves the pending
// next_run unless the schedule itself changed (so it won't push an imminent run).
//
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUP_FOLDER = 'personal';
const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Shared preamble: scheduled-task results are auto-forwarded to Discord verbatim
// (only <internal>…</internal> blocks are stripped), so the agent must output the
// digest and nothing else.
const DELIVERY = `Your ENTIRE final reply is auto-posted to the Discord channel verbatim — only <internal>…</internal> blocks are stripped. So output ONLY the digest text: no preamble ("Here is…"), no tool commentary, no closing sign-off outside the digest. To post nothing at all, make your entire final reply a single <internal>…</internal> block.`;

const TASK_DEFINITIONS = [
  {
    id: 'routine-morning-brief',
    scheduleType: 'cron',
    scheduleValue: '0 7 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — MORNING BRIEF] Automated 07:00 sweep. You are Friday. This was not sent by Steph and is not from anyone in the chat — just produce the brief.

${DELIVERY}

1. Call mcp__oslo__get_brief to fetch today's tasks (overdue / due today), Google Calendar events, today's shift, unread email & social counts, bookings, and weather. If you need shift timing detail, also call mcp__oslo__get_shifts for today.
2. Compose ONE concise brief, UNDER ~1800 characters (Discord splits anything over 2000). Use the "AM Brief Format" in your CLAUDE.md. Lead with time-sensitive items (overdue / due-today tasks, today's shift, calendar conflicts), then unread counts, then weather. Build bullets ONLY from the returned data — do not invent.
3. SCHEDULE CONFLICT CHECK (today): if today is a working shift, follow the "Schedule Awareness" procedure in your CLAUDE.md — call mcp__oslo__find_shift_conflicts for today AND also look at home-required tasks due today (bins, deliveries, home chores, home maintenance) that fall in away hours (find_shift_conflicts only catches tasks that have a scheduledStart time). If any, add a short "⚠️ Schedule conflicts" block naming each task, the conflict, and a suggested at-home time (or a day off). If none, omit the block.
4. READ-ONLY routine: do NOT send any email/SMS/social reply, do NOT modify tasks or shifts, do NOT call any send_* / set_* / reschedule_* tool — for conflicts only SUGGEST a time and ask. End by offering next actions, e.g. "Want me to move the blue bin to 7:30pm, or draft replies?"

If get_brief errors, do not post a broken brief — reply with only <internal>brief failed: …</internal> so nothing is posted (it runs again tomorrow).`,
  },
  {
    id: 'routine-wrap-up',
    scheduleType: 'cron',
    scheduleValue: '0 21 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — EVENING WRAP-UP] Automated 21:00 recap. You are Friday. Not sent by Steph — just produce the recap.

${DELIVERY}

1. Call mcp__oslo__wrap_up (READ-ONLY) to get today's & tomorrow's shift plus open overdue + due-today tasks (rollover candidates).
2. Compose ONE concise recap, UNDER ~1800 characters: what's still open (overdue / due today), tomorrow's shift, and which tasks look like rollover candidates. Build only from the returned data.
3. SCHEDULE CONFLICT CHECK (tomorrow): if tomorrow is a working shift, follow the "Schedule Awareness" procedure in your CLAUDE.md — call mcp__oslo__find_shift_conflicts for tomorrow AND also look at home-required tasks due tomorrow (bins, deliveries, home chores, home maintenance) that fall in away hours (find_shift_conflicts only catches tasks that have a scheduledStart time). If any, add a short "⚠️ Tomorrow's schedule conflicts" block naming each task, the conflict, and a suggested at-home time (or a day off). If none, omit the block.
4. READ-ONLY routine: do NOT actually roll anything forward — do NOT call reschedule_tasks / update_task or any send_* / set_* tool; for conflicts only SUGGEST times and ask. End by asking, e.g. "Want me to move the blue bin to tomorrow 7:30pm, or roll any tasks forward?" (Steph confirms first.)

If wrap_up errors, reply with only <internal>wrap_up failed: …</internal> so nothing is posted.`,
  },
  {
    id: 'routine-triage-digest',
    scheduleType: 'cron',
    scheduleValue: '0 12 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — MIDDAY REPLY DIGEST] Automated 12:00 rollup. You are Friday. Not sent by Steph — just produce the digest.

${DELIVERY}

1. Call mcp__oslo__needs_reply (READ-ONLY) to list email / SMS / social items awaiting a reply, ranked. Do NOT call triage_inbox (it persists labels — that's a write), and do NOT touch /pending or /ack.
2. This is a STANDING DAILY SUMMARY, not a new-item alert — the every-5-minute proactive poll already handles fresh nudges. Frame it as a running tally ("12 items awaiting a reply — top 3: …"). Do NOT describe items as "new". NEVER call /ack.
3. If needs_reply returns zero items, post NOTHING: reply with only <internal>no items awaiting reply</internal>.
4. Otherwise compose ONE concise digest, UNDER ~1800 characters: the total count plus the top few by rank (sender + a one-line gist taken from the data — do not invent).
5. READ-ONLY routine: do NOT draft or send any reply — do NOT call draft_reply / refine_reply / send_reply or any send_* / set_* tool. End by asking, e.g. "Want me to draft replies to any of these?"

If needs_reply errors, reply with only <internal>needs_reply failed: …</internal> so nothing is posted.`,
  },
];

function ensureStoreExists() {
  if (!existsSync(STORE_DB_PATH)) {
    throw new Error(`NanoClaw store not found at ${STORE_DB_PATH}`);
  }
}

function computeNextRun(scheduleType, scheduleValue) {
  if (scheduleType === 'cron') {
    return CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE })
      .next()
      .toISOString();
  }
  throw new Error(`Unsupported schedule type: ${scheduleType}`);
}

function formatLocal(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function upsertTask(db, group, task) {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      'SELECT id, schedule_type, schedule_value, next_run FROM scheduled_tasks WHERE id = ?',
    )
    .get(task.id);

  if (existing) {
    // Preserve the pending next_run unless the schedule itself changed, so
    // re-running the installer doesn't push an imminent run out.
    const scheduleChanged =
      existing.schedule_type !== task.scheduleType ||
      existing.schedule_value !== task.scheduleValue;
    const nextRun =
      scheduleChanged || !existing.next_run
        ? computeNextRun(task.scheduleType, task.scheduleValue)
        : existing.next_run;

    db.prepare(`
      UPDATE scheduled_tasks
         SET group_folder = ?, chat_jid = ?, prompt = ?, schedule_type = ?,
             schedule_value = ?, context_mode = ?, script = NULL,
             next_run = ?, status = 'active'
       WHERE id = ?
    `).run(
      GROUP_FOLDER,
      group.jid,
      task.prompt,
      task.scheduleType,
      task.scheduleValue,
      task.contextMode,
      nextRun,
      task.id,
    );
    return { action: 'updated', nextRun };
  }

  const nextRun = computeNextRun(task.scheduleType, task.scheduleValue);
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
      context_mode, next_run, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    task.id,
    GROUP_FOLDER,
    group.jid,
    task.prompt,
    task.scheduleType,
    task.scheduleValue,
    task.contextMode,
    nextRun,
    now,
  );
  return { action: 'created', nextRun };
}

function main() {
  ensureStoreExists();
  const db = new Database(STORE_DB_PATH);
  db.pragma('busy_timeout = 5000'); // tolerate the running service holding the DB

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
      `Installing personal proactive routines for ${group.name} (${group.jid}) | TZ ${TIMEZONE}`,
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
