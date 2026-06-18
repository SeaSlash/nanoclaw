#!/usr/bin/env bash
#
# refresh-oauth-token.sh — swap a fresh Claude OAuth token into .env and restart NanoClaw.
#
# The token is read via a silent prompt and never appears in your shell history,
# in process args, or on screen. It is written to .env with 0600 permissions.
#
# Usage:
#   1) Mint a token (browser login as you):   claude setup-token
#   2) Run this and paste it when prompted:    bash scripts/refresh-oauth-token.sh
#
set -euo pipefail
set +x  # never trace — keeps the secret out of any xtrace output

# Resolve repo root from this script's location, regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
LAUNCHD_LABEL="com.nanoclaw"
LOG_FILE="${REPO_ROOT}/logs/nanoclaw.log"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found." >&2
  exit 1
fi

# --- 1. Prompt for the token silently ---------------------------------------
printf 'Paste new CLAUDE_CODE_OAUTH_TOKEN (input hidden): '
IFS= read -rs TOKEN
printf '\n'

# Trim surrounding whitespace/newlines that often ride along on a paste.
TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"

# --- 2. Validate format -----------------------------------------------------
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: empty token — nothing changed." >&2
  exit 1
fi
if [[ "${TOKEN}" != sk-ant-oat01-* ]]; then
  echo "ERROR: token does not start with 'sk-ant-oat01-'." >&2
  echo "       (setup-token mints an OAuth token with that prefix.) Nothing changed." >&2
  unset TOKEN
  exit 1
fi

# --- 3. Atomic write into .env, preserving every other line -----------------
TMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
chmod 600 "${TMP_FILE}"
# Keep all non-token lines verbatim, then append the new token line.
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "${ENV_FILE}" > "${TMP_FILE}" || true
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "${TOKEN}" >> "${TMP_FILE}"
mv "${TMP_FILE}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
unset TOKEN
echo "✓ .env updated (CLAUDE_CODE_OAUTH_TOKEN replaced, mode 0600)."

# --- 4. Restart the service so the proxy reloads the token ------------------
echo "Restarting ${LAUNCHD_LABEL} ..."
launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"

# --- 5. Confirm the proxy came back up --------------------------------------
sleep 3
echo
echo "Most recent 'Credential proxy started' line:"
if grep -i 'credential proxy started' "${LOG_FILE}" 2>/dev/null | tail -n 1; then
  :
else
  echo "  (not seen yet — give it a few more seconds and check ${LOG_FILE})"
fi

echo
echo "Done. Send the bot a message (or wait for a scheduled task) to confirm an"
echo "agent run authenticates instead of replying 'Not logged in · Please run /login'."
