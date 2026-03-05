# Moss Android Edge Node

Run a [Moss](https://moss.social) / Holochain edge node **natively on Android** using Termux — no proot, no Docker, no laptop required.

## What this is

An always-on Holochain peer for your Moss group, running directly on Android hardware. The Holochain binary is compiled from Rust targeting `aarch64-linux-android` (Android NDK), so it runs natively in Termux without any Linux compatibility layer.

## The journey

This didn't start here. It started with a phone and a lot of problem-solving:

1. **Claude Code on Termux** — getting Claude Code running natively on Android required fixing the `/tmp` issue (Android's `/tmp` is root-owned, so we wrap the claude binary with `proot -b $TMPDIR:/tmp`)
2. **npm on Termux** — redirecting global npm installs to `$HOME/.npm-global` since Termux's `/usr` has restrictions
3. **Tooling** — git, ripgrep, pnpm, Node.js v25, dev stack
4. **Ubuntu proot + MCP** — ran an Ubuntu proot environment to host MCP servers (GitHub, Contentful, Cloudinary, Playwright headless)
5. **Holochain on Ubuntu proot** — proved the concept: Holochain + Moss working on Android hardware, inside Ubuntu proot
6. **Native build** — compiled Holochain v0.6.1-rc.1 from source via GitHub Actions (see [holochain-android](https://github.com/daniel-thisnow/holochain-android)), moved everything off proot

The Ubuntu proot proved it worked. The native build was the upgrade.

## Stack

- **Device**: Android 13, any aarch64 phone
- **Runtime**: [Termux](https://termux.dev) + Node.js v25
- **Holochain**: v0.6.1-rc.1, built natively for `aarch64-linux-android`
- **Transport**: iroh (works natively — no netlink issues in 0.6.1-rc.1)
- **Moss**: group hApp v0.15.0-rc.7

## Files

| File | Purpose |
|------|---------|
| `launcher.sh` | Starts conductor + status server, monitors and auto-restarts |
| `status-server.mjs` | Web dashboard on `:8889` with tabbed admin panel |
| `etc/conductor-config.yaml` | Conductor config (update paths for your device) |

## Setup

### Prerequisites

```bash
pkg install nodejs git curl
npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g @holochain/client
```

### Install

```bash
# Download binaries from holochain-android releases
mkdir -p ~/holochain-native/bin
# (download holochain + lair-keystore from GitHub Actions artifacts)

chmod +x ~/holochain-native/bin/holochain
chmod +x ~/holochain-native/bin/lair-keystore

# Clone this repo
git clone https://github.com/daniel-thisnow/moss-android-edge-node ~/holochain-native-setup
cp ~/holochain-native-setup/{launcher.sh,status-server.mjs} ~/holochain-native/
cp ~/holochain-native-setup/etc/conductor-config.yaml ~/holochain-native/etc/

# Update paths in conductor config
sed -i "s|/data/data/com.termux/files/home|$HOME|g" ~/holochain-native/etc/conductor-config.yaml

# Start
~/holochain-native/launcher.sh
```

### Join a Moss group

```bash
node ~/holochain-native/install-group.mjs "<your-moss-invite-link>"
```

### Set your node profile

```bash
node ~/holochain-native/set-profile.mjs "YourName" "Node description"
```

## Dashboard

Once running:

- `http://localhost:8889` — basic status
- `http://localhost:8889/admin` — full tabbed panel (Dashboard, Apps, Peers, Chain, Storage, Logs)

## Ports

| Port | Purpose |
|------|---------|
| 4445 | Holochain admin websocket |
| 4446 | Holochain app websocket |
| 8889 | Status dashboard |

## Notes

- The binary uses `/system/bin/linker64` (Android's native linker) — no `termux-elf-cleaner` needed
- iroh transport works natively in v0.6.1-rc.1 (earlier versions crashed with netlink permission errors on Android)
- `wsClientOptions: { origin: 'http://localhost' }` is required for admin websocket connections
- Conductor data lives in `~/holochain-native/data/` — back this up, it contains your keystore
