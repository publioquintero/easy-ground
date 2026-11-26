#!/usr/bin/env bash
# Copy the app to the server and (re)start it in production mode.
#   deploy/deploy.sh <ssh-host> [remote-dir]      e.g. deploy/deploy.sh myvps
# The server needs Docker, and two files created once by hand (they are never copied):
#   <remote-dir>/backend/.env   GOOGLE_MAPS_API_KEY=...
#   <remote-dir>/deploy/.env    from deploy/.env.example
set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <ssh-host> [remote-dir]}
DIR=${2:-easy-ground}
cd "$(dirname "$0")/.."

# Excluded files are also safe from --delete, so the server's .env files stay.
# --inplace keeps each file's inode: Caddy mounts its single Caddyfile, and a replaced
# file would stay invisible to the running container.
rsync -az --inplace --delete --exclude-from=deploy/rsync-exclude ./ "$HOST:$DIR/"

ssh "$HOST" "cd '$DIR' && \
  test -f backend/.env || { echo 'Missing $DIR/backend/.env (GOOGLE_MAPS_API_KEY)'; exit 1; } && \
  test -f deploy/.env || { echo 'Missing $DIR/deploy/.env (copy deploy/.env.example)'; exit 1; } && \
  docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile app \
    up -d --build --remove-orphans && \
  docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile app \
    exec -T caddy caddy reload --config /etc/caddy/Caddyfile && \
  docker image prune -f >/dev/null && \
  docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile app ps"
