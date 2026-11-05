/**
 * Local (no WSL) driver for Windows, session-based.
 *
 * A *session* is one connection: `{ key, host, port, user, controlPath }`.
 * Every session gets its own ControlMaster socket, so several clusters can stay
 * logged in at the same time.
 *
 * The WSL path hands the password to a pty in `login.py`. Windows has no pty in
 * CPython, so this driver speaks to OpenSSH differently: it sets
 * SSH_ASKPASS_REQUIRE=force and points SSH_ASKPASS at a small helper
 * (`askpass.cjs` behind `askpass.cmd`, because CreateProcess cannot run a .cjs
 * file), which answers the two prompts from the environment of the ssh process.
 * The secrets still never reach the disk.
 *
 * Multiplexing is the catch. Win32-OpenSSH accepts -M/-S but cannot create the
 * control socket, and fails with `getsockname failed: Not a socket`; only Git
 * for Windows' MSYS build really multiplexes. So the ssh binary is chosen here,
 * and a session without it reports why instead of pretending to work.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASKPASS_CMD, ASKPASS_JS, CONF_DIR, CONTROL_ROOT, PKU_CMD, PKU_JS } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.join(HERE, '..', 'resources');

export { ASKPASS_CMD, ASKPASS_JS, CONF_DIR, PKU_CMD, PKU_JS };

const SSH_CANDIDATES = [
  () => process.env.PKU_SSH,
  () => 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
  () => 'C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe',
  () => (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'ssh.exe') : ''),
  () => 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
];

let sshCache;

/** Locate ssh, and say whether it can actually multiplex. */
export function findSsh() {
  if (sshCache !== undefined) return sshCache;
  let found = null;
  for (const candidate of SSH_CANDIDATES) {
    let value = '';
    try { value = candidate() ?? ''; } catch { value = ''; }
    if (value && existsSync(value)) { found = value; break; }
  }
  if (!found) {
    // Last resort: let PATH decide. We cannot tell which build it is, so assume
    // the worst (no multiplexing) rather than promising reuse we cannot keep.
    found = 'ssh';
  }
  const multiplex = !/System32[\\/]OpenSSH/i.test(found);
  sshCache = { path: found, multiplex, exists: found === 'ssh' || existsSync(found) };
  return sshCache;
}

/**
 * Options that decide which control socket this invocation talks to. The
 * HostName/Port/User options must be repeated on every call (`-O check`
 * included): ssh expands the `%r@%h-%p` tokens of ControlPath from the
 * destination of *that* invocation, so a bare `-O check pku` would look for
 * `<localuser>@pku-22` and never find the master's socket.
 */
function socketOpts(session) {
  const args = ['-o', `HostName=${session.host}`, '-o', `Port=${session.port}`];
  if (session.user) args.push('-o', `User=${session.user}`);
  args.push('-o', `ControlPath=${session.controlPath}`);
  return args;
}

function sessionOpts(session) {
  const args = [...socketOpts(session)];
  if (findSsh().multiplex) {
    args.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=8h');
  }
  args.push(
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'TCPKeepAlive=yes',
  );
  return args;
}

/** Run ssh and collect its output. Never inherits stdio: there is no console. */
function runSsh(args, { env = {}, timeoutMs = 45_000, fork = false } = {}) {
  const ssh = findSsh();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ssh.path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch (error) {
      resolve({ code: -1, out: '', err: `cannot spawn ${ssh.path}: ${error.message}` });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ code: -1, out, err: `${err}timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: -1, out, err: e.message }));
    // `ssh -f` hands the connection to a grandchild and exits; that grandchild
    // keeps the inherited pipes open, so wait for 'exit' (this process) rather
    // than 'close' (all pipe holders) or we would block for the whole session.
    child.on(fork ? 'exit' : 'close', (code) => finish({ code, out, err }));
  });
}

function reachable(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/* ------------------------------------------------------------------ */
/* helpers installed into ~/.pku-cluster                               */
/* ------------------------------------------------------------------ */

function shim(target, label) {
  const node = process.execPath;
  return `@echo off\r\nrem ${label} — generated by dsh-pku-cluster, do not edit\r\n"${node}" "${target}" %*\r\n`;
}

/** Write the local-mode helpers. Idempotent; refreshes them on every load. */
export function installLocalAssets() {
  mkdirSync(CONTROL_ROOT, { recursive: true, mode: 0o700 });
  const files = [
    [ASKPASS_JS, readFileSync(path.join(RESOURCES, 'askpass.cjs'), 'utf8')],
    [PKU_JS, readFileSync(path.join(RESOURCES, 'pku.cjs'), 'utf8')],
    [ASKPASS_CMD, shim(ASKPASS_JS, 'ssh askpass helper')],
    [PKU_CMD, shim(PKU_JS, 'pku cluster helper')],
  ];
  for (const [file, text] of files) writeFileSync(file, text);
  return { ok: true, ssh: findSsh() };
}

/* ------------------------------------------------------------------ */
/* driver interface (one session at a time)                            */
/* ------------------------------------------------------------------ */

export async function checkMaster(session) {
  if (!findSsh().multiplex) return false;
  const result = await runSsh([...socketOpts(session), '-O', 'check', session.host], { timeoutMs: 15_000 });
  return result.code === 0;
}

export async function status(session) {
  const ssh = findSsh();
  const base = {
    ok: true,
    key: session.key,
    master: false,
    mode: 'direct',
    platform: 'windows-local',
    target: `${session.host}:${session.port}`,
    reachable: await reachable(session.host, session.port),
    user: session.user ?? '',
    multiplex: ssh.multiplex,
    ssh: ssh.path,
  };
  if (!ssh.multiplex) return base;
  base.master = await checkMaster(session);
  if (!base.master) return base;
  const info = await runSsh([...sessionOpts(session), session.host, 'hostname; whoami'], { timeoutMs: 20_000 });
  const lines = info.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length) base.host = lines[0];
  if (lines.length > 1) base.account = lines[1];
  // A master that answers -O check but resets every session request means this
  // ssh build cannot pass file descriptors over its control socket. MSYS'
  // AF_UNIX has no SCM_RIGHTS, so Git for Windows can open a master but never
  // hand a session to it; Win32-OpenSSH cannot open one at all. Commands then
  // re-authenticate, which needs a fresh OTP every time.
  base.reuse = info.code === 0;
  if (!base.reuse) {
    base.error = /send fds|Connection reset/i.test(info.err)
      ? 'this ssh build cannot reuse the connection for commands (no fd passing); use a WSL target'
      : (info.err.trim().split(/\r?\n/).pop() || 'session through the control socket failed');
  }
  return base;
}

/** Status of every session, checked concurrently — this is the polled call. */
export async function statusAll(sessions) {
  return Promise.all(sessions.map((session) => status(session)));
}

export async function login(session, password, otp) {
  const ssh = findSsh();
  if (!session.user) return { ok: false, stage: 'config', error: 'account id is not set' };
  if (!ssh.multiplex) {
    return {
      ok: false,
      stage: 'multiplex',
      error: `${ssh.path} cannot share a connection (Win32-OpenSSH has no ControlMaster); `
        + 'install Git for Windows to use the local target, or pick a WSL distribution',
    };
  }
  if (!(await reachable(session.host, session.port))) {
    return { ok: false, stage: 'network', target: `${session.host}:${session.port}`,
      error: `cannot reach ${session.host}:${session.port} (VPN not connected?)` };
  }
  if (await checkMaster(session)) {
    return { ok: true, master: true, already: true, target: `${session.host}:${session.port}` };
  }

  const env = {
    SSH_ASKPASS: ASKPASS_CMD,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    PKU_ASKPASS_PASSWORD: password,
    PKU_ASKPASS_OTP: otp,
  };
  const result = await runSsh([...sessionOpts(session), '-M', '-N', '-f', session.host], {
    env, timeoutMs: 120_000, fork: true,
  });
  if (result.code !== 0) {
    const detail = result.err.trim();
    const denied = /permission denied|authentication failed/i.test(detail);
    return {
      ok: false,
      stage: denied ? 'auth' : 'connect',
      error: denied ? 'password or one-time code rejected' : (detail.split(/\r?\n/).pop() || 'ssh failed'),
    };
  }
  const alive = await checkMaster(session);
  return {
    ok: alive,
    master: alive,
    stage: alive ? 'done' : 'post',
    error: alive ? null : 'ssh exited before the multiplexed connection was up',
  };
}

export async function logout(session) {
  const result = await runSsh([...socketOpts(session), '-O', 'exit', session.host], { timeoutMs: 15_000 });
  const alive = await checkMaster(session);
  return { ok: true, master: alive, detail: result.err.trim() || undefined };
}

export async function diagnose(session) {
  const ssh = findSsh();
  const checks = [];
  const add = (check, ok, detail, fix = '') => checks.push({ check, ok, detail, fix: ok ? '' : fix });

  add('node', Boolean(process.versions.node), process.versions.node, 'the plugin host itself is node');
  add('ssh binary', ssh.exists, ssh.path, 'install Git for Windows (it bundles ssh)');
  add('ssh multiplexing', ssh.multiplex,
    ssh.multiplex ? 'ControlMaster available' : 'Win32-OpenSSH cannot share a connection',
    'install Git for Windows, or run the plugin inside WSL');
  add('askpass helper', existsSync(ASKPASS_CMD) && existsSync(ASKPASS_JS),
    existsSync(ASKPASS_CMD) ? ASKPASS_CMD : 'missing',
    'set autoInstall: true, or reinstall the plugin to rewrite ~/.pku-cluster');
  add('ssh control dir', existsSync(CONTROL_ROOT), CONTROL_ROOT, 'create it by logging in once');
  const ok = await reachable(session.host, session.port);
  add(`endpoint ${session.host}:${session.port}`, ok, ok ? 'reachable' : 'not reachable',
    'connect the campus VPN, or check the host name');
  add('account id', Boolean(session.user), session.user || 'not set',
    'enter your student/staff id in the plugin page');
  if (await checkMaster(session)) {
    const probe = await runSsh([...sessionOpts(session), session.host, 'true'], { timeoutMs: 20_000 });
    const reuse = probe.code === 0;
    add('session reuse', reuse,
      reuse ? 'commands ride the existing connection' : 'commands would re-authenticate (no fd passing in this ssh build)',
      'use a WSL target for command reuse; Windows-native ssh cannot multiplex sessions');
  }

  let version = '';
  try {
    const v = await runSsh(['-V'], { timeoutMs: 10_000 });
    version = (v.err || v.out).trim();
  } catch { /* ignore */ }
  return { ok: checks.every((c) => c.ok), mode: 'direct', platform: 'windows-local', ssh: ssh.path, version, checks };
}
