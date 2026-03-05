#!/data/data/com.termux/files/usr/bin/bash
# Moss Android Edge Node — installer
# Usage: bash install.sh [--name "Your Name"] [--desc "Node description"]
set -e

REPO="https://github.com/daniel-thisnow/moss-android-edge-node"
BIN_REPO="https://github.com/daniel-thisnow/holochain-android"
INSTALL_DIR="$HOME/holochain-native"
NODE_NAME="Android Edge Node"
NODE_DESC="Always-on Holochain peer on Android"

log()  { echo "[install] $1"; }
ok()   { echo "[install] OK  $1"; }
err()  { echo "[install] ERR $1"; exit 1; }
ask()  { printf "[install] %s: " "$1"; read -r REPLY; echo "$REPLY"; }

# ── Parse args ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NODE_NAME="$2"; shift 2 ;;
    --desc) NODE_DESC="$2"; shift 2 ;;
    --dir)  INSTALL_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │   Moss Android Edge Node — Installer    │"
echo "  └─────────────────────────────────────────┘"
echo ""
echo "  Install dir : $INSTALL_DIR"
echo "  Node name   : $NODE_NAME"
echo "  Description : $NODE_DESC"
echo ""

# ── Prerequisites ────────────────────────────────────────────
log "Checking prerequisites..."

for cmd in node git curl nc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd not found. Run: pkg install nodejs git curl netcat-openbsd"
  fi
done
ok "node $(node --version), git $(git --version | cut -d' ' -f3)"

# npm global prefix
if ! echo "$PATH" | grep -q ".npm-global"; then
  log "Setting npm global prefix..."
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc" 2>/dev/null || true
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.zshrc" 2>/dev/null || true
fi

# @holochain/client
if ! node -e "require('@holochain/client')" 2>/dev/null; then
  log "Installing @holochain/client..."
  npm install -g @holochain/client
fi
ok "@holochain/client"

# ── Directory structure ──────────────────────────────────────
log "Creating directories..."
mkdir -p "$INSTALL_DIR/bin"
mkdir -p "$INSTALL_DIR/etc"
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/logs"
ok "Directories created"

# ── Binaries ─────────────────────────────────────────────────
log "Checking for holochain binary..."

if [ ! -f "$INSTALL_DIR/bin/holochain" ]; then
  # Try GitHub Releases
  RELEASE_URL=$(curl -sf "https://api.github.com/repos/daniel-thisnow/holochain-android/releases/latest" \
    | grep '"browser_download_url"' | grep 'holochain' | grep -v 'lair' \
    | cut -d'"' -f4 | head -1)

  if [ -n "$RELEASE_URL" ]; then
    log "Downloading holochain from release..."
    curl -fL "$RELEASE_URL" -o "$INSTALL_DIR/bin/holochain"
    chmod +x "$INSTALL_DIR/bin/holochain"
    ok "holochain downloaded"
  else
    echo ""
    echo "  ┌──────────────────────────────────────────────────────────────┐"
    echo "  │  holochain binary not found and no GitHub Release exists.    │"
    echo "  │                                                              │"
    echo "  │  Get the binary from GitHub Actions artifacts:               │"
    echo "  │    $BIN_REPO/actions"
    echo "  │                                                              │"
    echo "  │  Then copy it:                                               │"
    echo "  │    cp /path/to/holochain $INSTALL_DIR/bin/holochain          │"
    echo "  │    cp /path/to/lair-keystore $INSTALL_DIR/bin/lair-keystore  │"
    echo "  │    chmod +x $INSTALL_DIR/bin/*                               │"
    echo "  │                                                              │"
    echo "  │  Then re-run this script.                                    │"
    echo "  └──────────────────────────────────────────────────────────────┘"
    echo ""
    exit 1
  fi
else
  ok "holochain binary present"
fi

if [ ! -f "$INSTALL_DIR/bin/lair-keystore" ]; then
  LAIR_URL=$(curl -sf "https://api.github.com/repos/daniel-thisnow/holochain-android/releases/latest" \
    | grep '"browser_download_url"' | grep 'lair' \
    | cut -d'"' -f4 | head -1)
  if [ -n "$LAIR_URL" ]; then
    log "Downloading lair-keystore from release..."
    curl -fL "$LAIR_URL" -o "$INSTALL_DIR/bin/lair-keystore"
    chmod +x "$INSTALL_DIR/bin/lair-keystore"
    ok "lair-keystore downloaded"
  else
    log "WARN: lair-keystore not found — conductor uses in-process keystore, this may be OK"
  fi
else
  ok "lair-keystore binary present"
fi

# ── Conductor config ─────────────────────────────────────────
CONFIG="$INSTALL_DIR/etc/conductor-config.yaml"
if [ ! -f "$CONFIG" ]; then
  log "Writing conductor config..."
  cat > "$CONFIG" <<YAML
---
admin_interfaces:
  - driver:
      type: websocket
      port: 4445
      allowed_origins: '*'
network:
  bootstrap_url: "https://bootstrap.moss.social"
  signal_url: "wss://bootstrap.moss.social"
  relay_url: "https://use1-1.relay.n0.iroh-canary.iroh.link./"
  enable_mdns: false
  enable_relaying: true
data_root_path: "${INSTALL_DIR}/data"
keystore:
  type: lair_server_in_proc
  lair_root: "${INSTALL_DIR}/data/ks"
advanced:
  tx5Transport:
    dangerForceSignalRelay: true
YAML
  ok "conductor-config.yaml written"
else
  ok "conductor-config.yaml already exists"
fi

# ── Scripts from repo ────────────────────────────────────────
log "Fetching scripts from repo..."

for f in launcher.sh status-server.mjs; do
  if [ ! -f "$INSTALL_DIR/$f" ]; then
    curl -fsSL "$REPO/raw/main/$f" -o "$INSTALL_DIR/$f"
    ok "Downloaded $f"
  else
    log "Skipping $f (already exists)"
  fi
done

chmod +x "$INSTALL_DIR/launcher.sh"

# ── Node profile in settings ─────────────────────────────────
SETTINGS="$INSTALL_DIR/etc/settings.json"
if [ ! -f "$SETTINGS" ]; then
  log "Writing node settings..."
  cat > "$SETTINGS" <<JSON
{
  "icon": "🌿",
  "nickname": "$NODE_NAME",
  "description": "$NODE_DESC"
}
JSON
  ok "settings.json written"
fi

# ── Termux:Boot hook ─────────────────────────────────────────
BOOT_DIR="$HOME/.termux/boot"
BOOT_SCRIPT="$BOOT_DIR/start-holochain.sh"
mkdir -p "$BOOT_DIR"

cat > "$BOOT_SCRIPT" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/bash
# Auto-start Holochain node on device boot (requires Termux:Boot app)
sleep 10
termux-wake-lock 2>/dev/null || true
exec "$HOME/holochain-native/launcher.sh" >> "$HOME/holochain-native/logs/boot.log" 2>&1
BOOT

chmod +x "$BOOT_SCRIPT"
ok "Termux:Boot hook written to $BOOT_SCRIPT"

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │                  Install complete!                  │"
echo "  │                                                     │"
echo "  │  Start:     ~/holochain-native/launcher.sh          │"
echo "  │  Dashboard: http://localhost:8889                   │"
echo "  │  Admin:     http://localhost:8889/admin             │"
echo "  │                                                     │"
echo "  │  To join a Moss group:                              │"
echo "  │    node ~/holochain-native/install-group.mjs <url>  │"
echo "  │                                                     │"
echo "  │  Auto-start on boot: install Termux:Boot app        │"
echo "  │    https://f-droid.org/packages/com.termux.boot/    │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
