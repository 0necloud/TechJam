#!/usr/bin/env bash
# Deploy the control plane as a host process on a Linux VM.
#
# Airlock Runs execute in disposable Runtime containers that the control plane
# launches over the Docker CLI. The Compose profile therefore cannot serve a
# usable deployment: inside that container there is no Docker daemon, and
# RUNTIME_PROVIDER=local-process is refused by validateRunPolicy, so every Run
# fails closed. Airlock never mounts the Docker socket to work around this.
#
# This script installs Docker and Node.js on the host, builds the Runtime image
# and the application, then runs the control plane under systemd as a
# non-root user that belongs to the docker group.
#
# Usage (as root, from the repository root):
#   ./scripts/deploy-host.sh /path/to/.env.production
set -euo pipefail

env_file="${1:-.env.production}"
service_user="${SERVICE_USER:-airlock}"
install_dir="${INSTALL_DIR:-/opt/airlock}"
runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[deploy-host] %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this script as root (sudo)."
[[ -f "$env_file" ]] || fail "Environment file not found: $env_file"

# --- Required configuration ------------------------------------------------
# The server refuses to start in production on a non-loopback host without a
# 24+ character token, so check it here where the message is actionable.
token="$(grep -E '^APP_AUTH_TOKEN=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
if [[ ${#token} -lt 24 || "$token" == replace-* ]]; then
  fail "APP_AUTH_TOKEN in $env_file must be 24+ characters. Generate one with: openssl rand -hex 24"
fi
grep -qE '^ARK_API_KEY=.+' "$env_file" || fail "ARK_API_KEY is missing from $env_file"
grep -qE '^ARK_MODEL=.+' "$env_file" || fail "ARK_MODEL is missing from $env_file"

# --- Host packages ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
systemctl enable --now docker
docker info >/dev/null 2>&1 || fail "The Docker daemon is not reachable."

node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if (( node_major < 22 )); then
  log "Installing Node.js 22."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- Service account -------------------------------------------------------
if ! id -u "$service_user" >/dev/null 2>&1; then
  log "Creating service user $service_user."
  useradd --system --create-home --shell /usr/sbin/nologin "$service_user"
fi
usermod -aG docker "$service_user"
service_uid="$(id -u "$service_user")"
service_gid="$(id -g "$service_user")"

# --- Application -----------------------------------------------------------
log "Installing the application into $install_dir."
mkdir -p "$install_dir"
if [[ "$repo_dir" != "$install_dir" ]]; then
  tar -C "$repo_dir" --exclude=.git --exclude=node_modules --exclude=.local -cf - . \
    | tar -C "$install_dir" -xf -
fi
cp "$env_file" "$install_dir/.env"
chmod 600 "$install_dir/.env"

mkdir -p "$install_dir/state/data" "$install_dir/state/workspaces" "$install_dir/state/codex-home"
chown -R "$service_user:$service_user" "$install_dir"

log "Building the Runtime image."
docker build --file "$install_dir/Dockerfile.runtime" --tag "$runtime_image" "$install_dir"

log "Building the Web UI and control plane."
su -s /bin/bash -c "cd '$install_dir' && npm ci && npm run build" "$service_user"

# --- systemd ---------------------------------------------------------------
# Runtime paths and the container UID are set here so they always match the
# service account, whatever the operator left in the environment file.
log "Writing the systemd unit."
cat > /etc/systemd/system/airlock.service <<UNIT
[Unit]
Description=Airlock Agent Launchpad control plane
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$service_user
WorkingDirectory=$install_dir
EnvironmentFile=$install_dir/.env
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=RUNTIME_PROVIDER=container
Environment=CONTAINER_ENGINE=docker
Environment=CONTAINER_RUNTIME_IMAGE=$runtime_image
Environment=CONTAINER_USER=$service_uid:$service_gid
Environment=APP_DATA_DIR=$install_dir/state/data
Environment=AGENT_WORKSPACE_ROOT=$install_dir/state/workspaces
Environment=CODEX_HOME=$install_dir/state/codex-home
ExecStart=/usr/bin/node $install_dir/apps/server/dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now airlock.service
sleep 3

# --- Verify ----------------------------------------------------------------
if ! curl -fsS --max-time 10 http://127.0.0.1:3000/api/health >/dev/null; then
  log "The service did not answer /api/health. Recent logs:"
  journalctl -u airlock.service -n 30 --no-pager >&2
  exit 1
fi

runtime="$(curl -fsS --max-time 10 http://127.0.0.1:3000/api/system)"
log "Health check passed."
log "System: $runtime"
case "$runtime" in
  *'"codexAvailable":true'*) log "Runtime image is reachable; guarded Runs can execute." ;;
  *) log "WARNING: codexAvailable is false. Runs will fail until $runtime_image is present." ;;
esac
log "Listening on port 3000. Send the APP_AUTH_TOKEN to anyone who should have access."
