# fx-embedded

The [fx](https://github.com/vercel-labs/fx) agent harness, compiled to
WebAssembly, **running entirely on a Nintendo Switch**. No bridge, no PC —
the console boots fx's real terminal UI, talks to the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) over WiFi, and keeps
sessions on the SD card.

```
AI Gateway <--HTTPS/WiFi-- fx-term.wasm (V8+JSPI, on Switch) <--ANSI--> fx TUI on screen
```

## What works (on device)

- The full fx terminal UI — streaming responses, markdown, interleaved
  tool-call rendering, scrollback.
- Tool calls: fx's standard `terminal` workspace tool, backed by a
  root-confined command interpreter over `sdmc:/switch/fx-embedded/workspace/`
  (`pwd ls find cat head wc rg echo printf mkdir touch cp mv rm stat`,
  `&&`/`;`, output redirection; no traversal out of the root, no pipelines).
- Input: the inline software keyboard (tap or X; **+** sends), USB and
  Bluetooth keyboards typing straight into the prompt, Ctrl+C (or Y) to
  cancel a stream mid-flight.
- Sleep/wake: close the lid mid-stream, wake, resend — the runtime detects
  the wake, resets the socket layer, and the app tells you the connection
  was lost. No crashes, no zombie networking.
- Sessions persist under `sdmc:/switch/fx-embedded/term/`; `"resume": true`
  picks up the newest one at boot.

## Requirements

- Switch running [Atmosphère](https://github.com/Atmosphere-NX/Atmosphere)
  with hbmenu (tested: Atmosphère 1.11.2, firmware 21.1).
- Launch via **title takeover** (hold R on a game): WebAssembly needs the
  application memory regime — applet mode is too tight for V8's JIT arena.
- An AI Gateway API key, or a Vercel account to sign in with from inside
  fx (`/login`, device code).
- The patched [nx.js](https://github.com/TooTallNate/nx.js) V8 runtime this
  app is developed against (keyboard, sleep/wake, and fetch fixes are being
  upstreamed; until they land, build the runtime from the fork's
  [`upstream-series` branch](https://github.com/srps/nx.js/tree/upstream-series)).
  The prebuilt fat NRO in [Releases](../../releases) already bundles it.

## Setup

1. Copy `fx-embedded-fat.nro` (from [Releases](../../releases);
   self-contained: runtime + app + wasm) to
   `sdmc:/switch/fx-embedded/fx-embedded.nro`, or use
   `bun run deploy` with hbmenu's netloader (**Y**). The slim NRO variant
   chainloads a shared `sdmc:/nx.js/` runtime instead.
2. Optionally create `sdmc:/switch/fx-embedded/config.json`:

   ```json
   { "env": { "AI_GATEWAY_API_KEY": "...", "FX_MODEL": "moonshotai/kimi-k3" } }
   ```

   `FX_MODEL` is the supported way to pick a model on device (`/model` works
   in the TUI but its catalog fetch rides the one host import that is still
   a device experiment — see design notes). Add `"resume": true` to resume
   the newest session at boot.
3. Hold R on a game → hbmenu → fx-embedded.

Without a key, run `/login` inside fx: it shows a `vercel.com/device` URL
and a code, polls for approval, then picks your Vercel team (the only one
automatically, otherwise a picker — confirm with A). The AI Gateway
rejects a login token that names no team with HTTP 401, so a team is not
optional. The session (access + refresh token, team) is kept in
`sdmc:/switch/fx-embedded/term/oauth-session.json`, with the same exposure
as the key in `config.json`: the SD card is the only storage the Switch
has. When both a key and a login exist, fx uses the key first (its normal
source precedence); `/setup` switches sources.

## Controls

A enter · B esc · X keyboard · Y ctrl-C · d-pad arrows · L/R pgup/pgdn ·
ZL/ZR scrollback · Minus exit · Plus sends while the keyboard is up,
otherwise clean exit. USB/Bluetooth keyboards type directly; Ctrl+C works.

## How it works

- `fx-term.wasm` — fx built with `zig build -Dwasm-surface=term` (plain WASI
  command, ~4.9 MB) — is bundled in the NRO's romfs.
- The app (an nx.js V8-runtime program) instantiates it with a hand-rolled
  host layer (`src/fxwasm/runtime.ts`, ported from fx's `sdk/fx-sdk.js`):
  WASI preview1 imports + the `fx` import namespace, blocking ones wrapped
  in `WebAssembly.Suspending`, `_start` driven via `WebAssembly.promising`
  (JSPI freezes/resumes the wasm stack around pending promises).
- TUI output is real ANSI, rendered by the runtime's headless-xterm canvas
  Console (`src/fxwasm/screen.ts`); the host also answers fx's terminal
  probes (color scheme, OSC 11 background + DA1 fence) on stdin.
- Wasm changes ride in the NRO; a build dropped at
  `sdmc:/switch/fx-embedded/fx-term.wasm` overrides the romfs copy for fast
  iteration.

## Design notes

**The network path is fully synchronous by design.** On this V8 build,
resuming a JSPI-suspended wasm import from inside the fetch callback chain
aborts the process (symbolicated to the wasm import-wrapper/resume
machinery; not yet reduced to a host-independent V8 report). So the fx
side carries a small patch (`patches/fx-switch-patches.diff`, applied to
the fx checkout before `bun run wasm`):
the stream poller sleeps 10 ms via WASI `poll_oneoff` — the proven-safe,
timer-resumed suspend — before each not-ready poll, and the host's
`fx_http_stream_status/next` imports never suspend. Input-path suspends
(`fd_read`, `poll_oneoff`) are exercised thousands of times per session
and are stable. OAuth's request/response import (`fx_http_request`,
suspending) is the one import that still resumes from a fetch callback;
device runs of the full sign-in (metadata, device code, token polling,
teams, refresh) have not hit the abort, so `/login` is enabled.

**Sleep/wake is handled by the runtime, not the app.** A console sleep
kills the bsd socket session process-wide; using a stale session asserts
the `bsdsocket` sysmodule and takes networking down system-wide until
reboot. The patched nx.js runtime classifies frame gaps (CPU-busy vs
blocking-SD-op vs sleep), resets the socket layer on wake, settles
in-flight TLS reads with `ECONNRESET`, recreates libuv's self-wake pair,
and defers ambiguous cases to a reset-before-next-dispatch gate. The app
just shows "connection lost during sleep — send the prompt again".

**Rendering fidelity is testable off-device.** `host/render-capture.ts`
records the raw TUI byte stream against a real gateway;
`host/replay-xterm.ts` replays it through the same headless xterm the
console uses, at device geometry — pixel-for-pixel forensics without
touching the Switch.

## Iterate

```sh
bun run wasm        # build/copy fx-term.wasm into romfs (FX_ZIG/FX_DIR overridable)
bun run build       # bundle src/main.ts -> romfs/main.js (esbuild)
bun run nro         # pack the slim NRO
bun run nro:fat     # self-contained NRO with the local ../nx.js runtime
bun run deploy      # build + pack + netloader push
bun run check       # TypeScript contract check
bun run term:stream # deterministic mock streaming through the real wasm
bun run term:workspace # deterministic two-turn terminal-tool proof
bun run term:input  # whole-line stdin fidelity (swkbd submits one chunk)
bun run term:model  # /model picker path (uses the Suspending fx_http_request import)
bun run term:exit   # exit during an endless 429 retry must settle
bun run term:login  # /login against a mock Vercel: team saved, first call carries it
bun run term:smoke  # real Gateway smoke when .env supplies a key/model
bun run test:push   # byte-verify the netloader pusher against a mock hbmenu
```

The host tests boot the same `romfs/fx-term.wasm` through the same host
layer under JSPI. `term:workspace` goes beyond a mocked import: a fake
Gateway asks the real fx agent loop to call `terminal`, the adapter creates
a file, and fx returns the tool result in a second model request.
`term:smoke` requires a live backend and only passes on HTTP 200 + model
stream bytes + clean completion.

`scripts/bundle.sh` falls back to a Linux esbuild from a sibling checkout
when `node_modules` was installed from Windows (win32 binary under WSL).

## Upstream

Work found and fixed along the way, in various stages of upstreaming:

- **fx**: WASI builds emitted constant debug-trace ids, which merged all
  tool-call presentation groups into one block (fix on `switch-patches`,
  PR-ready). Opt-in stream poll pacing for synchronous hosts. On the wasm
  terminal, keystrokes bypassed the auth picker (typing after "Signed in"
  dismissed the team picker, so the first model call had no team and got
  HTTP 401); the interactive sign-in now also adopts the only team like
  `fx login` does.
- **nx.js**: global `addEventListener` never installed (USB/Bluetooth
  keyboards were unreachable in every app); fetch abort throwing on locked
  body streams; unhandled rejection in `Socket#close()` on errored streams;
  the sleep/wake socket-session reset machinery; inline swkbd cursor bug
  (text discarded after the first session) and the swkbd applet leak across
  app exit — see
  [swkbd-leak-repro](https://github.com/srps/swkbd-leak-repro).

## Credits

fx-embedded stands on three projects:

- **[fx](https://github.com/vercel-labs/fx)** (Apache-2.0) — the agent
  itself. The bundled `fx-term.wasm` is fx compiled to WASI, the on-device
  host layer is a port of fx's `sdk/fx-sdk.js`, and the console-specific fx
  changes ride in `patches/fx-switch-patches.diff`.
- **[nx.js](https://github.com/TooTallNate/nx.js)** (MIT) — the JavaScript
  runtime this app *is*; the fat NRO bundles it (a fork with fixes being
  upstreamed, see above).
- **[Atmosphère](https://github.com/Atmosphere-NX/Atmosphere)** (GPL-2.0) —
  the custom firmware this targets and the foundation all Switch homebrew
  stands on.

License texts and bundling details:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Built with AI assistance: Claude Fable 5, GPT 5.6-Sol, GLM 5.3, and
GLM 5.3 Flash.

## License

MIT for this repository's own code — see [LICENSE](LICENSE). The bundled
fx wasm, nx.js runtime, and xterm.js keep their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and keep that file
alongside any NRO you redistribute.
