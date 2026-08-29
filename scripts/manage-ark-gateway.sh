#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
engine="${CONTAINER_ENGINE:-docker}"
gateway_image="${ARK_GATEWAY_IMAGE:-airlock-ark-gateway:local}"
runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
network_name="${ARK_GATEWAY_NETWORK:-}"
container_name="${ARK_GATEWAY_CONTAINER:-}"
restart_policy="${ARK_GATEWAY_RESTART_POLICY:-no}"
gateway_secret="${ARK_GATEWAY_SECRET:-}"

log() { printf '[ark-gateway] %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

[[ "$network_name" =~ ^[a-zA-Z0-9_.-]+$ ]] || fail "ARK_GATEWAY_NETWORK is missing or invalid."
[[ "$container_name" =~ ^[a-zA-Z0-9_.-]+$ ]] || fail "ARK_GATEWAY_CONTAINER is missing or invalid."

stop_gateway() {
  "$engine" rm --force "$container_name" >/dev/null 2>&1 || true
  "$engine" network rm "$network_name" >/dev/null 2>&1 || true
}

case "$action" in
  stop)
    stop_gateway
    exit 0
    ;;
  start)
    ;;
  *)
    fail "Usage: manage-ark-gateway.sh start|stop"
    ;;
esac

[[ -n "${ARK_API_KEY:-}" && "${ARK_API_KEY}" != replace-* ]] || fail "ARK_API_KEY is required by the gateway."
[[ ${#gateway_secret} -ge 32 ]] || fail "ARK_GATEWAY_SECRET must contain at least 32 characters."
[[ -n "${ARK_BASE_URL:-}" ]] || fail "ARK_BASE_URL is required by the gateway."

stop_gateway
log "Creating internal Runtime network $network_name."
"$engine" network create \
  --internal \
  --label io.codejam.airlock=ark-gateway-network \
  "$network_name" >/dev/null

internal_flag="$($engine network inspect --format '{{.Internal}}' "$network_name")"
[[ "$internal_flag" == "true" ]] || {
  stop_gateway
  fail "$network_name is not an internal network; refusing to start."
}

restart_args=()
if [[ "$restart_policy" != "no" ]]; then
  restart_args=(--restart "$restart_policy")
fi

log "Starting the Responses-only gateway."
"$engine" run --detach \
  --name "$container_name" \
  --network bridge \
  "${restart_args[@]}" \
  --label io.codejam.airlock=ark-gateway \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --cpus 0.5 \
  --memory 256m \
  --pids-limit 64 \
  --env ARK_API_KEY \
  --env ARK_BASE_URL \
  --env ARK_GATEWAY_SECRET \
  "$gateway_image" >/dev/null

"$engine" network connect --alias ark-gateway "$network_name" "$container_name"

if "$engine" run --rm \
  --network "$network_name" \
  --entrypoint node \
  "$runtime_image" \
  -e "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
  >/dev/null 2>&1; then
  log "Internal Runtime network unexpectedly reached the public internet."
  stop_gateway
  exit 1
fi
log "Negative egress check passed: a Runtime peer cannot reach a public destination directly."

healthy=false
for _attempt in $(seq 1 20); do
  if "$engine" run --rm \
    --network "$network_name" \
    --entrypoint node \
    "$runtime_image" \
    -e "fetch('http://ark-gateway:8080/health').then(r=>{if(!r.ok)process.exit(1)})" \
    >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != "true" ]]; then
  log "Gateway health check failed. Recent gateway output:"
  "$engine" logs --tail 30 "$container_name" >&2 || true
  stop_gateway
  exit 1
fi

log "Gateway is healthy; Runtime containers can reach it only through $network_name."
