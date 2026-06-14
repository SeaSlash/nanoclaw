#!/usr/bin/env node
//
// Installs the OpenClaw proactive-poll scheduled task for the `personal` group (Friday).
//
// Every 5 minutes a pre-LLM bash gate (runs INSIDE the agent container) curls
// /pending; the expensive LLM agent only wakes when there are real un-acked items
// AND it is outside quiet hours. On wake, Friday summarizes the items into ONE
// Discord message via the send_message tool, then acks exactly what it surfaced
// (server-side dedup). Idempotent — re-running updates the existing task in place
// without deferring an imminent poll.
//
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const GROUP_FOLDER = 'personal';
const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Always use www: the bare domain 307-redirects on GET and POST.
const BASE = 'https://www.stephanesimon.cloud/api/integrations/openclaw';

// Quiet hours (Steph's documented preference in groups/personal/CLAUDE.md): the
// poll stays silent 21:00–06:59 local and resumes at 07:00. Computed in the gate
// via the container clock so no overnight LLM wake or Discord post happens.
const QUIET_TZ = 'America/Toronto';

// The poll task uses a DEDICATED READ-ONLY secret (OPENCLAW_POLL_SECRET) that
// unlocks ONLY /pending and /ack — NOT the master OPENCLAW_WEBHOOK_SECRET, which
// stays on the action/MCP endpoints (/brief, /create-task, /complete-task, MCP).
// It is read from .env / the environment so it is never a literal in this committed
// script (scripts/ is NOT gitignored), then baked into the task's gate + prompt at
// install time, reaching the container via the task row's stdin (containers get no
// host env vars — src/container-runner.ts forwards only TZ + the proxy placeholders).
const SECRET_ENV = 'OPENCLAW_POLL_SECRET';
function readSecret() {
  // .env is authoritative for the installer (the operator just edited it); a
  // value exported into the shell/launchd env is only a fallback.
  let secret;
  let source;

  if (existsSync(ENV_PATH)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${SECRET_ENV}\\s*=\\s*(.*)$`);
    for (const raw of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const line = raw.replace(/\r$/, '');
      const m = line.match(re);
      if (!m) continue;
      let v = m[1].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1); // quoted value — keep verbatim
      } else {
        v = v.replace(/\s+#.*$/, '').trim(); // strip trailing inline comment
      }
      if (v) {
        secret = v;
        source = '.env';
      }
      break;
    }
  }
  if (!secret && process.env[SECRET_ENV]?.trim()) {
    secret = process.env[SECRET_ENV].trim();
    source = 'process.env';
  }

  if (!secret) {
    throw new Error(
      `${SECRET_ENV} not found in .env or environment — add it to .env first.`,
    );
  }
  // The secret is baked into shell + curl lines. Refuse anything that could break
  // quoting or be mangled by the shell (", $, `, \\, spaces, #, …). Fail loud at
  // install rather than silently shipping a malformed auth header.
  if (!/^[A-Za-z0-9._-]+$/.test(secret)) {
    throw new Error(
      `${SECRET_ENV} contains characters outside [A-Za-z0-9._-]; ` +
        'refusing to bake an unsafe value into the task shell/curl.',
    );
  }
  const fp = `${secret.length} chars, ${secret.slice(0, 4)}…${secret.slice(-4)}`;
  console.log(`Secret source: ${source} (${fp})`);
  return secret;
}
const SECRET = readSecret();

// Single-quote the secret for bash (validated above to contain no metacharacters,
// so the '\\'' escape is a formality but kept correct).
const SH_SECRET = `'${SECRET.replace(/'/g, "'\\''")}'`;

// Pre-LLM gate. Last stdout line MUST be JSON {"wakeAgent":bool,"data":{...}}
// (runScript contract). Server contract: HTTP 200 with {ok,count,items} where
// count===items.length on success; ANY non-200 is an error (body has an `error`
// field), never "nothing pending". The gate captures the HTTP status separately
// (curl -w) and the node program (node is guaranteed in the image; system tzdata
// is not, so time is resolved via Node's bundled ICU, not the shell `date`):
//   - enforces quiet hours (no overnight wake/post),
//   - on non-200, stays asleep but records data.err="http <code>" — logged and
//     retried next tick, so a bad/expired secret never reads as "nothing pending",
//   - on 200, wakes only when items.length > 0,
//   - fails safe: an unparseable 200 body leaves wakeAgent=false.
const GATE_NODE = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{var o={wakeAgent:false,data:{}};try{var h=parseInt(new Intl.DateTimeFormat("en-GB",{timeZone:"${QUIET_TZ}",hour:"2-digit",hour12:false}).format(new Date()),10)%24;if(h>=21||h<7){o.data.quiet=true;process.stdout.write(JSON.stringify(o)+"\\n");return;}}catch(e){}var code=process.env.HTTP_CODE||"";if(code!=="200"){o.data.err="http "+code;process.stdout.write(JSON.stringify(o)+"\\n");return;}try{var j=JSON.parse(s);var n=Array.isArray(j.items)?j.items.length:(typeof j.count==="number"?j.count:0);o.data.count=n;o.wakeAgent=n>0;}catch(e){o.data.err="unparseable";}process.stdout.write(JSON.stringify(o)+"\\n");});`;

const GATE_SCRIPT = `#!/usr/bin/env bash
SECRET=${SH_SECRET}
URL="${BASE}/pending"
OUT="$(curl -s -m 20 -w $'\\n%{http_code}' -H "x-openclaw-secret: $SECRET" "$URL")"
HTTP_CODE="$(printf '%s' "$OUT" | tail -n1)"
BODY="$(printf '%s' "$OUT" | sed '$d')"
printf '%s' "$BODY" | HTTP_CODE="$HTTP_CODE" node -e '${GATE_NODE}'
`;

const POLL_PROMPT = `[PROACTIVE POLL] The pre-check found un-acked items on Steph's dashboard. Do exactly the steps below, then stop. Do not start any unrelated work.

You are Friday. This is an automated proactive sweep of Steph's inbox/tasks/routines/shift. Ignore the stale count in the "Script output" block above — ALWAYS re-fetch for the authoritative current list.

ABSOLUTE RULE — applies to EVERY path below, whether you post or stop:
Your final turn reply is auto-forwarded to Discord. So your ENTIRE final reply must be ONLY an <internal>…</internal> block with NOTHING before or after it (e.g. <internal>posted 4 items, acked</internal>, or <internal>nothing pending, stopped</internal>). The brief itself reaches Steph ONLY through the send_message tool — never as your final reply. Any text outside <internal> tags gets posted to Steph as a separate message.

1) Re-fetch current items:
   curl -s -m 20 -H "x-openclaw-secret: ${SECRET}" ${BASE}/pending
   A success is HTTP 200 with { "ok": true, "count": N, "items": [ { "sourceType", "sourceId", "kind", "title", "body" }, ... ] } (count === items.length). Any non-200 / error response carries an "error" field instead of items.

2) STOP conditions:
   - If the call errors or returns non-200 (e.g. a bad/expired secret): treat it as a transient failure — do NOT post, do NOT ack, end with your <internal> status only. It retries next tick. NEVER read an error as "nothing pending".
   - If it returns 200 but items is empty (count 0): also STOP — no send_message, no ack, end with your <internal> status only (the items were handled since the pre-check). Never send an empty or "nothing to report" message.

3) Otherwise compose ONE concise Discord message and deliver it with the send_message tool (NOT as your final reply):
   - Keep it UNDER ~1800 characters. Discord hard-splits anything over 2000 chars mid-line into multiple garbled posts — if there are more items than fit, lead with the most important and summarize the rest as counts (e.g. "+5 more needs-reply emails").
   - Group related items (several needs_reply emails together; overdue/due-today tasks together; routines; today's shift).
   - Lead with what matters most: overdue/due-today tasks and emails from important senders (legal team, a fire chief, client/FR orders) first; routine/FYI last.
   - Short bullets built from each item's title/body — do NOT invent details.
   - Re-surfaced reminders: a needs_reply email reappears ~2 days after a prior ack if it's still unanswered, and keeps doing so until replied to. Frame those as nudges ("Still waiting on a reply to …") rather than as brand-new. (Task/routine/shift items re-surface once the next day.)
   - End with the obvious next action, e.g. "Want me to draft replies to any of these, or mark tasks done?"

4) ONLY AFTER the send_message tool has returned, ack EXACTLY the items you surfaced so they stop reappearing:
   curl -s -m 20 -X POST ${BASE}/ack \\
     -H "Content-Type: application/json" \\
     -H "x-openclaw-secret: ${SECRET}" \\
     -d '{"items": [ <the exact item objects you posted, each with at least sourceType, sourceId, kind> ]}'
   Ack only items you actually included. Always ack exactly what you posted — re-acking a re-surfaced item refreshes its ~2-day timer; if you post it but don't ack, it keeps nagging every tick.

5) ORDER MATTERS: call send_message FIRST, then ack. If send_message errors, do NOT ack (the item re-surfaces next run instead of being lost). If the ack call errors, that's fine — the item simply reappears next time.

Do not schedule tasks, do not modify files, do not do anything else. End with your <internal> status only.`;

const TASK = {
  id: 'task-openclaw-proactive-poll',
  scheduleType: 'cron',
  scheduleValue: '*/5 * * * *',
  contextMode: 'isolated',
  script: GATE_SCRIPT,
  prompt: POLL_PROMPT,
};

function computeNextRun(scheduleType, scheduleValue) {
  if (scheduleType === 'cron') {
    return CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE })
      .next()
      .toISOString();
  }
  throw new Error(`Unsupported schedule type: ${scheduleType}`);
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
    // re-running the installer doesn't push an imminent poll out by ~5 minutes.
    const scheduleChanged =
      existing.schedule_type !== task.scheduleType ||
      existing.schedule_value !== task.scheduleValue;
    const nextRun =
      scheduleChanged || !existing.next_run
        ? computeNextRun(task.scheduleType, task.scheduleValue)
        : existing.next_run;

    db.prepare(`
      UPDATE scheduled_tasks
         SET group_folder=?, chat_jid=?, prompt=?, schedule_type=?,
             schedule_value=?, context_mode=?, script=?, next_run=?, status=?
       WHERE id=?
    `).run(
      GROUP_FOLDER, group.jid, task.prompt, task.scheduleType,
      task.scheduleValue, task.contextMode, task.script, nextRun, 'active',
      task.id,
    );
    return { action: 'updated', nextRun };
  }

  const nextRun = computeNextRun(task.scheduleType, task.scheduleValue);
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
      context_mode, script, next_run, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id, GROUP_FOLDER, group.jid, task.prompt, task.scheduleType,
    task.scheduleValue, task.contextMode, task.script, nextRun, 'active', now,
  );
  return { action: 'created', nextRun };
}

function main() {
  if (!existsSync(STORE_DB_PATH)) {
    throw new Error(`NanoClaw store not found at ${STORE_DB_PATH}`);
  }
  const db = new Database(STORE_DB_PATH);
  db.pragma('busy_timeout = 5000'); // tolerate the running service holding the DB

  try {
    const group = db
      .prepare('SELECT jid, folder, name FROM registered_groups WHERE folder = ? LIMIT 1')
      .get(GROUP_FOLDER);
    if (!group?.jid) {
      throw new Error(`Registered group not found for folder "${GROUP_FOLDER}"`);
    }
    const r = upsertTask(db, group, TASK);
    console.log(
      `${r.action}: ${TASK.id} | ${TASK.scheduleType} ${TASK.scheduleValue} | ` +
        `next_run ${r.nextRun} | group ${group.name} (${group.jid}) | TZ ${TIMEZONE} | quiet ${QUIET_TZ} 21:00-07:00`,
    );
  } finally {
    db.close();
  }
}

main();
