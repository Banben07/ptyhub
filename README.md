# ptyhub

**A persistent server-side PTY session daemon with a modern web UI.**

[English](README.md) · [简体中文](README.zh-CN.md)

Your shells live in a daemon on the server, not in the browser. Close the tab, reload, lose the network, let your phone sleep, restart the web gateway — everything you have running keeps running. Open the page from another device and you are back in the same terminals.

No Git integration, no SSH, no tmux underneath, and nothing is ever written to `~/.claude` or `~/.codex`.

---

## How it is put together

```
ptyd  (always running, owns every PTY master fd)
  │
  ├── unix socket ──→ web  (HTTP/WS gateway, stateless, restart freely)
  │                        ↑ HTTP/WebSocket
  │                   browser / phone / tablet
  │
  └── unix socket ──→ ptyhub CLI / TUI  (attach from a local terminal)
```

The two processes are not a preference, they follow from how PTYs work. When the process holding a PTY's master file descriptor exits, the kernel sends SIGHUP to the foreground process group on the slave side and the shell dies. So the **only** holder of those descriptors is `ptyd`, which does nothing but manage PTY lifecycles and contains no HTTP code at all. The gateway is stateless: rebuilding the frontend, changing the API, upgrading it or crashing it never disturbs a shell.

If `ptyd` itself goes down the sessions go with it, the same as a tmux server. Its job is six things — create, read output, write input, resize, report exit, accept subscribers — so it rarely needs to change.

**Compared with tmux:** a tmux server implements a full terminal emulator internally. It parses escape sequences, maintains a virtual screen, then re-emits sequences for its clients. That translation layer is where true colour, mouse reporting and unusual glyphs go wrong. `ptyd` does no translation; the raw byte stream goes straight to xterm.js in the browser, so terminal emulation happens exactly once.

**Reconnecting** does not replay a stream from an arbitrary offset — that garbles full-screen programs. `ptyd` keeps a headless terminal (`@xterm/headless`) per session and serialises the exact sequence needed to rebuild the current screen. Reload the page and vim is still vim, htop is still htop.

---

## Install

```bash
git clone <your-fork> ~/ptyhub && cd ~/ptyhub
npm install
npm run build                      # build the UI into public/
node bin/ptyhub.mjs install-service
systemctl --user daemon-reload
systemctl --user enable --now ptyhub-ptyd ptyhub-web
loginctl enable-linger "$USER"     # survive logout and reboot
```

Put the CLI on your PATH:

```bash
ln -s ~/ptyhub/bin/ptyhub.mjs ~/.local/bin/ptyhub
```

Then get a link to open:

```bash
ptyhub link          # prints a URL carrying an access token
ptyhub link --qr     # prints a QR code as well — scan it from a phone
```

It listens on `127.0.0.1:7420` by default. To reach it from your laptop, forward a port:

```bash
ssh -N -L 7420:127.0.0.1:7420 your-server
```

Requires Node 22 or newer. `node-pty` installs from a prebuilt binary, so no compiler toolchain is needed.

---

## Security

**Loopback is not a security boundary on a shared machine.** On a cluster login node or any box with more than one account, every local user can reach `127.0.0.1:7420`, and this service hands out a shell. There is therefore no "no credentials" mode:

- With no password set, the first start mints a standing access token into `~/.local/state/ptyhub/token.json` (mode 0600) and prints a URL containing it. Open that once and the device is authorised for 90 days; after that the bare address works.
- `ptyhub passwd` switches to a username and password. The token is retired immediately; devices already authorised keep working.
- `ptyhub link --qr` mints a single-use pairing link for phones and tablets. The key rides in the URL fragment, not the query string, so it never reaches the server log or a Referer header.
- Only an explicit `"trustedNetwork": true` in the config turns authentication off entirely. Use it only where the network already authenticates — a WireGuard or Tailscale interface, for instance.

Device credentials are stored as SHA-256 hashes and rotated on a schedule. Presenting a superseded credential after the grace window means the cookie was copied, so the whole device chain is revoked rather than quietly accepted. Settings → Devices lists every authorised browser and can revoke them individually.

WebSocket upgrades validate the `Origin` header, without which any site you visit could open a socket to your shell — SameSite cookies do not fully cover the WebSocket handshake. REST relies on SameSite plus the same Origin check. Failed logins back off exponentially per source IP and lock out for fifteen minutes after ten attempts.

Plainly: anyone holding a credential is you, on that machine. Put Caddy or Tailscale in front before exposing the port.

---

## The web UI

A tab strip across the top, a collapsible session list on the left, and a workspace that splits horizontally and vertically to any depth.

Each tab shows the session name and the **foreground process**, so you see `claude`, `htop` or `vim` rather than `bash` forever. A dot appears when a background session produces output you have not looked at.

**Tabs can be dragged.** Drop one elsewhere in the strip to reorder it; the order is stored server-side and follows you to other devices. Drop one onto a pane to show it there, or onto a pane's edge to split that pane and place the terminal in the new half. A live preview shows exactly what the drop will produce.

**Right-click a tab** (long-press on touch) for rename, pin, lock, split and close.

**Lock** protects a session from being closed. It is enforced by `ptyd`, not by the UI: `ptyhub kill` refuses it too, and every other browser sees the lock. Use it on the long-running job you do not want to lose to a stray click. `ptyhub kill --force` is the deliberate way past it.

**Pin** keeps a session at the front of the tab strip.

Closing a terminal is a single click; the tab disappears and the pane reveals the next terminal, the way a browser tab does. Sessions that exit on their own stay in the list showing their exit code, because that is when the exit code is worth reading.

### Sizing across devices

Terminals follow their window. Drag the browser, collapse the sidebar, drag a splitter, rotate a phone — `tput cols` reports the new value immediately.

When several devices watch one session, the size follows **whichever one you are using**. Clicking into a pane or typing in it claims the session for that device; switch back to the other and click once to take it back.

Phones size the session for themselves by default, so the text is readable. Switch the setting to *Watch* if you would rather observe a desktop session without reshaping it, in which case the phone keeps the desktop's column count and scales the whole picture down.

### Keyboard

Every shortcut is a leader prefix followed by one key. The default leader is `Ctrl+\`, matching the detach prefix in `ptyhub attach`.

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `c` | New terminal | | `\|` or `\` | Split right |
| `x` | Close terminal | | `-` | Split down |
| `r` | Rename | | `w` | Close pane |
| `n` / `p` | Next / previous | | `o` | Focus next pane |
| `1`–`9` | Select by index | | `f` | Search in terminal |
| `b` | Toggle sidebar | | `k` | Command palette |
| `+` / `_` / `0` | Font bigger / smaller / reset | | `l` | Clear screen |
| `,` | Settings | | | |

Nothing takes `Ctrl/Cmd+N`, `+W`, `+T` or `+K` from the browser, and nothing takes `Ctrl+C`, `Ctrl+D` or `Ctrl+R` from the shell. The whole map lives in `~/.config/ptyhub/keymap.json` and is editable in Settings → Keyboard, leader included.

**Do not set the leader to `Ctrl+Space`.** That is the input-method toggle on Windows, macOS and Linux; for anyone typing Chinese, Japanese or Korean the keystroke never reaches the page and every shortcut silently stops working. Settings warns about combinations known to be swallowed.

### Mobile

The session switcher moves to a bottom sheet and a virtual key row appears, because a phone keyboard has no Esc, Tab, Ctrl or arrows and without them vim and every interactive CLI are unusable. Ctrl and Alt latch for one keystroke. The soft keyboard shrinks the terminal rather than covering it. "Add to Home Screen" gives a standalone window with no address bar.

### Appearance

Theme, font, size, line height, letter spacing, ligatures, cursor style and blink, scrollback, copy-on-select, right-click paste and clickable links all apply live and are stored on the server, so a new device inherits them. Font size is remembered per device class, so enlarging it on a desktop does not ruin the phone.

Built-in themes: One Dark, Tokyo Night, Dracula, Solarized (dark and light), GitHub Light, plus two of ptyhub's own. The interface chrome and the terminal palette come from the same tokens, so switching theme repaints both and they cannot drift apart.

Powerline glyphs need a Nerd Font: run `ptyhub fetch-font nerd` on the server, then turn on "Nerd Font glyphs" in Settings → Font. Enabling ligatures switches to the DOM renderer, because the WebGL renderer cannot draw them — that is the one trade-off behind the switch.

The tab icon is static by default. Turning on "Animate the tab icon" makes it report connection health and unseen output instead.

---

## Command line

Running `ptyhub` with no arguments opens a session picker: arrows or `j`/`k` to move, Enter to attach, `n` new, `x` close, `r` rename, `/` filter, `q` quit.

| Command | What it does |
|---|---|
| `ptyhub ls` | List sessions |
| `ptyhub new [name] [-- cmd…]` | Create one and attach |
| `ptyhub attach <id\|name>` | Attach to a session |
| `ptyhub kill [--force] <id\|name>` | Close it |
| `ptyhub lock <id\|name>` | Protect it from being closed |
| `ptyhub unlock <id\|name>` | Remove the protection |
| `ptyhub rename <id> <new name>` | Rename |
| `ptyhub status` | Daemon, session count, auth mode |
| `ptyhub passwd` | Set the web password |
| `ptyhub link [--qr]` | Access or pairing link |
| `ptyhub fetch-font nerd` | Download the Nerd Font for the UI |
| `ptyhub install-service` | Write the systemd --user units |

Sessions can be addressed by full id, id prefix or name. Inside `attach`, `Ctrl+\` then `d` detaches and leaves everything running; pressing `Ctrl+\` twice sends one literal byte. What you attach to here is the same session the browser shows, with input visible on both sides in real time.

---

## Running it

```bash
systemctl --user status  ptyhub-ptyd ptyhub-web
systemctl --user restart ptyhub-web     # sessions unaffected; browsers reconnect
systemctl --user restart ptyhub-ptyd    # kills every session — rarely needed
```

After changing frontend code, `npm run build` and reload the browser; the gateway reads files per request and needs no restart.

`journalctl` is not readable by unprivileged users on some systems, so both daemons also write `~/.local/state/ptyhub/web.log` and `ptyd.log`.

---

## Where your data lives

Nothing is stored inside the repository.

| Path | Contents | Mode |
|---|---|---|
| `~/.config/ptyhub/config.json` | Bind address, port, shell, resize policy | 0644 |
| `~/.config/ptyhub/auth.json` | Username and scrypt hash (never a plaintext password) | 0600 |
| `~/.config/ptyhub/keymap.json` | Leader key and bindings | 0644 |
| `~/.config/ptyhub/prefs.json` | Theme, font, layout, tab order, pins | 0644 |
| `~/.local/state/ptyhub/token.json` | Standing access token, when no password is set | 0600 |
| `~/.local/state/ptyhub/devices.json` | Device credential hashes, labels, addresses | 0600 |
| `~/.local/state/ptyhub/sessions.json` | Session metadata mirror, for display only | 0600 |
| `$XDG_RUNTIME_DIR/ptyhub/ptyd.sock` | IPC socket | 0600 |

Common `config.json` settings:

```jsonc
{
  "bind": "127.0.0.1",      // set a password before moving off loopback
  "port": 7420,
  "shell": null,            // null means $SHELL
  "shellArgs": ["-l"],
  "scrollback": 10000,
  "autoCreateFirstSession": true,
  "resizePolicy": "active", // "active" follows the device in use, "min" takes the smallest
  "reviveScreen": true,     // exact screen restore; off falls back to raw replay
  "trustedNetwork": false,  // true disables auth entirely
  "allowedOrigins": []      // extra origins for a reverse proxy
}
```

Child processes inherit `ptyd`'s environment plus `TERM=xterm-256color` and `COLORTERM=truecolor`, and nothing else.

---

## Troubleshooting

**Shortcuts do nothing.** Check that the leader is not `Ctrl+Space`; see the keyboard section above.

**The terminal is tiny and stuck in a corner.** Another device narrowed the session. Click into the terminal here and it resizes to your window.

**Boxes instead of prompt icons.** Missing Nerd Font; run `ptyhub fetch-font nerd`.

**The status pill turns amber or red.** Amber is reconnecting, red means the gateway cannot reach `ptyd`. Nothing running is lost in either case.

**A login page with no password set.** That device is not authorised yet. Run `ptyhub link` on the server.

---

## Development

```bash
npm run ptyd       # run the daemon in the foreground
npm run web        # run the gateway in the foreground
npm run dev        # Vite dev server on 7421, proxying /api and /ws
npm run build
npm run icons      # regenerate icons from web/assets/icon.svg
npm run typecheck
npm test           # all four end-to-end suites
```

Every test is end-to-end against real processes in throwaway XDG directories, so they never touch a real configuration.

| Suite | Covers |
|---|---|
| `test:ptyd` | Session lifecycle, screen restore, size reconciliation, locking, viewers outliving each other |
| `test:web` | REST, WebSocket, all three auth paths, cross-origin rejection, gateway restart |
| `test:cli` | `attach` inside a real PTY, the detach sequence, the picker, lock refusal |
| `test:ui` | Headless Chromium driving the real interface: typing, resize, restore, shortcuts, themes, tab drag, mobile |

---

## License

MIT. See [LICENSE](LICENSE).
