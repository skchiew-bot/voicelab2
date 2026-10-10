#!/bin/bash
# Cloud session setup (Claude Code on the web). A fresh container has the Postgres server but not
# the test role, and no node_modules; after a restart the server is stopped. This makes
# `npm test` and `npm run typecheck` work from the first command. It does only what is missing,
# so running it again changes nothing:
#   - starts the Postgres cluster on port 5432 when it is down;
#   - creates the `voicelab` login role the tests connect as (tests/helpers.ts), with no more
#     rights than they need (create databases and roles), when it is missing;
#   - installs the npm dependencies when node_modules is missing or older than package-lock.json.
# It never blocks the session: whatever it did, or could not do, it tells Claude on stdout.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

did=()
failed=()

# The cluster the tests use (port 5432), as "<version> <name> <status>".
cluster=$(pg_lsclusters -h 2>/dev/null | awk '$3 == 5432 { print $1, $2, $4; exit }')
if [ -z "$cluster" ]; then
  failed+=("find a Postgres cluster on port 5432")
else
  read -r version name status <<<"$cluster"
  if [ "$status" != "online" ]; then
    if pg_ctlcluster "$version" "$name" start >/dev/null 2>&1; then did+=("started Postgres $version"); status=online
    else failed+=("start Postgres (pg_ctlcluster $version $name start)"); fi
  fi
  if [ "$status" = "online" ]; then
    if found=$(runuser -u postgres -- psql -tAq -c "SELECT 1 FROM pg_roles WHERE rolname = 'voicelab'" 2>/dev/null); then
      if [ "$found" != "1" ]; then
        if runuser -u postgres -- psql -q -c "CREATE ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'" >/dev/null 2>&1; then
          did+=("created the voicelab test role")
        else failed+=("create the voicelab test role"); fi
      fi
    else failed+=("check for the voicelab test role"); fi
  fi
fi

# `-nt` is also true when node_modules has no record of an install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  if npm ci --no-audit --no-fund >/dev/null 2>&1; then did+=("installed the npm dependencies")
  else failed+=("install the npm dependencies (npm ci)"); fi
fi

join() { local IFS=';'; echo "$*" | sed 's/;/, /g'; }
[ ${#did[@]} -eq 0 ] || echo "Cloud session setup: $(join "${did[@]}")."
[ ${#failed[@]} -eq 0 ] || echo "Cloud session setup could not $(join "${failed[@]}"), so database tests or the typecheck may fail. Run \`CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh\` to try again, and tell the owner if it still fails."
exit 0
