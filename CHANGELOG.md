# Changelog

## 0.3.0 — 2026-11-02

- **Four clusters, seven endpoints**: 未名一号 / 未名生科一号 / 未名教学二号 / 未名二号, including their
  data-transfer nodes. The catalogue lives in `~/.pku-cluster/clusters.json` and can be edited.
- **A session is cluster × endpoint** (`wm1:login`, `wm1:data`, …) and owns its own ControlMaster socket,
  so several clusters can stay logged in **in parallel**; disconnecting one leaves the others alone.
- The session picker is a grouped dropdown (one compact bar instead of rows of pills), disabled
  targets are hidden rather than shown greyed out, and environment warnings sit in a grey footnote.
- `pku -c <cluster>[:<endpoint>] …` plus `pku sessions`, in both the bash and the Windows helper.
- Fixed: the sidebar dot polled the retired `/api/status`, so it stayed red on a live connection.
  It now reads `/api/state`, turns green, and shows the remaining time beside the label; an idle
  session is a light grey dot rather than an alarm. `connectedAt` now survives `DEFAULTS` merging
  and session syncs, which is what was hiding the time.
- WSL target: one relay per session on a dynamically allocated port (was a fixed 2222); with
  `networkingMode=mirrored` there is no vEthernet, so the relay binds `127.0.0.1` instead.
- Fixed: `login.py` now uses `pty.fork()`. A bare `openpty()` pty is not a controlling terminal, and
  OpenSSH only prints its password prompt when it can open `/dev/tty`, so the driver sat till the
  timeout reporting `no password prompt seen`.
- Fixed: ssh destinations are the real hostnames, not the `pku` alias — a `Host pku` block in the
  user's own ~/.ssh/config (for example BindInterface) used to break every connection.
- An existing `config.json` is migrated into the `wmjx2:login` session, keeping the account id.
- The Windows-local target is **disabled** (not merely warned about): Win32-OpenSSH has no ControlMaster,
  and MSYS ssh cannot hand a session to the one it creates (no fd passing), so commands could never reuse
  the login. Selecting it is refused, and the page explains it in one line.

## 0.2.0 — 2026-11-02

- **Target bar at the top of the page**: pick `本机` or any WSL distribution instead of
  always driving the first one. The choice is remembered in `~/.pku-cluster/target.json`.
- **Local (no WSL) target on Windows**: a new driver (`lib/windows.js`) talks to OpenSSH
  directly. The password and OTP reach ssh through an askpass helper
  (`resources/askpass.cjs`) instead of a pty, still without touching the disk.
- Windows-local mode uses Git for Windows' ssh, because Win32-OpenSSH cannot create the
  ControlMaster socket (`getsockname failed: Not a socket`); Diagnose says so instead of
  failing later.
- Local mode ships `pku.cmd` / `pku.cjs` (same verbs as the bash helper; push/pull use scp
  because a default Windows install has no rsync).
- The helpers are copied with LF endings regardless of the checkout's `core.autocrlf`, so a
  CRLF `#!/usr/bin/env bash` can no longer make `pku` exit 127; `.gitattributes` keeps
  `resources/` LF as well.
- The bash target keeps the existing python/pty driver unchanged.

## 0.1.2 — 2026-10-30

- Published to npm: `dsh plugin --profile <profile> add dsh-pku-cluster` now works.
- README: link the npm package page.

## 0.1.1 — 2026-10-30

- `Diagnose` now explains itself when the installed helper predates `--diagnose`
  (for example with `autoInstall: false`) instead of surfacing a misleading login error.
- README: document installing from a tarball, and warn that `git+https` needs Git on the machine
  (pnpm shells out to `git ls-remote`; without Git it fails with `ERR_PNPM_GIT_RESOLVE_FAILED`).

## 0.1.0 — 2026-10-30

First public release.

- Sidebar entry (“Connect cluster”) with a live status dot, plus an in-page login panel.
- Password + OTP sign-in; the OpenSSH ControlMaster is reused for 8 hours.
- Windows: a TCP relay runs **inside the plugin** so WSL can reach the cluster through the
  Windows VPN (Linux/macOS connect directly).
- Helper scripts (`login.py`, `pku`) and the connection config are installed on first load
  into `~/.pku-cluster/`, idempotently.
- The login driver uses only the Python standard library (`pty`), so no `pexpect`/pip step.
- “Diagnose” runs environment checks (python, pty, ssh, endpoint reachability, account id).
- Every HTTP route accepts loopback requests with a localhost Host header only.
- No credentials are stored: password and OTP travel over stdin and are discarded.
