# Goose — the phone page

The shell Bryan talks to Goose through (card #464). The metaphor is the right seat at night: the
cab is dark, the dash is lit warm, and the key is the one big lit thing. Tap to talk, tap again
when you're done (or just stop talking), and tap while Goose talks to cut in. The 988 button is in
the top bar on every screen.

It is a static page. Everything it knows comes from Goose on the Mac (`~/Goose`, port 8650), over
the tailnet. The API contract is `../docs/SPEC.md`: the CORE server routes and the turn events.

## What it never does

- **Never puts a string from the Mac in as markup.** Every word goes in through `textContent`.
  The CSP allows script only from `app.js` and style only from `app.css`.
- **Never sends the sponsor's number anywhere.** It is read and written only in this phone's
  localStorage (`goose.sponsor`) and used only as a `tel:` link. In `app.js` it lives in one
  fenced section that never touches the network, and `tools/smoke.js` scans every request for it.
- **Never keeps what was said.** The talk lives in page memory and on the Mac. Only the talk's id
  (`goose.conv`) is stored, so a reload can ask the Mac for the thread while it is still warm.
- **Never leaves the mic open behind a call or another app.** The page leaving the screen ends the
  take unsent, lets go of the mic and silences Goose.
- **Never honors a connect link for any address but this Mac's Goose on 8650**
  (`https://<name>.ts.net:8650`, or loopback 8650 for the preview), and never stores a key until
  `/api/health` answers 200 to it.

## Files

| file | what it is |
|---|---|
| `index.html` | the page: the top bar, the connect screen, the talk, four sheets |
| `app.js` | everything that moves: connect, the key, the ear, the turn stream, the voice queue, the sheets |
| `app.css` | the look; BMH tokens copied from `~/Local Models/bik/design/` |
| `sw.js` | the offline copy: cache-first for the shell, never `/api/`, never another origin |
| `manifest.webmanifest` | installs as **Goose** |
| `icons/` | the fighter pilot's helmet he made in Gemini, cut (never redrawn) and checked by `tools/make_icons.py` |
| `tools/smoke.js` | boots `app.js` in Node against a scripted Mac and walks every path |
| `tools/test_shell.py` | the shell's rules, read from the files, plus the smoke run |

## Run it on the Mac (the preview)

```sh
cd ~/Goose/shell && python3 -m http.server 8917 --bind 127.0.0.1
```

Then make a one-time link with `~/Goose/bin/goose-connect preview --preview`. It writes the link
to `~/Goose/data/connect_link.txt` (0600) and never prints it. Open that link in the preview.
The page reads the code, wipes it from the address bar before any request, trades it for its own
key, and checks the key with `/api/health`.

## On the phone

The page is published at `https://bik-goose.github.io/`, only on his word. The connect link
comes from `goose-connect <device> --qr`: scan it with the phone's camera and open it in Chrome,
then install. The page names itself `phone` (or `preview` on 127.0.0.1) when it connects.

## Changing it

- **Bump `CACHE` in `sw.js` on every change**, or the phone keeps serving the old page. A new
  version takes over in the background, and the page reloads into it only when he is idle: never
  mid-take, never mid-answer, never with words typed or a sheet open.
- After a new picture: put it at `~/Goose/design/goose-helmet-gemini.jpeg` (outside this public repo),
  re-measure the boxes at the top of `tools/make_icons.py`, `python3 tools/make_icons.py --render` (PIL and
  numpy), `python3 tools/make_icons.py --check`, then bump `CACHE`.
- The checks: `python3 tools/test_shell.py` (it runs `node --check` and `node tools/smoke.js`).
- Escape hatch: open the page with `#reset` to drop its worker and caches. The key and the
  sponsor's number stay.

## Two switches in app.js

- `KEEP_MIC = true`: the SPEC opens the mic once and keeps it while the page is on screen, so the
  next tap is live at once. If truck Bluetooth gets stuck in call mode because of it, set it to
  `false` and the mic closes after every take.
- `TURNER_KEYS`: a Bluetooth page-turner on the wheel (PageDown, PageUp, ArrowRight, ArrowLeft)
  works the key whenever no text field has focus and no sheet is open.
