#!/data/data/com.termux/files/usr/bin/bash
# Holochain native Android launcher

NATIVE_DIR="$HOME/holochain-native"
HOLOCHAIN="$NATIVE_DIR/bin/holochain"
CONFIG="$NATIVE_DIR/etc/conductor-config.yaml"
LOG="$NATIVE_DIR/logs/holochain.log"
ADMIN_PORT=4445
STATUS_PORT=8889
MAX_RESTARTS=20
STATUS_PID=""
HC_PID=""

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [launcher] $1"; }

cleanup() {
  log "Shutting down..."
  [ -n "$STATUS_PID" ] && kill "$STATUS_PID" 2>/dev/null
  [ -n "$HC_PID" ] && kill "$HC_PID" 2>/dev/null
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
  exit 0
}
trap cleanup SIGINT SIGTERM

mkdir -p "$NATIVE_DIR/logs"

# Acquire wake lock to prevent network sleep on screen-off (requires Termux:API)
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  log "Wake lock acquired (network will stay alive on screen-off)"
else
  log "WARN: termux-wake-lock not found — install Termux:API to prevent network sleep"
fi

start_status_server() {
  HOLOCHAIN_ADMIN_PORT=$ADMIN_PORT HOLOCHAIN_STATUS_PORT=$STATUS_PORT \
    node "$NATIVE_DIR/status-server.mjs" >> "$NATIVE_DIR/logs/status.log" 2>&1 &
  STATUS_PID=$!
  log "Status server started (PID $STATUS_PID) on :$STATUS_PORT"
}

log "=========================================="
log "Holochain Native Android Launcher"
log "  Binary:  $HOLOCHAIN"
log "  Config:  $CONFIG"
log "  Admin:   :$ADMIN_PORT"
log "  Status:  :$STATUS_PORT"
log "=========================================="

# Verify binary exists and is executable
if [ ! -x "$HOLOCHAIN" ]; then
  log "ERROR: $HOLOCHAIN not found or not executable"
  exit 1
fi

RESTART=0
while [ $RESTART -lt $MAX_RESTARTS ]; do
  log "Starting conductor..."
  "$HOLOCHAIN" --config-path "$CONFIG" >> "$LOG" 2>&1 &
  HC_PID=$!
  log "Conductor PID: $HC_PID"

  # Wait for conductor to be ready
  log "Waiting for conductor ready (max 120s)..."
  READY=0
  for i in $(seq 1 120); do
    if ! kill -0 "$HC_PID" 2>/dev/null; then
      log "Conductor process died during startup."
      log "Log tail:"
      tail -20 "$LOG" | while IFS= read -r line; do log "  $line"; done
      break
    fi
    if nc -z localhost $ADMIN_PORT 2>/dev/null; then
      log "Conductor ready (${i}s)."
      READY=1
      break
    fi
    sleep 1
  done

  if [ $READY -eq 0 ]; then
    RESTART=$((RESTART + 1))
    WAIT=$((10 + RESTART * 5))
    [ $WAIT -gt 60 ] && WAIT=60
    log "Restart #$RESTART/$MAX_RESTARTS, waiting ${WAIT}s..."
    sleep $WAIT
    continue
  fi

  # Start status server
  start_status_server

  log "Node is up. Monitoring..."

  # Monitor conductor
  while kill -0 "$HC_PID" 2>/dev/null; do
    # Restart status server if it died
    if [ -n "$STATUS_PID" ] && ! kill -0 "$STATUS_PID" 2>/dev/null; then
      log "Status server died, restarting..."
      start_status_server
    fi
    sleep 10
  done

  log "Conductor exited."
  [ -n "$STATUS_PID" ] && kill "$STATUS_PID" 2>/dev/null
  STATUS_PID=""

  RESTART=$((RESTART + 1))
  if [ $RESTART -lt $MAX_RESTARTS ]; then
    WAIT=$((10 + RESTART * 5))
    [ $WAIT -gt 60 ] && WAIT=60
    log "Restart #$RESTART/$MAX_RESTARTS, waiting ${WAIT}s..."
    sleep $WAIT
  fi
done

log "Max restarts ($MAX_RESTARTS) reached. Giving up."
exit 1
