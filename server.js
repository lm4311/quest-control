// Quest Control: a local web panel for a USB-connected Meta Quest.
// It wraps a fixed set of adb commands; nothing here runs arbitrary input.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8722;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const ADB = findAdb();

function findAdb() {
  const sdkDirs = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
  ].filter(Boolean);
  const candidates = [process.env.ADB_PATH, ...sdkDirs.map((d) => path.join(d, 'platform-tools', 'adb.exe'))];
  return candidates.find((p) => p && fs.existsSync(p)) || 'adb';
}

function adb(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: !!err && err.code === 'ENOENT' });
    });
  });
}

// ---- settings and activity log -------------------------------------------

let settings = { autoKeep: false };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {}

function setAutoKeep(value) {
  settings.autoKeep = value;
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

const log = [];
function addLog(label, ok, output, source) {
  log.unshift({ time: Date.now(), label, ok, source, output: output.slice(0, 400) });
  log.length = Math.min(log.length, 30);
}

// ---- status ---------------------------------------------------------------

const STATUS_SCRIPT = [
  "dumpsys power | grep -E 'mWakefulness=|mIsPowered='",
  'settings get global stay_on_while_plugged_in',
  'dumpsys vrpowermanager 2>/dev/null | head -n 12',
  'dumpsys battery',
  'getprop debug.oculus.guardian_pause',
  'getprop ro.product.model',
].join('; echo @@; ');

const BATTERY_STATUS = { 2: 'charging', 3: 'discharging', 4: 'not charging', 5: 'full' };

async function findDevice() {
  const r = await adb(['devices']);
  if (r.missing) return { adbMissing: true };
  const devices = r.out
    .split(/\r?\n/)
    .map((line) => line.match(/^(\S+)\s+(device|unauthorized|offline)\b/))
    .filter(Boolean)
    .map((m) => ({ serial: m[1], state: m[2] }));
  return devices.find((d) => d.state === 'device') || devices[0] || {};
}

const pick = (text, re) => (text.match(re) || [])[1];

async function readStatus() {
  const base = { autoKeep: settings.autoKeep, log, checkedAt: Date.now() };
  const dev = await findDevice();
  if (dev.adbMissing) return { ...base, connection: 'no-adb' };
  if (!dev.serial) return { ...base, connection: 'none' };
  if (dev.state !== 'device') return { ...base, connection: dev.state, serial: dev.serial };

  const r = await adb(['-s', dev.serial, 'shell', STATUS_SCRIPT]);
  const parts = r.out.split('@@').map((s) => s.trim());
  if (!r.ok || parts.length < 6) return { ...base, connection: 'error', serial: dev.serial, error: r.out.slice(0, 400) };
  const [power, stay, vrpm, battery, guardian, model] = parts;

  const wakefulness = pick(power, /mWakefulness=(\w+)/) || 'Unknown';
  const proximity = pick(vrpm, /Virtual proximity state: (\w+)/) || 'Unknown';
  const wornOverride = proximity === 'CLOSE';
  const stayOn = Number(stay) > 0;
  const temp = Number(pick(battery, /temperature: (\d+)/));

  return {
    ...base,
    connection: 'ready',
    serial: dev.serial,
    model,
    wakefulness,
    awake: wakefulness === 'Awake',
    proximity,
    wornOverride,
    stayOn,
    alwaysOn: wornOverride && stayOn ? 'on' : wornOverride || stayOn ? 'partial' : 'off',
    headsetState: pick(vrpm, /^State: (\w+)/m) || 'Unknown',
    powered: /mIsPowered=true/.test(power),
    boundaryPaused: guardian === '1',
    battery: {
      level: Number(pick(battery, /level: (\d+)/)),
      status: BATTERY_STATUS[pick(battery, /status: (\d+)/)] || 'unknown',
      tempC: Number.isFinite(temp) ? temp / 10 : null,
    },
  };
}

// The page polls every couple of seconds; share one adb round trip between callers.
let statusCache = null;
function getStatus() {
  if (!statusCache || Date.now() - statusCache.at > 800) {
    statusCache = { at: Date.now(), value: readStatus() };
  }
  return statusCache.value;
}

// ---- actions --------------------------------------------------------------

const sh = (cmd) => ({ args: ['shell', cmd] });
const WORN_ON = sh('am broadcast -a com.oculus.vrpowermanager.prox_close');
const WORN_OFF = sh('am broadcast -a com.oculus.vrpowermanager.automation_disable');
const STAY_ON = sh('svc power stayon true');
const STAY_OFF = sh('svc power stayon false');
const WAKE = sh('input keyevent KEYCODE_WAKEUP');
const stopAutoKeep = () => setAutoKeep(false);

const ACTIONS = {
  wake: { label: 'Wake headset', steps: [WAKE] },
  sleep: { label: 'Put headset to sleep', steps: [sh('input keyevent KEYCODE_SLEEP')] },
  always_on: { label: 'Turn always-on on', steps: [WORN_ON, STAY_ON, WAKE] },
  // Turning any part of always-on off also stops auto re-apply, or it would switch straight back on.
  always_off: { label: 'Turn always-on off', steps: [WORN_OFF, STAY_OFF], after: stopAutoKeep },
  worn_on: { label: 'Worn override on', steps: [WORN_ON] },
  worn_off: { label: 'Worn override off', steps: [WORN_OFF], after: stopAutoKeep },
  stayon_on: { label: 'Stay awake on power on', steps: [STAY_ON] },
  stayon_off: { label: 'Stay awake on power off', steps: [STAY_OFF], after: stopAutoKeep },
  boundary_pause: { label: 'Pause boundary', steps: [sh('setprop debug.oculus.guardian_pause 1')] },
  boundary_resume: { label: 'Resume boundary', steps: [sh('setprop debug.oculus.guardian_pause 0')] },
  reboot: { label: 'Reboot headset', steps: [{ args: ['reboot'] }] },
  adb_restart: {
    label: 'Restart ADB',
    host: true,
    steps: [{ args: ['kill-server'], optional: true }, { args: ['start-server'], timeout: 20000 }],
  },
  autokeep_on: { label: 'Auto re-apply on', local: () => setAutoKeep(true) },
  autokeep_off: { label: 'Auto re-apply off', local: () => setAutoKeep(false) },
};

async function performAction(id, source) {
  const action = ACTIONS[id];
  if (action.local) {
    action.local();
    addLog(action.label, true, '', source);
    return { ok: true };
  }

  let prefix = [];
  if (!action.host) {
    const dev = await findDevice();
    if (dev.state !== 'device') {
      addLog(action.label, false, 'No headset connected.', source);
      return { ok: false, error: 'No headset connected.' };
    }
    prefix = ['-s', dev.serial];
  }

  const outputs = [];
  let ok = true;
  for (const step of action.steps) {
    const r = await adb([...prefix, ...step.args], step.timeout);
    if (r.out) outputs.push(r.out);
    if (!r.ok && !step.optional) {
      ok = false;
      break;
    }
  }
  if (ok && action.after) action.after();
  statusCache = null;
  addLog(action.label, ok, outputs.join('\n'), source);
  return { ok, output: outputs.join('\n') };
}

// Actions run one at a time so a manual click and an auto re-apply never interleave.
let queue = Promise.resolve();
function runAction(id, source) {
  const job = queue.then(() => performAction(id, source));
  queue = job.catch(() => {});
  return job;
}

// The worn override is lost when the headset reboots; put it back when asked to.
let keeping = false;
setInterval(async () => {
  if (!settings.autoKeep || keeping) return;
  keeping = true;
  try {
    const status = await getStatus();
    if (settings.autoKeep && status.connection === 'ready' && status.alwaysOn !== 'on') {
      await runAction('always_on', 'auto');
    }
  } finally {
    keeping = false;
  }
}, 5000);

// ---- http -----------------------------------------------------------------

const LOCAL_ORIGINS = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
// Websites allowed to drive this helper from the browser, e.g. the GitHub Pages copy of the panel.
const HOSTED_ORIGINS = [
  'https://lm4311.github.io',
  ...(process.env.QUEST_CONTROL_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
];

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  // Only this machine's own page may talk to the panel: other sites must not be able to drive the headset.
  const origin = req.headers.origin;
  const hosted = HOSTED_ORIGINS.includes(origin);
  if (!LOCAL_ORIGINS.includes(`http://${req.headers.host}`) || (origin && !hosted && !LOCAL_ORIGINS.includes(origin))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  if (hosted) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
  }

  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/status') {
    return sendJson(res, 200, await getStatus());
  }
  if (req.method === 'POST' && url === '/api/action') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'JSON only' });
    const body = await readBody(req);
    if (!body || !Object.hasOwn(ACTIONS, body.id)) return sendJson(res, 400, { error: 'Unknown action' });
    return sendJson(res, 200, await runAction(body.id, 'panel'));
  }
  sendJson(res, 404, { error: 'Not found' });
});

const openBrowser = () => execFile('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}`], { windowsHide: true }, () => {});
const wantsBrowser = process.argv.includes('--open');

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`Quest Control is already running at http://${HOST}:${PORT}`);
  if (wantsBrowser) openBrowser();
});

server.listen(PORT, HOST, () => {
  console.log(`Quest Control running at http://${HOST}:${PORT}  (adb: ${ADB})`);
  console.log('Keep this window open while you use the panel. Close it to stop.');
  if (wantsBrowser) openBrowser();
});
