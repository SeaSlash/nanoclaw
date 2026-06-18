#!/usr/bin/env node
//
// Installs Nova's read-only proactive daily routines for the `personal` group.
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
const DELIVERY = `<delivery_contract>
Your entire final reply is auto-posted to the Discord channel verbatim — only <internal>…</internal> blocks are stripped. So output only the digest text: no preamble ("Here is…"), no tool commentary, no sign-off outside the digest. To post nothing at all, make your entire final reply a single <internal>…</internal> block.
</delivery_contract>`;

// Shared: persist what the routine surfaced so a REPLY to it has context. Steph's
// replies are handled by Nova in a SEPARATE session that cannot see this digest —
// without this file it guesses the wrong name/channel/item. (One allowed file write.)
const NUDGE_CONTEXT = `When you do post a digest, before your final reply also write /workspace/group/.last-nudge.json so a reply to it has context. Format: { "at": "<the ISO value from the [DATE CONTEXT] line, copied verbatim — do not guess it>", "nudge": "<one-line gist of what you posted>", "items": [ for each actionable item you surfaced: { "sourceType": "email" | "sms" | "social" | "task", "sourceId": "<its id>", "title": "<sender / subject / task description>", "body": "<short preview>" } ] }. Use the Write tool — this single file write is allowed despite the read-only rule. If you posted nothing, do not write the file.`;

const TASK_DEFINITIONS = [
  {
    id: 'routine-morning-brief',
    scheduleType: 'cron',
    scheduleValue: '0 7 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — MORNING BRIEF] Automated 07:00 sweep. You are Nova. This was not sent by Steph and is not from anyone in the chat — just produce the brief.

${DELIVERY}

1. Call mcp__oslo__get_brief to fetch today's tasks (overdue / due today), Google Calendar events, today's shift, unread email & social counts, bookings, and weather. If you need shift timing detail, also call mcp__oslo__get_shifts for today.
2. Compose one concise brief, under ~1800 characters (Discord splits anything over 2000). Use the "AM Brief Format" in your CLAUDE.md. Lead with time-sensitive items (overdue / due-today tasks, today's shift, calendar conflicts), then unread counts, then weather. Build bullets only from the returned data — do not invent.
3. Schedule conflict check (today): if today is a working shift, follow the "Schedule Awareness" procedure in your CLAUDE.md — call mcp__oslo__find_shift_conflicts for today and also look at home-required items due today (bins, deliveries, home chores, home maintenance, custody exchanges, Sebastien pickups, in-home appointments) that fall in away hours (find_shift_conflicts only catches tasks that have a scheduledStart time). If any, add a short "⚠️ Schedule conflicts" block naming each task, the conflict, and a suggested at-home time (or a day off). If none, omit the block.
4. This routine is read-only: your only actions are the read tools above plus the single .last-nudge.json write. For any change — sending a reply, moving a bin, rescheduling a task — describe it and ask Steph to confirm; the send_* / set_* / reschedule_* tools are off-limits here. End by offering next actions, e.g. "Want me to move the blue bin to 7:30pm, or draft replies?"
5. ${NUDGE_CONTEXT} (Surface the unread emails — each get_brief recent email has an \`id\` — and overdue/due-today tasks as the items.)

<on_error>If get_brief errors, do not post a broken brief — reply with only <internal>brief failed: …</internal> so nothing is posted (it runs again tomorrow).</on_error>`,
  },
  {
    id: 'routine-wrap-up',
    scheduleType: 'cron',
    scheduleValue: '0 21 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — EVENING WRAP-UP] Automated 21:00 recap. You are Nova. Not sent by Steph — just produce the recap.

${DELIVERY}

1. Call mcp__oslo__wrap_up (read-only) to get today's & tomorrow's shift plus open overdue + due-today tasks (rollover candidates).
2. Compose one concise recap, under ~1800 characters: what's still open (overdue / due today), tomorrow's shift, and which tasks look like rollover candidates. Build only from the returned data.
3. Schedule conflict check (tomorrow): if tomorrow is a working shift, follow the "Schedule Awareness" procedure in your CLAUDE.md — call mcp__oslo__find_shift_conflicts for tomorrow and also look at home-required items due tomorrow (bins, deliveries, home chores, home maintenance, custody exchanges, Sebastien pickups, in-home appointments) that fall in away hours (find_shift_conflicts only catches tasks that have a scheduledStart time). If any, add a short "⚠️ Tomorrow's schedule conflicts" block naming each task, the conflict, and a suggested at-home time (or a day off). If none, omit the block.
4. This routine is read-only: describe any rollover or change and ask Steph to confirm first — the reschedule_tasks / update_task / send_* / set_* tools are off-limits here. End by asking, e.g. "Want me to move the blue bin to tomorrow 7:30pm, or roll any tasks forward?"
5. ${NUDGE_CONTEXT} (Use the open/rollover tasks as the items, sourceType "task".)

<on_error>If wrap_up errors, reply with only <internal>wrap_up failed: …</internal> so nothing is posted.</on_error>`,
  },
  {
    id: 'routine-triage-digest',
    scheduleType: 'cron',
    scheduleValue: '0 12 * * *',
    contextMode: 'isolated',
    prompt: `[PROACTIVE ROUTINE — MIDDAY REPLY DIGEST] Automated 12:00 rollup. You are Nova. Not sent by Steph — just produce the digest.

${DELIVERY}

1. Call mcp__oslo__needs_reply (read-only) to list email / SMS / social items awaiting a reply, ranked. (Don't call triage_inbox — it persists labels, which is a write.)
2. This digest is independent of the proactive poll: the every-5-minute poll already handles fresh nudges and owns /pending + /ack, so leave those to it — calling them here would double-handle items. Frame this as a standing running tally ("12 items awaiting a reply — top 3: …"), not a new-item alert, and don't describe items as "new".
3. If needs_reply returns zero items, post nothing: reply with only <internal>no items awaiting reply</internal>.
4. Otherwise compose one concise digest, under ~1800 characters: the total count plus the top few by rank (sender + a one-line gist taken from the data — do not invent).
5. This routine is read-only: describe any reply you'd send and ask Steph first — the draft_reply / refine_reply / send_reply / send_* / set_* tools are off-limits here. End by asking, e.g. "Want me to draft replies to any of these?"
6. ${NUDGE_CONTEXT} (Use the needs_reply items you listed — each has channel + id + who — as the items: sourceType=channel, sourceId=id, title=who/subject.)

<on_error>If needs_reply errors, reply with only <internal>needs_reply failed: …</internal> so nothing is posted.</on_error>`,
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
