import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { AdminWebsocket, AppWebsocket, encodeHashToBase64 } from '@holochain/client';

process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err?.message || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH] unhandledRejection:', reason);
  process.exit(1);
});

const PORT = parseInt(process.env.HOLOCHAIN_STATUS_PORT || '8889');
const ADMIN_PORT = parseInt(process.env.HOLOCHAIN_ADMIN_PORT || '4445');
const APP_PORT = parseInt(process.env.HOLOCHAIN_APP_PORT || '4446');
const WS_OPTS = { origin: 'http://localhost' };
const LOG = (process.env.HOME || '/data/data/com.termux/files/home') + '/holochain-native/logs/holochain.log';
const LAUNCHER_LOG = (process.env.HOME || '/data/data/com.termux/files/home') + '/holochain-native/logs/launcher.log';

const NODE_NAME = 'Android Edge Node';
const NODE_DESC = 'Holochain DHT peer running on Android 13 via Termux native (no proot, no Docker).';
const BOOTSTRAP = 'bootstrap.moss.social';
const HC_VERSION = '0.6.1-rc.1 (iroh)';

const b64 = (h) => {
  if (!h) return '?';
  if (typeof h === 'string') return h;
  try { return encodeHashToBase64(h); }
  catch { try { return encodeHashToBase64(new Uint8Array(h)); } catch { return '?'; } }
};

const short = (h) => { const s = b64(h); return s.length > 24 ? s.slice(0, 20) + '...' : s; };

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function timeSince(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function decodeMsgpack(data) {
  const bytes = data?.type === 'Buffer' ? new Uint8Array(data.data) : (data instanceof Uint8Array ? data : null);
  if (!bytes) return data;
  let pos = 0;
  function read() {
    const b = bytes[pos++];
    if (b >= 0x00 && b <= 0x7f) return b;
    if (b >= 0xa0 && b <= 0xbf) { const len = b - 0xa0; return readStr(len); }
    if (b >= 0x80 && b <= 0x8f) { const m = {}; for (let i = 0; i < b - 0x80; i++) { const k = read(); m[k] = read(); } return m; }
    if (b >= 0x90 && b <= 0x9f) { const a = []; for (let i = 0; i < b - 0x90; i++) a.push(read()); return a; }
    if (b === 0xc0) return null;
    if (b === 0xc2) return false;
    if (b === 0xc3) return true;
    if (b === 0xcc) return bytes[pos++];
    if (b === 0xcd) { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; }
    if (b === 0xce) { const v = (bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3]; pos += 4; return v >>> 0; }
    if (b === 0xd9) { const len = bytes[pos++]; return readStr(len); }
    if (b === 0xda) { const len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return readStr(len); }
    if (b === 0xde) { const len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; const m = {}; for (let i = 0; i < len; i++) { const k = read(); m[k] = read(); } return m; }
    if (b === 0xdc) { const len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; const a = []; for (let i = 0; i < len; i++) a.push(read()); return a; }
    if (b === 0xc4) { const len = bytes[pos++]; pos += len; return '<bin>'; }
    if (b === 0xc5) { const len = (bytes[pos] << 8) | bytes[pos+1]; pos += 2; pos += len; return '<bin>'; }
    if (b >= 0xe0) return b - 256;
    return null;
  }
  function readStr(len) { const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; }
  return read();
}

// ── Admin websocket helpers ──────────────────────────────────

let _appInterfaceAttached = false;

async function getAdmin() {
  const ws = await AdminWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${ADMIN_PORT}`),
    defaultTimeout: 30000,
    wsClientOptions: WS_OPTS,
  });
  // Attach app interface once — check existing interfaces first to avoid IPv6 bind error
  if (!_appInterfaceAttached) {
    try {
      const ifaces = await ws.listAppInterfaces();
      const alreadyBound = ifaces.some(i => i.port === APP_PORT);
      if (!alreadyBound) {
        await ws.attachAppInterface({ port: APP_PORT, allowed_origins: '*', installed_app_id: null });
      }
      _appInterfaceAttached = true;
    } catch (e) {
      _appInterfaceAttached = true; // assume it's there
    }
  }
  return ws;
}

async function getAppWs(ws, appId) {
  for (const [, cells] of Object.entries((await ws.listApps({})).find(a => a.installed_app_id === appId)?.cell_info || {})) {
    try { await ws.authorizeSigningCredentials(cells[0].value.cell_id); } catch {}
  }
  const { token } = await ws.issueAppAuthenticationToken({
    installed_app_id: appId, expiry_seconds: 120, single_use: false,
  });
  return AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${APP_PORT}`),
    defaultTimeout: 15000,
    wsClientOptions: WS_OPTS,
    token,
  });
}

// ── Live data fetcher (cached) ───────────────────────────────

let cache = { ts: 0, data: null };
const CACHE_TTL = 6000;

async function fetchLiveData() {
  if (Date.now() - cache.ts < CACHE_TTL && cache.data) return cache.data;

  const result = {
    status: 'offline', agentKey: '?', nickname: null, fields: null,
    appId: null, roles: [], apps: [],
    totalRecords: 0, totalOps: 0, totalPeers: 0, totalIntegrated: 0,
    peerDetails: [], roleStats: [], storageBlobs: [],
    uptime: null, restartCount: 0, errors: [],
  };

  let ws, appWs;
  try {
    ws = await getAdmin();
    const apps = await ws.listApps({});
    if (apps.length === 0) {
      result.status = 'no_apps';
      ws.client.close();
      cache = { ts: Date.now(), data: result };
      return result;
    }

    result.status = 'running';

    for (const app of apps) {
      const appEntry = {
        id: app.installed_app_id,
        status: app.status?.type || 'unknown',
        agent: b64(app.agent_pub_key),
        roles: {},
      };
      for (const [role, cells] of Object.entries(app.cell_info)) {
        const cell = cells[0]?.value;
        const cellId = cell?.cell_id;
        appEntry.roles[role] = {
          dna: cellId ? b64(cellId[0]) : '?',
          agent: cellId ? b64(cellId[1]) : '?',
        };
      }
      result.apps.push(appEntry);
    }

    const app = apps[0];
    result.appId = app.installed_app_id;
    result.agentKey = b64(app.agent_pub_key);
    result.roles = Object.keys(app.cell_info);

    for (const [role, cells] of Object.entries(app.cell_info)) {
      const cellId = cells[0]?.value?.cell_id;
      if (!cellId) continue;
      try {
        const state = await ws.dumpState({ cell_id: cellId });
        const dump = state[0];
        const records = dump?.source_chain_dump?.records?.length || 0;
        const ops = dump?.source_chain_dump?.published_ops_count || 0;
        const peers = dump?.peer_dump?.peers || [];
        const integrated = dump?.integration_dump?.integrated || 0;

        result.totalRecords += records;
        result.totalOps += ops;
        result.totalPeers = Math.max(result.totalPeers, peers.length);
        result.totalIntegrated += integrated;

        const peerList = peers.map(p => {
          const lines = p.dump?.split('\n') || [];
          const url = lines.find(l => l.startsWith('url:'))?.replace('url: Some(', '').replace(')', '') || '?';
          const expires = lines.find(l => l.startsWith('expires'))?.replace('expires at ', '') || '?';
          const isOurs = p.kitsune_agent === dump?.peer_dump?.this_agent_info?.kitsune_agent;
          return { agent: p.kitsune_agent?.slice(0, 12), url, expires, isOurs };
        });

        result.roleStats.push({ role, records, ops, peers: peers.length, integrated, peerList });
        if (role === 'group') result.peerDetails = peerList;
      } catch {}
    }

    try {
      const si = await ws.storageInfo();
      result.storageBlobs = (si.blobs || []).filter(b => b.type === 'dna').map(b => ({
        dna: b64(b.value.dna_hash)?.slice(0, 20),
        authored: b.value.authored_data_size,
        dht: b.value.dht_data_size,
        cache: b.value.cache_data_size,
        disk: b.value.authored_data_size_on_disk + b.value.dht_data_size_on_disk + b.value.cache_data_size_on_disk,
      }));
    } catch {}

    try {
      appWs = await getAppWs(ws, app.installed_app_id);
      const profile = await appWs.callZome({ role_name: 'group', zome_name: 'profiles', fn_name: 'get_my_profile', payload: null });
      const raw = profile?.entry?.Present?.entry || profile?.entry?.entry;
      if (raw) {
        const decoded = decodeMsgpack(raw);
        result.nickname = decoded?.nickname;
        result.fields = decoded?.fields;
      }
    } catch (e) {
      result.errors.push('profile: ' + (e.message?.slice(0, 80) || '?'));
    }

  } catch (e) {
    result.status = 'offline';
    result.errors.push(e.message?.slice(0, 100) || 'connection failed');
  } finally {
    try { appWs?.client?.close(); } catch {}
    try { ws?.client?.close(); } catch {}
  }

  if (existsSync(LAUNCHER_LOG)) {
    try {
      const log = readFileSync(LAUNCHER_LOG, 'utf8');
      const starts = log.match(/Starting conductor\.\.\./g);
      result.restartCount = starts ? starts.length - 1 : 0;
      const lastStart = log.split('\n').filter(l => l.includes('Conductor ready')).pop();
      if (lastStart) {
        const ts = lastStart.match(/\[(\d{4}-\d{2}-\d{2}T[\d:Z]+)\]/)?.[1];
        if (ts) result.uptime = ts;
      }
    } catch {}
  }

  cache = { ts: Date.now(), data: result };
  return result;
}

// ── Admin action endpoints ───────────────────────────────────

async function apiEnableApp(appId) {
  const ws = await getAdmin();
  try {
    const apps = await ws.listApps({});
    const match = apps.find(a => a.installed_app_id === appId) || apps.find(a => a.installed_app_id.startsWith(appId));
    if (!match) return { ok: false, error: 'App not found' };
    await ws.enableApp({ installed_app_id: match.installed_app_id });
    cache.ts = 0;
    return { ok: true, appId: match.installed_app_id };
  } finally { ws.client.close(); }
}

async function apiDisableApp(appId) {
  const ws = await getAdmin();
  try {
    const apps = await ws.listApps({});
    const match = apps.find(a => a.installed_app_id === appId) || apps.find(a => a.installed_app_id.startsWith(appId));
    if (!match) return { ok: false, error: 'App not found' };
    await ws.disableApp({ installed_app_id: match.installed_app_id });
    cache.ts = 0;
    return { ok: true, appId: match.installed_app_id };
  } finally { ws.client.close(); }
}

async function apiUninstallApp(appId) {
  const ws = await getAdmin();
  try {
    const apps = await ws.listApps({});
    const match = apps.find(a => a.installed_app_id === appId) || apps.find(a => a.installed_app_id.startsWith(appId));
    if (!match) return { ok: false, error: 'App not found' };
    await ws.uninstallApp({ installed_app_id: match.installed_app_id });
    cache.ts = 0;
    return { ok: true, appId: match.installed_app_id };
  } finally { ws.client.close(); }
}

async function apiInstallApp(url, appId, networkSeed) {
  const ws = await getAdmin();
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, error: `Download failed: ${resp.status}` };
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (!appId) {
      const base = url.split('/').pop().replace(/\.happ$/, '');
      appId = `${base}-${Date.now().toString(36)}`;
    }

    const agentKey = await ws.generateAgentPubKey();
    const installOpts = {
      installed_app_id: appId,
      agent_key: agentKey,
      bundle: { source: { type: 'bytes', value: [...bytes] } },
    };
    if (networkSeed) installOpts.network_seed = networkSeed;

    const result = await ws.installApp(installOpts);
    await ws.enableApp({ installed_app_id: appId });
    cache.ts = 0;
    return { ok: true, appId, roles: Object.keys(result.cell_info), agent: b64(agentKey) };
  } finally { ws.client.close(); }
}

async function apiGetChain(role) {
  const ws = await getAdmin();
  try {
    const apps = await ws.listApps({});
    if (apps.length === 0) return { ok: false, error: 'No apps' };
    const app = apps[0];
    const cells = app.cell_info[role];
    if (!cells) return { ok: false, error: `Role "${role}" not found` };
    const cellId = cells[0]?.value?.cell_id;
    const state = await ws.dumpState({ cell_id: cellId });
    const records = (state[0]?.source_chain_dump?.records || []).map(rec => {
      const a = rec.action;
      let detail = '';
      if (a.type === 'Create' && rec.entry?.entry_type === 'App') {
        try {
          const decoded = decodeMsgpack(rec.entry.entry);
          if (decoded?.nickname) detail = `profile: "${decoded.nickname}"`;
          else detail = 'app entry';
        } catch { detail = 'app entry'; }
      } else if (a.type === 'CreateLink') {
        const tag = a.tag ? Buffer.from(a.tag).toString('utf8').replace(/\0/g, '') : '';
        detail = `link: "${tag}"`;
      } else if (a.type === 'Create' && rec.entry?.entry_type === 'CapGrant') {
        detail = `cap: "${rec.entry?.entry?.tag || '?'}"`;
      }
      return { seq: a.action_seq ?? '-', type: a.type, detail };
    });
    return { ok: true, role, count: records.length, records };
  } finally { ws.client.close(); }
}

async function apiGetPeers() {
  const ws = await getAdmin();
  try {
    const apps = await ws.listApps({});
    if (apps.length === 0) return { ok: true, roles: [] };
    const roles = [];
    for (const [role, cells] of Object.entries(apps[0].cell_info)) {
      const cellId = cells[0]?.value?.cell_id;
      if (!cellId) continue;
      try {
        const state = await ws.dumpState({ cell_id: cellId });
        const peer = state[0]?.peer_dump;
        const ownInfo = peer?.this_agent_info;
        const ownLines = ownInfo?.dump?.split('\n') || [];
        const ownUrl = ownLines.find(l => l.startsWith('url:'))?.replace('url: Some(', '').replace(')', '') || '?';
        const peers = (peer?.peers || []).map(p => {
          const lines = p.dump?.split('\n') || [];
          const url = lines.find(l => l.startsWith('url:'))?.replace('url: Some(', '').replace(')', '') || '?';
          const expires = lines.find(l => l.startsWith('expires'))?.replace('expires at ', '') || '?';
          return { agent: short(p.kitsune_agent), url, expires };
        });
        roles.push({ role, dna: short(cellId[0]), ownUrl, peers });
      } catch {}
    }
    return { ok: true, roles };
  } finally { ws.client.close(); }
}

async function apiGetNetStats() {
  const ws = await getAdmin();
  try {
    const stats = await ws.dumpNetworkStats({});
    return { ok: true, stats: typeof stats === 'string' ? stats : JSON.stringify(stats) };
  } finally { ws.client.close(); }
}

async function apiGetStorage() {
  const ws = await getAdmin();
  try {
    const si = await ws.storageInfo();
    const blobs = (si.blobs || []).filter(b => b.type === 'dna').map(b => ({
      dna: short(b.value.dna_hash),
      authored: b.value.authored_data_size,
      authoredDisk: b.value.authored_data_size_on_disk,
      dht: b.value.dht_data_size,
      dhtDisk: b.value.dht_data_size_on_disk,
      cache: b.value.cache_data_size,
      cacheDisk: b.value.cache_data_size_on_disk,
    }));
    return { ok: true, blobs };
  } finally { ws.client.close(); }
}

// ── Log tail ─────────────────────────────────────────────────

// Strip ANSI escape codes from log lines
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[\d;]*m/g, '');

function getLogTail(n = 50) {
  if (!existsSync(LOG)) return [];
  try {
    return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-n).map(stripAnsi);
  } catch { return []; }
}

function getLauncherLog(n = 30) {
  if (!existsSync(LAUNCHER_LOG)) return [];
  try {
    return readFileSync(LAUNCHER_LOG, 'utf8').split('\n').filter(Boolean).slice(-n).map(stripAnsi);
  } catch { return []; }
}

// ── Share text ───────────────────────────────────────────────

function shareText(d) {
  const s = d.status === 'running' ? 'Running' : d.status === 'offline' ? 'Offline' : d.status;
  return `🌿 Moss Edge Node — ${d.nickname || NODE_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:    ${s}
Version:   holochain ${HC_VERSION}
Platform:  Android 13 + Termux (native)
Bootstrap: ${BOOTSTRAP}

Agent: ${d.agentKey}

Live metrics:
  Peers:        ${d.totalPeers}
  Chain:        ${d.totalRecords} records
  DHT ops:      ${d.totalOps} published, ${d.totalIntegrated} integrated
  Roles:        ${d.roles.join(', ')}

${d.fields?.wdockerNode || NODE_DESC}

Up since: ${d.uptime || 'unknown'} (${timeSince(d.uptime)})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ── Request body parser ──────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ── Pretty Dashboard HTML ────────────────────────────────────

function dashboardHTML(d) {
  const statusTag = d.status === 'running'
    ? '<span class="tag tag-ok">Running</span>'
    : d.status === 'offline'
    ? '<span class="tag tag-err">Offline</span>'
    : '<span class="tag tag-warn">' + d.status + '</span>';

  const uptimeStr = d.uptime ? `Up since ${d.uptime} (${timeSince(d.uptime)})` : '';

  const roleCards = d.roleStats.map(r => `
    <div class="role-card">
      <div class="role-name">${r.role}</div>
      <div class="role-stats">
        <span>${r.records} records</span>
        <span>${r.ops} ops</span>
        <span>${r.peers} peers</span>
        <span>${r.integrated} DHT</span>
      </div>
    </div>`).join('');

  const peerRows = d.peerDetails.map(p => {
    const host = p.url.match(/:\/\/([^:/]+)/)?.[1] || '?';
    const isIroh = p.url.includes('iroh');
    const proto = isIroh ? 'iroh' : p.url.startsWith('wss://') ? 'wss' : '?';
    const cls = p.isOurs ? 'peer-self' : '';
    return `<tr class="${cls}">
      <td>${p.agent}…</td>
      <td>${host}</td>
      <td>${proto}</td>
      <td class="muted">${p.isOurs ? 'you' : ''}</td>
    </tr>`;
  }).join('');

  const storageRows = d.storageBlobs.map(b =>
    `<tr><td>${b.dna}…</td><td>${fmtBytes(b.authored)}</td><td>${fmtBytes(b.dht)}</td><td>${fmtBytes(b.disk)}</td></tr>`
  ).join('');

  const logLines = getLogTail(40);
  const logHtml = logLines.map(l => {
    l = l.replace(/\x1b\[[0-9;]*m/g, '').replace(/</g, '&lt;');
    let cls = 'log-line';
    if (l.includes('WARN') || l.includes('Failed')) cls += ' warn';
    if (l.includes('ERROR') || l.includes('FATAL')) cls += ' error';
    return `<div class="${cls}">${l}</div>`;
  }).join('');

  const shareStr = shareText(d).replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>🌿 ${d.nickname || NODE_NAME}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;padding:16px;max-width:720px;margin:auto}
h1{font-size:1.2rem;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sub{color:#64748b;font-size:.75rem;margin-bottom:16px}
.tag{display:inline-block;padding:2px 10px;border-radius:6px;font-size:.7rem;font-weight:600}
.tag-ok{background:#14532d;color:#4ade80}
.tag-warn{background:#713f12;color:#facc15}
.tag-err{background:#7f1d1d;color:#f87171}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.card{background:#1e293b;border-radius:10px;padding:14px}
.card h2{font-size:.6rem;text-transform:uppercase;color:#64748b;margin-bottom:6px;letter-spacing:1px}
.big{font-size:2rem;font-weight:800;line-height:1}
.card-sub{font-size:.68rem;color:#64748b;margin-top:6px}
.info{background:#1e293b;border-radius:10px;padding:14px;margin-bottom:12px;font-size:.78rem;color:#94a3b8;line-height:1.9}
.info b{color:#e2e8f0}
.mono{font-family:'SF Mono',Menlo,monospace;font-size:.72rem;word-break:break-all}
.role-card{background:#1e293b;border-radius:8px;padding:10px 14px;margin-bottom:6px}
.role-name{font-weight:700;font-size:.82rem;margin-bottom:4px;color:#93c5fd}
.role-stats{display:flex;gap:14px;font-size:.72rem;color:#94a3b8}
.role-stats span::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle}
table{width:100%;border-collapse:collapse;font-size:.72rem}
th{text-align:left;color:#64748b;font-size:.6rem;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid #1e293b}
td{padding:5px 8px;border-bottom:1px solid #1e293b22}
.peer-self{color:#4ade80}
.muted{color:#475569}
.log{background:#020617;border-radius:8px;padding:10px;font-family:'SF Mono',Menlo,monospace;font-size:.6rem;max-height:280px;overflow-y:auto;margin-top:8px}
.log-line{padding:1px 0;white-space:pre-wrap;word-break:break-all;color:#64748b}
.warn{color:#facc15}.error{color:#f87171}
.share-box{background:#020617;border:1px solid #1e293b;border-radius:8px;padding:12px;font-family:monospace;font-size:.68rem;white-space:pre-wrap;color:#94a3b8;margin:8px 0;line-height:1.6}
.btn{display:inline-block;padding:8px 18px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:.78rem;cursor:pointer;margin-top:4px;font-weight:600}
.btn:active{background:#2563eb}
.btn.copied{background:#16a34a}
.admin-link{display:inline-block;padding:6px 14px;background:#334155;color:#94a3b8;border-radius:6px;font-size:.72rem;text-decoration:none;font-weight:600;margin-left:auto}
.admin-link:hover{background:#475569;color:#e2e8f0}
section{margin-bottom:14px}
section > h2{font-size:.72rem;text-transform:uppercase;color:#64748b;letter-spacing:1px;margin-bottom:8px}
footer{font-size:.62rem;color:#334155;text-align:center;margin-top:16px;padding-top:12px;border-top:1px solid #1e293b}
</style>
</head>
<body>
<h1>🌿 ${d.nickname || NODE_NAME} ${statusTag} <a class="admin-link" href="/admin">Admin Panel</a></h1>
<div class="sub">${uptimeStr}${d.restartCount > 0 ? ' · ' + d.restartCount + ' restart(s)' : ''} · refreshes every 10s</div>

<div class="grid">
  <div class="card">
    <h2>Peers</h2>
    <div class="big" style="color:${d.totalPeers > 0 ? '#60a5fa' : '#f87171'}">${d.totalPeers}</div>
    <div class="card-sub">via ${BOOTSTRAP}</div>
  </div>
  <div class="card">
    <h2>Source Chain</h2>
    <div class="big" style="color:#a78bfa">${d.totalRecords}</div>
    <div class="card-sub">records across ${d.roles.length} roles</div>
  </div>
  <div class="card">
    <h2>DHT Ops</h2>
    <div class="big" style="color:#4ade80">${d.totalOps}</div>
    <div class="card-sub">${d.totalIntegrated} integrated</div>
  </div>
  <div class="card">
    <h2>Storage</h2>
    <div class="big" style="color:#fbbf24">${d.storageBlobs.length > 0 ? fmtBytes(d.storageBlobs.reduce((s, b) => s + b.disk, 0)) : '?'}</div>
    <div class="card-sub">on disk total</div>
  </div>
</div>

<div class="info">
  <b>Agent</b> <span class="mono">${d.agentKey}</span><br>
  <b>Profile</b> ${d.nickname || 'not set'}${d.fields?.wdockerNode ? ' · ' + d.fields.wdockerNode : ''}<br>
  <b>Version</b> holochain ${HC_VERSION}<br>
  <b>Platform</b> Android 13 · Termux · native<br>
  <b>Bootstrap</b> ${BOOTSTRAP}
</div>

<section>
  <h2>Cells</h2>
  ${roleCards}
</section>

${d.peerDetails.length > 0 ? `
<section>
  <h2>Peers (${d.peerDetails.length})</h2>
  <div class="card" style="padding:0;overflow:hidden">
    <table>
      <tr><th>Agent</th><th>Relay</th><th>Proto</th><th></th></tr>
      ${peerRows}
    </table>
  </div>
</section>` : ''}

${d.storageBlobs.length > 0 ? `
<section>
  <h2>Storage</h2>
  <div class="card" style="padding:0;overflow:hidden">
    <table>
      <tr><th>DNA</th><th>Authored</th><th>DHT</th><th>Disk</th></tr>
      ${storageRows}
    </table>
  </div>
</section>` : ''}

<section>
  <h2>Share</h2>
  <div class="card">
    <div class="share-box" id="share">${shareStr}</div>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('share').innerText).then(()=>{this.textContent='Copied!';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy to clipboard';this.classList.remove('copied')},2000)})">Copy to clipboard</button>
  </div>
</section>

<section>
  <h2>Conductor Log (last ${logLines.length})</h2>
  <div class="card" style="padding:8px">
    <div class="log">${logHtml || '<div class="muted">No log data</div>'}</div>
  </div>
</section>

${d.errors.length > 0 ? `<section><h2>Errors</h2><div class="card"><pre style="font-size:.68rem;color:#f87171">${d.errors.join('\n')}</pre></div></section>` : ''}

<footer>🌿 Moss Edge Node · ${new Date().toISOString()} · admin :${ADMIN_PORT} · app :${APP_PORT} · <a href="/admin" style="color:#64748b">Admin Panel</a></footer>
</body>
</html>`;
}

// ── Admin Panel HTML (SPA) ───────────────────────────────────

function adminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🌿 Holochain Admin</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--border:#334155;--text:#e2e8f0;--muted:#64748b;--dim:#475569;--accent:#3b82f6;--green:#4ade80;--red:#f87171;--yellow:#facc15;--purple:#a78bfa;--mono:'SF Mono',Menlo,'Courier New',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
.shell{max-width:860px;margin:0 auto;padding:12px}
header{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}
header h1{font-size:1.1rem;white-space:nowrap}
header .badge{font-size:.65rem;padding:3px 10px;border-radius:20px;font-weight:700}
.badge-ok{background:#14532d;color:var(--green)}
.badge-off{background:#7f1d1d;color:var(--red)}
header .meta{font-size:.7rem;color:var(--muted);margin-left:auto}
nav{display:flex;gap:2px;margin-bottom:16px;background:var(--surface);border-radius:10px;padding:4px;flex-wrap:wrap}
nav button{flex:1;min-width:70px;padding:8px 4px;border:none;background:transparent;color:var(--muted);font-size:.72rem;font-weight:600;border-radius:8px;cursor:pointer;transition:all .15s}
nav button:hover{color:var(--text)}
nav button.active{background:var(--accent);color:#fff}
.tab{display:none}
.tab.active{display:block}
.card{background:var(--surface);border-radius:10px;padding:16px;margin-bottom:12px}
.card h3{font-size:.68rem;text-transform:uppercase;color:var(--muted);letter-spacing:1px;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--surface);border-radius:10px;padding:14px;text-align:center}
.stat .n{font-size:1.8rem;font-weight:800;line-height:1}
.stat .label{font-size:.6rem;text-transform:uppercase;color:var(--muted);margin-top:6px;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;font-size:.72rem}
th{text-align:left;color:var(--muted);font-size:.6rem;text-transform:uppercase;letter-spacing:.5px;padding:8px;border-bottom:1px solid var(--border)}
td{padding:7px 8px;border-bottom:1px solid #1e293b44}
tr:hover td{background:#ffffff06}
.mono{font-family:var(--mono);font-size:.68rem;word-break:break-all}
.btn{display:inline-block;padding:6px 14px;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;transition:all .15s}
.btn-sm{padding:4px 10px;font-size:.65rem}
.btn-blue{background:var(--accent);color:#fff}
.btn-blue:hover{background:#2563eb}
.btn-green{background:#16a34a;color:#fff}
.btn-green:hover{background:#15803d}
.btn-red{background:#dc2626;color:#fff}
.btn-red:hover{background:#b91c1c}
.btn-yellow{background:#ca8a04;color:#fff}
.btn-yellow:hover{background:#a16207}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-ghost:hover{color:var(--text);border-color:var(--dim)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input[type=text],input[type=url]{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:.78rem;width:100%;font-family:inherit}
input:focus{outline:none;border-color:var(--accent)}
.form-row{display:flex;gap:8px;margin-bottom:8px;align-items:end}
.form-row > *{flex:1}
.form-row label{display:block;font-size:.62rem;text-transform:uppercase;color:var(--muted);letter-spacing:.5px;margin-bottom:4px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--surface2);color:var(--text);padding:10px 18px;border-radius:8px;font-size:.78rem;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none;border:1px solid var(--border)}
.toast.show{opacity:1}
.toast.err{border-color:var(--red);color:var(--red)}
.log-box{background:#020617;border-radius:8px;padding:10px;font-family:var(--mono);font-size:.6rem;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5}
.log-box .w{color:var(--yellow)}
.log-box .e{color:var(--red)}
.log-box .i{color:var(--muted)}
.chain-row{padding:4px 0;border-bottom:1px solid #1e293b33;font-size:.72rem}
.chain-seq{display:inline-block;width:32px;color:var(--muted);text-align:right;margin-right:8px;font-family:var(--mono)}
.chain-type{font-weight:600;margin-right:6px}
.chain-detail{color:var(--muted)}
.peer-url{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:.62rem}
.self{color:var(--green)}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.6rem;font-weight:600}
.tag-run{background:#14532d;color:var(--green)}
.tag-dis{background:#7f1d1d;color:var(--red)}
.tag-pau{background:#713f12;color:var(--yellow)}
.empty{color:var(--muted);font-size:.78rem;padding:20px;text-align:center}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.confirm-overlay{position:fixed;inset:0;background:#00000088;display:flex;align-items:center;justify-content:center;z-index:100}
.confirm-box{background:var(--surface);border-radius:12px;padding:24px;max-width:380px;text-align:center}
.confirm-box p{margin-bottom:16px;font-size:.85rem}
.confirm-box .row{justify-content:center}
@media(max-width:500px){.stats{grid-template-columns:repeat(2,1fr)}.form-row{flex-direction:column}header .meta{margin-left:0;width:100%}}
</style>
</head>
<body>
<div class="shell">
<header>
  <a href="/" style="color:var(--muted);text-decoration:none;font-size:.75rem;font-weight:600;padding:4px 10px;background:var(--surface);border-radius:6px;border:1px solid var(--border)">&larr; Status</a>
  <h1>🌿 Holochain Admin</h1>
  <span class="badge badge-ok" id="hdr-status">...</span>
  <span class="meta" id="hdr-meta"></span>
</header>

<nav id="nav">
  <button data-tab="dashboard" class="active">Dashboard</button>
  <button data-tab="apps">Apps</button>
  <button data-tab="peers">Peers</button>
  <button data-tab="chain">Chain</button>
  <button data-tab="storage">Storage</button>
  <button data-tab="logs">Logs</button>
</nav>

<!-- ── Dashboard ────────────────────────── -->
<div class="tab active" id="tab-dashboard">
  <div class="stats" id="dash-stats"></div>
  <div class="card">
    <h3>Node Info</h3>
    <div id="dash-info" style="font-size:.78rem;line-height:1.9"></div>
  </div>
  <div class="card">
    <h3>Cells</h3>
    <div id="dash-roles"></div>
  </div>
  <div class="card">
    <h3>Share</h3>
    <pre id="dash-share" style="font-size:.68rem;color:var(--muted);white-space:pre-wrap;line-height:1.6"></pre>
    <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="copyShare()">Copy</button>
  </div>
</div>

<!-- ── Apps ──────────────────────────────── -->
<div class="tab" id="tab-apps">
  <div class="card">
    <h3>Installed Apps</h3>
    <div id="apps-list"></div>
  </div>
  <div class="card">
    <h3>Install New hApp</h3>
    <div class="form-row">
      <div style="flex:3"><label>hApp URL (.happ)</label><input type="url" id="install-url" placeholder="https://..."></div>
      <div style="flex:2"><label>App ID (optional)</label><input type="text" id="install-id" placeholder="auto"></div>
    </div>
    <div class="form-row">
      <div><label>Network Seed (optional)</label><input type="text" id="install-seed" placeholder=""></div>
    </div>
    <button class="btn btn-green" id="install-btn" onclick="installApp()">Install</button>
  </div>
</div>

<!-- ── Peers ─────────────────────────────── -->
<div class="tab" id="tab-peers">
  <div id="peers-content"><div class="empty"><span class="spinner"></span> Loading...</div></div>
</div>

<!-- ── Chain ─────────────────────────────── -->
<div class="tab" id="tab-chain">
  <div class="row" style="margin-bottom:12px">
    <select id="chain-role" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;font-size:.78rem"></select>
    <button class="btn btn-blue btn-sm" onclick="loadChain()">Load</button>
  </div>
  <div class="card">
    <h3>Source Chain <span id="chain-count" style="color:var(--text);text-transform:none;font-size:.72rem"></span></h3>
    <div id="chain-content"><div class="empty">Select a role and click Load</div></div>
  </div>
</div>

<!-- ── Storage ───────────────────────────── -->
<div class="tab" id="tab-storage">
  <div id="storage-content"><div class="empty"><span class="spinner"></span> Loading...</div></div>
</div>

<!-- ── Logs ───────────────────────────────── -->
<div class="tab" id="tab-logs">
  <div class="row" style="margin-bottom:8px">
    <button class="btn btn-ghost btn-sm active" onclick="showLog('conductor',this)">Conductor</button>
    <button class="btn btn-ghost btn-sm" onclick="showLog('launcher',this)">Launcher</button>
    <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="copyLogs(this)">Copy</button>
    <button class="btn btn-blue btn-sm" onclick="refreshLogs()">Refresh</button>
  </div>
  <div class="card" style="padding:8px">
    <div class="log-box" id="log-content"></div>
  </div>
</div>

</div><!-- shell -->

<div class="toast" id="toast"></div>

<script>
const API = '';
let D = {};
let currentLogType = 'conductor';

// ── Navigation ───────────────────────────
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'peers') loadPeers();
    if (btn.dataset.tab === 'storage') loadStorage();
    if (btn.dataset.tab === 'logs') refreshLogs();
  });
});

// ── Toast ────────────────────────────────
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => el.className = 'toast', 3000);
}

// ── Fetch helpers ────────────────────────
async function api(path, opts) {
  const res = await fetch(API + path, opts);
  return res.json();
}
async function apiPost(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ── Dashboard ────────────────────────────
async function refresh() {
  try {
    D = await api('/api');
  } catch (e) {
    document.getElementById('hdr-status').textContent = 'Offline';
    document.getElementById('hdr-status').className = 'badge badge-off';
    return;
  }

  const s = document.getElementById('hdr-status');
  if (D.status === 'running') { s.textContent = 'Running'; s.className = 'badge badge-ok'; }
  else { s.textContent = D.status; s.className = 'badge badge-off'; }

  const meta = document.getElementById('hdr-meta');
  meta.textContent = (D.uptime ? 'Up ' + timeSince(D.uptime) : '') + (D.restartCount > 0 ? ' · ' + D.restartCount + ' restart(s)' : '');

  document.getElementById('dash-stats').innerHTML = [
    statCard(D.totalPeers, 'Peers', D.totalPeers > 0 ? '#60a5fa' : '#f87171'),
    statCard(D.totalRecords, 'Chain', '#a78bfa'),
    statCard(D.totalOps, 'DHT Ops', '#4ade80'),
    statCard(D.totalIntegrated, 'Integrated', '#fbbf24'),
  ].join('');

  document.getElementById('dash-info').innerHTML =
    '<b>Agent</b> <span class="mono">' + esc(D.agentKey) + '</span><br>' +
    '<b>Profile</b> ' + esc(D.nickname || 'not set') + (D.fields?.wdockerNode ? ' · ' + esc(D.fields.wdockerNode) : '') + '<br>' +
    '<b>Version</b> holochain ${HC_VERSION}<br>' +
    '<b>Platform</b> Android 13 · Termux · native<br>' +
    '<b>Bootstrap</b> ${BOOTSTRAP}';

  document.getElementById('dash-roles').innerHTML = D.roleStats.map(r =>
    '<div style="background:var(--bg);border-radius:8px;padding:10px 14px;margin-bottom:6px">' +
    '<div style="font-weight:700;font-size:.82rem;color:#93c5fd;margin-bottom:4px">' + esc(r.role) + '</div>' +
    '<div style="display:flex;gap:14px;font-size:.72rem;color:var(--muted)">' +
    '<span>' + r.records + ' records</span><span>' + r.ops + ' ops</span><span>' + r.peers + ' peers</span><span>' + r.integrated + ' DHT</span></div></div>'
  ).join('') || '<div class="empty">No roles</div>';

  try {
    const shareRes = await fetch(API + '/share');
    document.getElementById('dash-share').textContent = await shareRes.text();
  } catch {}

  renderApps();
  populateChainSelect();
}

function statCard(n, label, color) {
  return '<div class="stat"><div class="n" style="color:' + color + '">' + n + '</div><div class="label">' + label + '</div></div>';
}

// ── Apps ─────────────────────────────────
function renderApps() {
  const el = document.getElementById('apps-list');
  if (!D.apps || D.apps.length === 0) { el.innerHTML = '<div class="empty">No apps installed</div>'; return; }
  el.innerHTML = '<table><tr><th>App ID</th><th>Status</th><th>Roles</th><th>Actions</th></tr>' +
    D.apps.map(a => {
      const sid = esc(a.id);
      const short = sid.length > 50 ? sid.slice(0, 47) + '...' : sid;
      const statusTag = a.status === 'running' ? '<span class="tag tag-run">Running</span>'
        : a.status === 'disabled' ? '<span class="tag tag-dis">Disabled</span>'
        : '<span class="tag tag-pau">' + esc(a.status) + '</span>';
      const roles = Object.keys(a.roles).join(', ');
      const actions = a.status === 'running'
        ? '<button class="btn btn-yellow btn-sm" onclick="disableApp(\\''+sid+'\\')">Disable</button>'
        : '<button class="btn btn-green btn-sm" onclick="enableApp(\\''+sid+'\\')">Enable</button>';
      return '<tr><td title="' + sid + '" class="mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + short + '</td><td>' + statusTag + '</td><td>' + esc(roles) + '</td><td class="row">' + actions + ' <button class="btn btn-red btn-sm" onclick="uninstallApp(\\''+sid+'\\')">Uninstall</button></td></tr>';
    }).join('') + '</table>';
}

async function enableApp(id) {
  toast('Enabling...');
  const r = await apiPost('/api/app/enable', { appId: id });
  r.ok ? toast('Enabled: ' + r.appId) : toast(r.error, true);
  setTimeout(refresh, 500);
}

async function disableApp(id) {
  toast('Disabling...');
  const r = await apiPost('/api/app/disable', { appId: id });
  r.ok ? toast('Disabled: ' + r.appId) : toast(r.error, true);
  setTimeout(refresh, 500);
}

async function uninstallApp(id) {
  if (!confirm('Uninstall "' + id.slice(0, 50) + '"?')) return;
  toast('Uninstalling...');
  const r = await apiPost('/api/app/uninstall', { appId: id });
  r.ok ? toast('Uninstalled') : toast(r.error, true);
  setTimeout(refresh, 500);
}

async function installApp() {
  const url = document.getElementById('install-url').value.trim();
  if (!url) { toast('Enter a URL', true); return; }
  const appId = document.getElementById('install-id').value.trim() || undefined;
  const seed = document.getElementById('install-seed').value.trim() || undefined;
  const btn = document.getElementById('install-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Installing...';
  try {
    const r = await apiPost('/api/app/install', { url, appId, networkSeed: seed });
    if (r.ok) {
      toast('Installed: ' + r.appId);
      document.getElementById('install-url').value = '';
      document.getElementById('install-id').value = '';
      document.getElementById('install-seed').value = '';
    } else {
      toast(r.error, true);
    }
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Install';
  setTimeout(refresh, 500);
}

// ── Peers ────────────────────────────────
async function loadPeers() {
  const el = document.getElementById('peers-content');
  el.innerHTML = '<div class="empty"><span class="spinner"></span> Loading peers...</div>';
  try {
    const r = await api('/api/peers');
    if (!r.ok) { el.innerHTML = '<div class="empty">' + esc(r.error) + '</div>'; return; }
    el.innerHTML = r.roles.map(role => {
      const rows = role.peers.map(p => {
        const isSelf = role.ownUrl && p.url === role.ownUrl;
        const host = p.url.match(new RegExp('://([^:/]+)'))?.[1] || '?';
        return '<tr class="' + (isSelf ? 'self' : '') + '"><td>' + esc(p.agent) + '</td><td class="peer-url" title="' + esc(p.url) + '">' + esc(p.url) + '</td><td>' + esc(p.expires) + '</td><td>' + (isSelf ? 'you' : '') + '</td></tr>';
      }).join('');
      return '<div class="card"><h3>' + esc(role.role) + ' <span style="color:var(--text);text-transform:none">(' + role.peers.length + ' peers)</span></h3>' +
        '<div class="mono" style="font-size:.6rem;color:var(--muted);margin-bottom:8px">DNA: ' + esc(role.dna) + '</div>' +
        (role.peers.length > 0
          ? '<table><tr><th>Agent</th><th>URL</th><th>Expires</th><th></th></tr>' + rows + '</table>'
          : '<div class="empty">No peers</div>') +
        '</div>';
    }).join('') || '<div class="empty">No roles</div>';
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--red)">' + esc(e.message) + '</div>'; }
}

// ── Chain ────────────────────────────────
function populateChainSelect() {
  const sel = document.getElementById('chain-role');
  const cur = sel.value;
  sel.innerHTML = (D.roles || []).map(r => '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + r + '</option>').join('');
}

async function loadChain() {
  const role = document.getElementById('chain-role').value;
  if (!role) return;
  const el = document.getElementById('chain-content');
  el.innerHTML = '<div class="empty"><span class="spinner"></span> Loading chain...</div>';
  try {
    const r = await api('/api/chain?role=' + role);
    if (!r.ok) { el.innerHTML = '<div class="empty">' + esc(r.error) + '</div>'; return; }
    document.getElementById('chain-count').textContent = '(' + r.count + ' records)';
    el.innerHTML = r.records.map(rec =>
      '<div class="chain-row"><span class="chain-seq">' + rec.seq + '</span>' +
      '<span class="chain-type">' + esc(rec.type) + '</span>' +
      (rec.detail ? '<span class="chain-detail">' + esc(rec.detail) + '</span>' : '') + '</div>'
    ).join('') || '<div class="empty">Empty chain</div>';
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--red)">' + esc(e.message) + '</div>'; }
}

// ── Storage ──────────────────────────────
async function loadStorage() {
  const el = document.getElementById('storage-content');
  el.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
  try {
    const r = await api('/api/storage');
    if (!r.ok || r.blobs.length === 0) { el.innerHTML = '<div class="empty">No storage data</div>'; return; }
    el.innerHTML = '<div class="card"><h3>Storage by DNA</h3><table><tr><th>DNA</th><th>Authored</th><th>Authored Disk</th><th>DHT</th><th>DHT Disk</th><th>Cache</th><th>Cache Disk</th></tr>' +
      r.blobs.map(b =>
        '<tr><td class="mono">' + esc(b.dna) + '</td><td>' + fmtB(b.authored) + '</td><td>' + fmtB(b.authoredDisk) + '</td>' +
        '<td>' + fmtB(b.dht) + '</td><td>' + fmtB(b.dhtDisk) + '</td>' +
        '<td>' + fmtB(b.cache) + '</td><td>' + fmtB(b.cacheDisk) + '</td></tr>'
      ).join('') + '</table></div>';
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--red)">' + esc(e.message) + '</div>'; }
}

// ── Logs ─────────────────────────────────
function copyLogs(btn) {
  const text = document.getElementById('log-content').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

function showLog(type, btn) {
  currentLogType = type;
  document.querySelectorAll('#tab-logs .row .btn-ghost').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  refreshLogs();
}

async function refreshLogs() {
  try {
    const r = await api('/api/logs?type=' + currentLogType + '&n=80');
    const el = document.getElementById('log-content');
    el.innerHTML = (r.lines || []).map(l => {
      l = l.replace(new RegExp('<','g'), '&lt;');
      let cls = 'i';
      if (l.includes('WARN') || l.includes('Failed')) cls = 'w';
      if (l.includes('ERROR') || l.includes('FATAL')) cls = 'e';
      return '<div class="' + cls + '">' + l + '</div>';
    }).join('') || '<div class="i">No logs</div>';
    el.scrollTop = el.scrollHeight;
  } catch {}
}

// ── Utilities ────────────────────────────
function esc(s) { return String(s || '').replace(new RegExp('&','g'),'&amp;').replace(new RegExp('<','g'),'&lt;').replace(new RegExp('>','g'),'&gt;').replace(new RegExp('"','g'),'&quot;'); }
function fmtB(n) { if (n > 1048576) return (n/1048576).toFixed(1)+' MB'; if (n > 1024) return (n/1024).toFixed(1)+' KB'; return n+' B'; }
function timeSince(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 0) return '';
  const m = Math.floor(d/60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m/60);
  if (h < 24) return h + 'h ' + (m%60) + 'm';
  return Math.floor(h/24) + 'd ' + (h%24) + 'h';
}

function copyShare() {
  navigator.clipboard.writeText(document.getElementById('dash-share').textContent)
    .then(() => toast('Copied!'))
    .catch(() => toast('Copy failed', true));
}

// ── Init ─────────────────────────────────
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

// ── Server ───────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(data));
  };

  try {
    // ── Static pages ─────────────────────
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (path === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(adminHTML());
      return;
    }

    if (path === '/share') {
      const d = await fetchLiveData();
      res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS });
      res.end(shareText(d));
      return;
    }

    // ── Read APIs ────────────────────────
    if (path === '/api') {
      json(await fetchLiveData());
      return;
    }

    if (path === '/api/peers') {
      json(await apiGetPeers());
      return;
    }

    if (path === '/api/chain') {
      const role = url.searchParams.get('role') || 'group';
      json(await apiGetChain(role));
      return;
    }

    if (path === '/api/storage') {
      json(await apiGetStorage());
      return;
    }

    if (path === '/api/net') {
      json(await apiGetNetStats());
      return;
    }

    if (path === '/api/logs') {
      const type = url.searchParams.get('type') || 'conductor';
      const n = parseInt(url.searchParams.get('n') || '50');
      const lines = type === 'launcher' ? getLauncherLog(n) : getLogTail(n);
      json({ ok: true, lines });
      return;
    }

    // ── Write APIs (POST) ────────────────
    if (req.method === 'POST') {
      const body = await readBody(req);

      if (path === '/api/app/enable') {
        json(await apiEnableApp(body.appId));
        return;
      }
      if (path === '/api/app/disable') {
        json(await apiDisableApp(body.appId));
        return;
      }
      if (path === '/api/app/uninstall') {
        json(await apiUninstallApp(body.appId));
        return;
      }
      if (path === '/api/app/install') {
        json(await apiInstallApp(body.url, body.appId, body.networkSeed));
        return;
      }
    }

    // ── Pretty dashboard ──────────────────
    if (path === '/') {
      const d = await fetchLiveData();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(dashboardHTML(d));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');

  } catch (e) {
    json({ ok: false, error: e.message?.slice(0, 300) || 'Internal error' }, 500);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use, exiting (launcher will retry)`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌿 Holochain Admin Panel: http://localhost:${PORT}/admin`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Share: http://localhost:${PORT}/share`);
});
