# fx-embedded

The [fx](https://github.com/vercel-labs/fx) agent harness, compiled to
WebAssembly, **running entirely on the Switch**. No bridge, no PC — the
console boots fx's real terminal UI, talks to the AI Gateway over WiFi, and
keeps sessions on the SD card.

```
AI Gateway <--HTTPS/WiFi-- fx-term.wasm (V8+JSPI, on Switch) <--ANSI--> fx TUI on screen
```

Sibling to [fx-switch](../fx-switch) (the bridge client): that one runs fx
on the PC with full shell tools; this one runs fx on the console with no PC
in the loop at all.

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
- Input: USB/system keyboards produce terminal bytes; Joy-Con: A enter ·
  B esc · X keyboard · Y ctrl-C · d-pad arrows · L/R pgup/pgdn · ZL/ZR
  scrollback · Minus exit · Plus: Send while the keyboard is up, otherwise
  clean exit.
- The host exposes fx's standard `terminal` workspace tool. There is no OS
  shell on Horizon, so commands are handled by a small root-confined
  interpreter backed by `sdmc:/switch/fx-embedded/workspace/`. It supports
  `pwd`, `ls`, `find`, `cat`, `head`, `wc`, `rg`, `echo`, `printf`, `mkdir`,
  `touch`, `cp`, `mv`, `rm`, `stat`, `&&`, `;`, and output redirection.
  Traversal outside the virtual `/workspace` root and shell pipelines are
  rejected.
- Config, prompt history, and fx sessions persist under
  `sdmc:/switch/fx-embedded/term/`.

## Setup (one-time)

1. The locally built V8 runtime
   (`../nx.js/nxjs.nro`, installed as
   `sdmc:/nx.js/nxjs-v1.0.0-beta.15.nro`). The app is a slim NRO and
   chainloads this shared runtime.
2. `bun run deploy` → pushes `sdmc:/switch/fx-embedded/fx-embedded.nro`
   (hbmenu → **Y** netloader, or an SD copy).
3. Launch via **title takeover: hold R on a game** when starting hbmenu —
   WebAssembly needs the application memory regime (`romfs/nxjs.ini`
   reserves 64 MiB of JIT code headroom; applet mode is too tight).
4. Optional `sdmc:/switch/fx-embedded/config.json` (`"resume": true` lets fx
   resume the newest SD session at boot; default is a fresh session):

   ```json
   { "env": { "AI_GATEWAY_API_KEY": "...", "FX_MODEL": "..." } }
   ```

   `FX_MODEL` is the supported way to pick a model on device: `/model` works
   in the TUI but loads its catalog through `fx_http_request`, the JSPI
   suspending import that is still a device experiment (see JOURNAL).

   An API key is currently required. Without it the app shows an actionable
   boot message and returns; it does not enter OAuth.

## Networking & sign-in (read before first login)

OAuth is intentionally disabled for now. It uses the request/response host
import, whose Promise resumes through the fetch callback path involved in the
observed V8/JSPI crashes. API-key model traffic instead uses the synchronous
stream imports described below.

### Crash forensics (2026-08-28)

Two symptoms, one boot: picking Sign-in crashed Atmosphere (2349-0004, all
zero registers); next day, keyboard input never rendered, then a crash at
reply time (2345-0008, hbloader, `User Break`). Findings from the pulled
crash reports, symbolicated against the runtime's `nxjs.elf` (devkitA64
addr2line; base anchored on `v8::base::OS::Abort`, all frames resolve):

- **TLS is fine**: the boot canary hits `https://ai-gateway.vercel.sh/` →
  HTTP 200, and the prompt POST to `/v3/ai/language-model` went out.
- The abort reports resolve into the **V8 JSPI wasm import-wrapper/resume
  machinery** (frames consistently attribute to
  `CompileWasmImportCallWrapper(…, Suspend)` / `Debug::OnException` /
  `PerformSideEffectCheckForCallback` across both reports): it fires when a
  Suspending import's promise resolves from inside the fetch callback chain.
  Input-path suspends (`fd_read`/`poll_oneoff`) worked in the same sessions.
  This is strong attribution, but it is not yet a minimal host-independent
  JSPI reproduction suitable for an upstream V8 report.
- `𝒇` tofu: fx's wordmark is U+1D487, which Geist Mono lacks (browsers fall
  back to system fonts; the runtime can't). The app maps the mathematical
  latin ranges to ASCII.

Mitigations shipped:
- **fx itself is patched (../fx `src/gateway/host_stream_provider.zig`)** to
  sleep 10 ms (`io_mod.sleep`, lowering to wasi poll_oneoff) before each
  not-ready stream poll — status/next/before-read, three call sites. The
  host imports (`fx_http_stream_status/next`) are therefore FULLY
  SYNCHRONOUS in `runtime.ts`: zero JSPI cycles on the network path. The
  sleep is the proven-safe suspend pattern (timer-resumed, exercised
  thousands of times by the idle loop). `git diff ../fx` shows the patch —
  keep it across fx pulls. This is an adapter-specific workaround, not yet a
  proven generic fx bug: upstream's SDK transport is asynchronous and does
  not use this synchronous polling design.
- the rAF loop and the `fd_write`→terminal side-channel are
  exception-guarded (a render error logs to `fx-embedded.log` and shows a
  red line instead of freezing the screen or aborting V8).
- `𝒇` glyph mapped to `f`; **streaming indicator** in the status bar
  (animated dots) driven by stream open/end events.
- OAuth's `fx_http_request` stays suspend-based and is not entered by the app.
- SD breadcrumbs use synchronous append and, on the local patched nx.js
  runtime, `fsdevCommitDevice("sdmc")` after each line. That improves the
  durability boundary, but missing logs alone do not prove this was their
  root cause. Each boot writes both `sdmc:/switch/fx-embedded.log` and a
  unique `sdmc:/switch/fx-embedded/logs/fx-embedded-<epoch>.log` so MTP/DBI
  cannot silently serve an older run under the same filename.
- exit path settles 1.2 s before `Switch.exit()` so socket teardown
  finishes (an ftpd data abort in hbloader followed one of our sessions —
  possibly a poisoned bsd session, the JOURNAL's documented fragility).

## Iterate

```sh
bun run wasm        # build/copy fx-term.wasm into romfs (FX_ZIG/FX_DIR overridable)
bun run build       # bundle src/main.ts -> romfs/main.js (esbuild)
bun run nro         # pack the NRO (romfs: main.js + nxjs.ini + fx-term.wasm)
bun run nro:fat     # also build one self-contained NRO with the local nx.js runtime
bun run deploy      # all of the above + netloader push
bun run check       # TypeScript contract check
bun run term:stream # deterministic mock streaming through the real wasm
bun run term:workspace # deterministic two-turn terminal-tool proof
bun run term:input  # whole-line stdin fidelity (swkbd submits one chunk)
bun run term:model  # /model picker path (uses the Suspending fx_http_request import)
bun run term:exit   # exit during an endless 429 retry must settle (host-loop starvation guard)
bun run term:smoke  # real Gateway smoke when .env supplies a key/model
bun run test:push   # byte-verify the netloader pusher against a mock hbmenu
```

Wasm changes ride in the NRO (redeploy); to iterate on the wasm without a
push, drop a fresh build at `sdmc:/switch/fx-embedded/fx-term.wasm` — it
overrides the romfs copy.

`scripts/bundle.sh` falls back to a Linux esbuild from a sibling checkout when
`node_modules` was installed from Windows (win32 binary under WSL).

App JS-only changes technically ship in the NRO too (this is a standalone
app — no live-bundle heal like fx-switch; rebuild + push is the loop).

The normal artifact is slim (5 MB) and uses the shared runtime. For the
literal single-file demo, `fx-embedded-fat.nro` embeds the freshly built local
`../nx.js/nxjs.nro`; use `bun run push:fat` while hbmenu's netloader is armed.

## Host-side verification

The host tests boot the same `romfs/fx-term.wasm` through the same host layer
under JSPI. `term:workspace` goes further than a mocked import: a fake Gateway
asks the real fx agent loop to call `terminal`, the adapter creates a file,
and fx returns the tool result in a second model request. It also checks root
confinement, pipeline rejection, and the filesystem-commit hook.

`term:smoke` requires a live backend. It only passes when it observes HTTP
200, model stream bytes, and clean stream completion; a Gateway 503 is
reported as a failed live check rather than mistaken for model output.

## Current bug-report threshold

- **Ready to report to nx.js:** `UV_DISCONNECT` was dropped when it did not
  match the active poll interest. The local patch surfaces an error to JS and
  has a host regression test (`../nx.js/packages/runtime/test/tcp-host.test.ts`).
- **Useful experiment, not a proven bug:** explicit SD filesystem commit for
  crash breadcrumbs. libnx documents the commit boundary, and the patched
  runtime compiles, but an on-device kill/abort matrix is still needed.
- **Not ready to report:** the fx 10 ms polling patch and the V8/JSPI crash.
  Both need a smaller reproduction that removes this app's custom transport.
- **Retired hypothesis:** short versus long screen-off duration. Current
  evidence does not support a duration threshold; tests should treat any
  suspend/resume as the same event class.

Traps and wire facts are documented in fx-switch's `docs/JOURNAL.md`
(v0.11.0 entry covers this host layer in depth).
