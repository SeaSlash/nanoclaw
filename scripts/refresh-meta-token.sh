#!/usr/bin/env bash
#
# refresh-meta-token.sh — refresh the fire-content agent's Meta (Facebook/Instagram) tokens.
#
# You provide ONE thing: a short-lived USER access token from the Graph API Explorer
# (https://developers.facebook.com/tools/explorer/), generated against THIS app with the
# scopes listed below. The script then, using META_APP_ID/META_APP_SECRET already in
# meta.env:
#   1. exchanges it for a long-lived user token (renews the ~90-day data-access window),
#   2. validates it via debug_token,
#   3. derives the Page access token for FB_PAGE_ID via /me/accounts,
#   4. verifies the Page + Instagram account are reachable,
#   5. writes META_ACCESS_TOKEN + FB_PAGE_TOKEN into meta.env atomically (0600),
#      and stamps "# Last refreshed:" with today's date.
#
# Tokens are read via a hidden prompt and never echoed, never put in argv/history.
#
# Required scopes when generating the token in Graph API Explorer:
#   pages_show_list, business_management, pages_read_engagement, pages_manage_posts,
#   instagram_basic, instagram_content_publish, instagram_manage_messages, pages_messaging
#
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
META_ENV="${REPO_ROOT}/groups/fire-content/.secrets/meta.env"
GRAPH="https://graph.facebook.com/v21.0"

if [[ ! -f "${META_ENV}" ]]; then
  echo "ERROR: ${META_ENV} not found." >&2; exit 1
fi

# Load existing app creds + IDs (not the dead tokens).
set -a; . "${META_ENV}"; set +a
for v in META_APP_ID META_APP_SECRET FB_PAGE_ID IG_ACCOUNT_ID; do
  if [[ -z "${!v:-}" ]]; then echo "ERROR: ${v} missing from meta.env" >&2; exit 1; fi
done

# --- 1. Prompt for the short-lived user token ------------------------------
printf 'Paste SHORT-LIVED user token from Graph API Explorer (input hidden): '
IFS= read -rs SHORT
printf '\n'
SHORT="${SHORT#"${SHORT%%[![:space:]]*}"}"; SHORT="${SHORT%"${SHORT##*[![:space:]]}"}"
if [[ "${SHORT}" != EAA* ]]; then
  echo "ERROR: that doesn't look like a Meta token (should start 'EAA'). Nothing changed." >&2
  unset SHORT; exit 1
fi

# --- 2. Exchange short -> long-lived user token -----------------------------
echo "Exchanging for a long-lived user token..."
LONG=$(curl -s -G "${GRAPH}/oauth/access_token" \
  --data-urlencode 'grant_type=fb_exchange_token' \
  --data-urlencode "client_id=${META_APP_ID}" \
  --data-urlencode "client_secret=${META_APP_SECRET}" \
  --data-urlencode "fb_exchange_token=${SHORT}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); t=d.get("access_token"); (print(t) if t else sys.exit("  exchange failed: "+json.dumps(d.get("error",d))))')
unset SHORT

# --- 3. Validate the long-lived token via debug_token ----------------------
APPTOK=$(curl -s -G "${GRAPH%/v21.0}/oauth/access_token" \
  --data-urlencode "client_id=${META_APP_ID}" \
  --data-urlencode "client_secret=${META_APP_SECRET}" \
  --data-urlencode 'grant_type=client_credentials' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
echo "Validating new user token..."
USER_TOK="${LONG}" APP_TOK="${APPTOK}" python3 -c '
import os,sys,json,urllib.request,datetime
u=os.environ["USER_TOK"]; a=os.environ["APP_TOK"]
r=json.load(urllib.request.urlopen("https://graph.facebook.com/debug_token?input_token=%s&access_token=%s"%(u,a)))
d=r.get("data",{})
if not d.get("is_valid"): sys.exit("  new user token is not valid: "+json.dumps(d.get("error",{})))
exp=d.get("data_access_expires_at",0)
when=("never" if not exp else datetime.datetime.fromtimestamp(exp,datetime.UTC).strftime("%Y-%m-%d"))
print("  user token OK — data access now renewed until: "+when)
'

# --- 4. Derive the Page access token for FB_PAGE_ID -------------------------
echo "Fetching Page access token for page ${FB_PAGE_ID}..."
PAGE_TOK=$(USER_TOK="${LONG}" PAGE_ID="${FB_PAGE_ID}" python3 -c '
import os,sys,json,urllib.request
u=os.environ["USER_TOK"]; pid=os.environ["PAGE_ID"]
r=json.load(urllib.request.urlopen("https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&limit=200&access_token="+u))
if "error" in r: sys.exit("  /me/accounts error: "+json.dumps(r["error"]))
for p in r.get("data",[]):
    if p.get("id")==pid:
        sys.stderr.write("  matched page: %s\n"%p.get("name")); print(p["access_token"]); break
else:
    sys.exit("  page %s not found among your pages — are you an admin of it?"%pid)
')

# --- 5. Verify Page token + Instagram account reachable --------------------
echo "Verifying Page + Instagram reachability..."
PAGE_TOK="${PAGE_TOK}" IG="${IG_ACCOUNT_ID}" python3 -c '
import os,sys,json,urllib.request
t=os.environ["PAGE_TOK"]; ig=os.environ["IG"]
me=json.load(urllib.request.urlopen("https://graph.facebook.com/v21.0/me?fields=id,name&access_token="+t))
if "error" in me: sys.exit("  page token check failed: "+json.dumps(me["error"]))
print("  page token OK — %s"%me.get("name"))
r=json.load(urllib.request.urlopen("https://graph.facebook.com/v21.0/%s?fields=username,name&access_token=%s"%(ig,t)))
if "error" in r: sys.exit("  IG account %s not reachable: %s"%(ig,json.dumps(r["error"])))
print("  instagram OK — @%s"%r.get("username"))
'

# --- 6. Atomically rewrite meta.env (preserve structure) -------------------
TODAY="$(date -u +%Y-%m-%d)"
TMP="$(mktemp "${META_ENV}.XXXXXX")"; chmod 600 "${TMP}"
NEW_USER="${LONG}" NEW_PAGE="${PAGE_TOK}" TODAY="${TODAY}" SRC="${META_ENV}" DST="${TMP}" python3 -c '
import os
src=open(os.environ["SRC"]).read().splitlines(keepends=True)
u=os.environ["NEW_USER"]; p=os.environ["NEW_PAGE"]; today=os.environ["TODAY"]
out=[]
for ln in src:
    s=ln.rstrip("\n")
    if s.startswith("META_ACCESS_TOKEN="): out.append("META_ACCESS_TOKEN=%s\n"%u)
    elif s.startswith("FB_PAGE_TOKEN="):    out.append("FB_PAGE_TOKEN=%s\n"%p)
    elif s.startswith("# Last refreshed:"): out.append("# Last refreshed: %s\n"%today)
    else: out.append(ln if ln.endswith("\n") else ln+"\n")
open(os.environ["DST"],"w").write("".join(out))
'
mv "${TMP}" "${META_ENV}"; chmod 600 "${META_ENV}"
unset LONG PAGE_TOK APPTOK

echo
echo "✓ meta.env updated (META_ACCESS_TOKEN + FB_PAGE_TOKEN refreshed, mode 0600, stamped ${TODAY})."
echo "  The fire-content agent will pick these up on its next run — no service restart needed"
echo "  (container secrets are read per-run from the mounted .secrets dir)."
