#!/usr/bin/env node
/**
 * pku — local (Windows, no WSL) cluster helper.
 *
 * Installed as ~/.pku-cluster/pku.cjs with a pku.cmd shim, so `pku status`
 * works from cmd/PowerShell exactly like the WSL version. It never
 * authenticates by itself: it attaches to the ControlMaster socket the plugin
 * opened for that session when you logged in from the sidebar.
 *
 * Sessions are `<cluster>:<endpoint>`; pick one with -c or PKU_SESSION:
 *
 *   pku sessions
 *   pku -c wm1 status
 *   pku -c wm2:data push .\job.sh ~/jobs
 *
 * Windows has no rsync in a default install, so push/pull use scp.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONF_DIR = process.env.PKU_CLUSTER_DIR
  ? path.resolve(process.env.PKU_CLUSTER_DIR)
  : path.join(os.homedir(), '.pku-cluster');
const SESSIONS_DIR = path.join(CONF_DIR, 'sessions');
const SELECTED = path.join(CONF_DIR, 'selected-session.json');

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function slug(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function sessionFiles() {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function readSessionFile(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
  } catch {
    return null;
  }
}

const allSessions = () => sessionFiles().map(readSessionFile).filter(Boolean);

function selectedKey() {
  if (process.env.PKU_SESSION) return process.env.PKU_SESSION;
  try {
    const raw = JSON.parse(fs.readFileSync(SELECTED, 'utf8'));
    if (raw && typeof raw.key === 'string') return raw.key;
  } catch { /* fall through */ }
  return allSessions()[0]?.key ?? '';
}

function loadSession(key) {
  const file = path.join(SESSIONS_DIR, `${slug(String(key).replace(':', '-'))}.json`);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing */ }
  if (!raw) {
    const known = allSessions().map((s) => s.key).join(', ');
    fail(`unknown session '${key}'${known ? ` (known: ${known})` : ''}`);
  }
  return raw;
}

function findBinary(name) {
  const override = process.env[`PKU_${name.toUpperCase()}`];
  if (override) return override;
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', `${name}.exe`),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', `${name}.exe`),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return name;
}

function sshArgs(session) {
  const args = ['-o', `HostName=${session.host}`, '-o', `Port=${session.port}`];
  if (session.user) args.push('-o', `User=${session.user}`);
  args.push('-o', `ControlPath=${session.controlPath}`);
  return args;
}

function scpArgs(session) {
  const args = ['-o', `Port=${session.port}`];
  if (session.user) args.push('-o', `User=${session.user}`);
  args.push('-o', `ControlPath=${session.controlPath}`);
  return args;
}

function masterAlive(session) {
  const probe = spawnSync(findBinary('ssh'), [...sshArgs(session), '-O', 'check', session.host],
    { encoding: 'utf8', windowsHide: true });
  return probe.status === 0;
}

const USAGE = `usage: pku [-c <cluster>[:<endpoint>]] <command>

  -c, --cluster <key>  session to use, e.g. wm1 or wm1:data (default: the one
                       selected in the plugin page)

  status               connection state + login node info
  run '<command>'      run a command on the login node (no heavy compute!)
  push <local> <remote>  upload with scp
  pull <remote> <local>  download with scp
  sbatch <script> [dir]  upload and submit a batch job
  jobs                 show the queue
  log <file> [lines]   tail a job log
  shell                interactive shell
  down                 drop this session's multiplexed connection
  sessions             list the registered sessions
`;

function main(argv) {
  let key = '';
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-c' || arg === '--cluster') { key = argv[i + 1] ?? ''; i += 1; }
    else if (arg.startsWith('--cluster=')) key = arg.slice('--cluster='.length);
    else rest.push(arg);
  }
  const [cmd, ...args] = rest;

  if (cmd === 'sessions') {
    const rows = allSessions();
    if (!rows.length) fail('no sessions yet; log in from the DSH sidebar once');
    for (const s of rows) {
      process.stdout.write(`${String(s.key).padEnd(12)} ${String(s.host).padEnd(30)} user=${s.user ?? ''} mode=${s.mode ?? ''}\n`);
    }
    return;
  }
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  const session = loadSession(key || selectedKey());
  if (session.mode === 'relay') {
    fail(`session '${session.key}' is configured for WSL; run the WSL helper there instead`);
  }
  const SSH = findBinary('ssh');
  const SCP = findBinary('scp');

  const requireMaster = () => {
    if (!masterAlive(session)) {
      fail(`session '${session.key}' is not connected; log in from the DSH sidebar ('Connect cluster') first`);
    }
  };
  const run = (command) => {
    requireMaster();
    const result = spawnSync(SSH, [...sshArgs(session), session.host, command], { stdio: 'inherit', windowsHide: true });
    process.exit(result.status ?? 1);
  };

  switch (cmd) {
    case 'status':
      run('echo "host: $(hostname)"; echo "user: $(whoami)"; echo "home: $(pwd)"; echo "load: $(uptime | sed "s/.*load average: //")"');
      return;
    case 'run':
      if (!args.length) fail("usage: pku run '<command>'");
      run(args.join(' '));
      return;
    case 'push':
    case 'pull': {
      if (args.length !== 2) fail(`usage: pku ${cmd} <${cmd === 'push' ? 'local> <remote' : 'remote> <local'}>`);
      requireMaster();
      const [from, to] = cmd === 'push' ? [args[0], `${session.host}:${args[1]}`] : [`${session.host}:${args[0]}`, args[1]];
      const result = spawnSync(SCP, [...scpArgs(session), '-r', from, to], { stdio: 'inherit', windowsHide: true });
      process.exit(result.status ?? 1);
      return;
    }
    case 'sbatch': {
      if (!args.length) fail('usage: pku sbatch <script> [remote_dir]');
      requireMaster();
      const script = args[0];
      const dir = args[1] || '~/jobs';
      const mk = spawnSync(SSH, [...sshArgs(session), 'pku', `mkdir -p ${dir}`], { stdio: 'inherit', windowsHide: true });
      if (mk.status !== 0) process.exit(mk.status ?? 1);
      const up = spawnSync(SCP, [...scpArgs(session), script, `${session.host}:${dir}/`], { stdio: 'inherit', windowsHide: true });
      if (up.status !== 0) process.exit(up.status ?? 1);
      run(`cd ${dir} && sbatch ${path.basename(script)}`);
      return;
    }
    case 'jobs':
      run('squeue -u "$USER" 2>/dev/null || cqueue');
      return;
    case 'log':
      if (!args.length) fail('usage: pku log <file> [lines]');
      run(`tail -n ${args[1] || 60} ${args[0]}`);
      return;
    case 'shell':
      requireMaster();
      process.exit(spawnSync(SSH, [...sshArgs(session), session.host], { stdio: 'inherit', windowsHide: true }).status ?? 1);
      return;
    case 'down': {
      const result = spawnSync(SSH, [...sshArgs(session), '-O', 'exit', session.host], { encoding: 'utf8', windowsHide: true });
      process.stdout.write(result.status === 0 ? `disconnected ${session.key}\n` : 'nothing to disconnect\n');
      return;
    }
    default:
      process.stdout.write(USAGE);
  }
}

main(process.argv.slice(2));
