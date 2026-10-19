# Web Terminal (`root#` in the browser)

An authenticated, full interactive terminal for the machine/container running this
app. Backend: `node-pty` (a real PTY, so `vim`, `top`, `htop`, `tmux` all work).
Frontend: xterm.js, bundled locally in `public/shell/vendor` (no CDN needed).

```
http://<your-host>:<port>/shell/
```

You get a normal prompt such as `root@1a2b3c:/#` and can operate the VPS from a
browser or phone.

## Start

```bash
# recommended: pin the password yourself
SHELL_PASSWORD='change-me-to-a-long-random-string' node index.js
```

If `SHELL_PASSWORD` is not set, a random password is generated, printed at
startup, and persisted to `./.shell-token` (mode 0600) so it survives restarts
inside the same container:

```
[shell] ============================================================
[shell]  Web terminal ready:  http://localhost:3000/shell/
[shell]  Password:            xxxxxxxxxxxxxxxxxxxxxxxx
[shell] ============================================================
```

Docker:

```bash
docker build -t infrlo .
docker run -d --name infrlo -p 3000:3000 \
  -e SHELL_PASSWORD='change-me' \
  infrlo
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SHELL_PASSWORD` | random | Login password. Set this on a public VPS. |
| `SHELL_DISABLE` | unset | `1` turns the terminal off completely. |
| `SHELL_PATH` | `/shell` | URL prefix (`/shell` → `/shell/`). |
| `SHELL_TOKEN_FILE` | `./.shell-token` | Where the generated password is stored. |
| `SHELL_CMD` | login shell | Run a single command instead of bash, e.g. `htop` or `tmux new -A -s web`. |
| `SHELL_CWD` | `$HOME` | Initial working directory. |
| `SHELL_MAX_SESSIONS` | `5` | Concurrent terminal limit. |
| `SHELL_SESSION_TTL_MS` | `43200000` (12h) | Login cookie lifetime. |

Login can also be done with a URL once:
`http://host:3000/shell/?token=<password>` sets the cookie and redirects to `/shell/`.

## Security notes

* Anyone who logs in gets **a shell as the user running this process** (root in
  the container). Treat the password like an SSH key.
* The session cookie is `HttpOnly` + `SameSite=Strict`; wrong passwords are
  rate-limited (8 failures / 5 min / IP).
* Put it behind HTTPS (or Cloudflare/Argo) before exposing it to the internet.
  Reverse proxies must forward WebSocket upgrades for `/shell/ws`.
* `SHELL_DISABLE=1` removes the whole surface if you do not need it.

## Tests

```bash
npm test
```

`test/shell.test.js` starts a throwaway HTTP server, mounts the terminal, and
verifies routing passthrough, login/cookies, 401 on anonymous WebSocket
upgrades, PTY resize, command output, the prompt shape, exit events and logout.
