#!/usr/bin/env bash
# One-step install: writes .env with fresh secrets, starts Voice Lab, creates the
# first admin and runs a health check.
#   ./scripts/setup.sh admin@yourcompany.com
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_EMAIL="${1:-}"
if [ -z "$ADMIN_EMAIL" ]; then
  echo "Usage: ./scripts/setup.sh <admin-email>" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 1; }

if [ -f .env ]; then
  echo ".env already exists; keeping its secrets (delete it to start over)."
else
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "VOICELAB_SECRET_KEY=$(openssl rand -base64 32)"
  } > .env
  echo "Wrote .env. Back it up: without VOICELAB_SECRET_KEY, stored provider credentials cannot be read."
fi

docker compose up -d --build

echo "Waiting for Voice Lab to start..."
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
    echo "Health check passed."
    docker compose exec -T app npx tsx src/cli.ts bootstrap "$ADMIN_EMAIL"
    exit 0
  fi
  sleep 2
done
echo "Voice Lab did not become healthy. Check: docker compose logs app" >&2
exit 1
