#!/bin/bash
# Cloud session setup (Claude Code on the web), run when a session starts or resumes. A fresh
# container has the Postgres server but not the test role, and no node_modules; after a restart the
# server is stopped. This makes `npm test` and `npm run typecheck` work from the first command. It
# does only what is missing, so running it again changes nothing:
#   - starts the Postgres cluster on port 5432 when it is down;
#   - makes sure the tests can log in as `voicelab` (tests/helpers.ts): creates the role, with no
#     more rights than they need (create databases and roles), or repairs its login;
#   - installs the npm dependencies when node_modules is missing or older than package-lock.json.
# It never blocks the session: whatever it did, or could not do, it tells Claude on stdout. One run
# at a time: a second one waits for the first, then finds nothing left to do.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

LOG="${TMPDIR:-/tmp}/voicelab-session-setup.log"
# The lock is held on descriptor 9. Commands that can leave a process running (the Postgres server,
# npm) get it closed (9>&-), or that process would hold the lock for good and every later run wait.
exec 9>"${TMPDIR:-/tmp}/voicelab-session-setup.lock"
if ! flock -w "${SESSION_SETUP_LOCK_WAIT:-280}" 9; then
  echo "Cloud session setup is still running in another process; run \`CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh\` later if database tests or the typecheck fail."
  exit 0
fi

did=()
failed=()

# The cluster the tests use (port 5432), as "<version> <name> <status>": an online one if any is.
on5432=$(pg_lsclusters -h 2>/dev/null | awk '$3 == 5432 { print $1, $2, $4 }')
cluster=$(awk '$3 ~ /^online/ { print; exit }' <<<"$on5432")
[ -n "$cluster" ] || cluster=$(head -n 1 <<<"$on5432")
if [ -z "$cluster" ]; then
  failed+=("find a Postgres cluster on port 5432")
else
  read -r version name status <<<"$cluster"
  if [[ "$status" != online* ]]; then
    if pg_ctlcluster "$version" "$name" start >>"$LOG" 2>&1 9>&-; then did+=("started Postgres $version"); status=online
    else failed+=("start Postgres (pg_ctlcluster $version $name start)"); fi
  fi
  # The login the tests use. Someone who points the tests elsewhere (TEST_ADMIN_DATABASE_URL) set up their own.
  if [[ "$status" == online* ]] && [ -z "${TEST_ADMIN_DATABASE_URL:-}" ]; then
    if ! PGPASSWORD=voicelab PGCONNECT_TIMEOUT=5 psql -X -h localhost -U voicelab -d postgres -tAqc 'SELECT 1' >/dev/null 2>>"$LOG"; then
      if found=$(runuser -u postgres -- psql -XtAq -c "SELECT 1 FROM pg_roles WHERE rolname = 'voicelab'" 2>>"$LOG"); then
        if [ "$found" = "1" ]; then sql="ALTER ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'"; what="repaired the voicelab test role's login"
        else sql="CREATE ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'"; what="created the voicelab test role"; fi
        if runuser -u postgres -- psql -Xq -c "$sql" >>"$LOG" 2>&1; then did+=("$what")
        else failed+=("set up the voicelab test role"); fi
      else failed+=("check the voicelab test role (as the postgres user)"); fi
    fi
  fi
fi

# `-nt` is also true when node_modules has no record of a finished install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  if timeout 240 npm ci --no-audit --no-fund >>"$LOG" 2>&1 9>&-; then did+=("installed the npm dependencies")
  else failed+=("install the npm dependencies (npm ci)"); fi
fi

join() { local IFS=';'; echo "$*" | sed 's/;/, /g'; }
[ ${#did[@]} -eq 0 ] || echo "Cloud session setup: $(join "${did[@]}")."
[ ${#failed[@]} -eq 0 ] || echo "Cloud session setup could not $(join "${failed[@]}"), so database tests or the typecheck may fail. The details are in $LOG. Run \`CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh\` to try again, and tell the owner if it still fails."
exit 0
