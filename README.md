# Moss Android Edge Node

Run a [Moss](https://moss.social) / Holochain edge node **natively on Android** using Termux — no proot, no Docker, no laptop required.

## Quick install

```bash
pkg install nodejs git curl netcat-openbsd
bash <(curl -fsSL https://raw.githubusercontent.com/daniel-thisnow/moss-android-edge-node/main/install.sh) \
  --name "Your Name" --desc "My edge node"
```

Then start:

```bash
~/holochain-native/launcher.sh
```

## What this is

An always-on Holochain peer for your Moss group, running directly on Android hardware. The Holochain binary is compiled from Rust targeting `aarch64-linux-android` (Android NDK), so it runs natively in Termux without any Linux compatibility layer.

## The journey

This didn't start here. It started with a phone and a lot of problem-solving:

1. **Claude Code on Termux** — getting Claude Code running natively on Android required fixing the `/tmp` issue (Android's `/tmp` is root-owned, so we wrap the claude binary with `proot -b $TMPDIR:/tmp`)
2. **npm on Termux** — `npm install` was hanging non-deterministically inside proot-distro. Root cause: proot's ptrace event handler couldn't cope with Node.js's libuv thread pool firing 4 `clone()` syscalls at once. The `PTRACE_EVENT_CLONE` and `SIGSTOP` events arrive out of order, leaving threads permanently stuck. Fix: batch all pending `waitpid()` events and sort CLONE before SIGSTOP before processing. [PR #337 → termux/proot](https://github.com/termux/proot/pull/337)
3. **Tooling** — git, ripgrep, pnpm, Node.js v25, dev stack
4. **Ubuntu proot + MCP** — ran an Ubuntu proot environment to host MCP servers (GitHub, Contentful, Cloudinary, Playwright headless)
5. **Holochain on Ubuntu proot** — proved the concept: Holochain + Moss working on Android hardware, inside Ubuntu proot
6. **Native build** — compiled Holochain v0.6.1-rc.1 from source via GitHub Actions (see [holochain-android](https://github.com/daniel-thisnow/holochain-android)), moved everything off proot

The Ubuntu proot proved it worked. The native build was the upgrade.

## Binaries

Pre-built for `aarch64-linux-android` (Android NDK r25b, API 28):

| Binary | Download |
|--------|----------|
| `holochain` v0.6.1-rc.1 | [download](https://github.com/daniel-thisnow/holochain-android/releases/download/holochain-0.6.1-rc.1/holochain) |
| `lair-keystore` | [download](https://github.com/daniel-thisnow/holochain-android/releases/download/holochain-0.6.1-rc.1/lair-keystore) |

Release page: [holochain-android/releases/tag/holochain-0.6.1-rc.1](https://github.com/daniel-thisnow/holochain-android/releases/tag/holochain-0.6.1-rc.1)

Built via GitHub Actions — source and workflow at [holochain-android](https://github.com/daniel-thisnow/holochain-android).

## Stack

- **Device**: Android 13, any aarch64 phone
- **Runtime**: [Termux](https://termux.dev) + Node.js v25
- **Holochain**: v0.6.1-rc.1, built natively for `aarch64-linux-android`
- **Transport**: iroh (works natively — no netlink issues in 0.6.1-rc.1)
- **Moss**: group hApp v0.15.0-rc.7

## Files

| File | Purpose |
|------|---------|
| `install.sh` | One-shot installer — downloads binaries, writes config, sets up boot hook |
| `launcher.sh` | Starts conductor + status server, monitors and auto-restarts |
| `status-server.mjs` | Web dashboard on `:8889` with tabbed admin panel |
| `etc/conductor-config.yaml` | Conductor config template |

## Dashboard

Once running, open in a browser on the same device:

- `http://localhost:8889` — status overview
- `http://localhost:8889/admin` — full tabbed panel (Dashboard, Apps, Peers, Chain, Storage, Logs, Profile)

## Join a Moss group

After the node is running, paste a Moss invite link:

```bash
node ~/holochain-native/install-group.mjs "weave-0.15://invite/..."
```

Profile is set via the **Profile tab** in the admin panel, or:

```bash
node ~/holochain-native/set-profile.mjs "YourName" "Node description"
```

## Auto-start on boot

Install [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) from F-Droid — `install.sh` sets up the hook automatically.

## Ports

| Port | Purpose |
|------|---------|
| 4445 | Holochain admin websocket |
| 4446 | Holochain app websocket |
| 8889 | Status dashboard |

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Launcher, supervisor, Node.js scripts | ✅ Done |
| 1 | Native Termux binary (no proot) | ✅ Done |
| 2 | Cross-compile for `aarch64-linux-android` via GitHub Actions | ✅ Done |
| 3 | Android APK — Kotlin foreground service wrapping the conductor, WiFi lock, wake lock, persistent notification | 🔜 Next |
| 4 | Moss Android client — WebView hApp UI runtime, group manager, invite link handling | 📋 Planned |
| 5 | Port Moss for Android — full native Android Moss app, feature parity with [lightningrodlabs/moss](https://github.com/lightningrodlabs/moss) desktop | 📋 Planned |

## Notes

- The binary uses `/system/bin/linker64` (Android's native linker) — no `termux-elf-cleaner` needed
- iroh transport works natively in v0.6.1-rc.1 (earlier versions crashed with netlink permission errors on Android)
- `wsClientOptions: { origin: 'http://localhost' }` is required for admin websocket connections
- Conductor data lives in `~/holochain-native/data/` — back this up, it contains your keystore
- Wake lock is acquired on startup to prevent network sleep on screen-off (requires [Termux:API](https://f-droid.org/packages/com.termux.api/))
