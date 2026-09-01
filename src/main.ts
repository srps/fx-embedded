/**
 * fx-embedded: the fx agent harness, compiled to WebAssembly, running
 * entirely on the Switch. No bridge, no PC — fx-term.wasm boots in V8 (via
 * JSPI), renders its real TUI to the screen, and talks to the AI Gateway
 * over WiFi. See src/fxwasm/ for the host layer.
 *
 * Boot order: banner → config.json (optional; env/key) → fx TUI → Minus
 * exits back to hbmenu.
 *
 *   sdmc:/switch/fx-embedded/config.json (optional)
 *     { "env": { "AI_GATEWAY_API_KEY": "...", "FX_MODEL": "..." } }
 *     — or { "apiKey": "..." }. Without a key, sign in with /login inside
 *       fx (Vercel device code); the login session is kept on the SD card.
 *       When both exist fx uses the API key first (its source precedence).
 *
 * Runtime requirements (nxjs.ini in romfs handles them): the V8-based
 * runtime with WebAssembly + JSPI, launched with hbmenu title takeover
 * (hold R on a game) for the application memory regime.
 */

import { TermSession, termConfigFrom, localTermAvailable } from "./fxwasm/term.js";
import { flog, flogPath } from "./flog.js";

const CONFIG_PATH = "sdmc:/switch/fx-embedded/config.json";
const APP_VERSION = "0.1.1";

function log(msg: string): void {
  // Before the term screen takes over, this lands on the runtime's own
  // console (auto-presented); after that it's SD-log only. Either way the
  // TermSession banner surfaces everything actionable on screen.
  try { console.log(msg); } catch { /* no console */ }
  try { flog(msg.replace(/\x1b\[[0-9;]*m/g, "")); } catch { /* optional */ }
}

// Log AND swallow. If these events are not preventDefault()ed, nx.js marks
// the process `had_error`: the C++ loop stops calling the JS frame handler
// (no timers, no rAF, no rendering, no libuv) and only `+` exits. Device runs
// 2026-08-30: the runtime's fetch-abort TypeError ("Cannot abort a stream that
// already has a writer") fired as an unhandled rejection on Minus, freezing
// the app mid-exit every time. fx's own state is unaffected by these errors.
addEventListener("error", (e: any) => {
  log(`\x1b[31m[error] ${e?.message ?? "unknown error"}\x1b[0m`);
  try { e?.preventDefault?.(); } catch { /* */ }
});
addEventListener("unhandledrejection", (e: any) => {
  log(`\x1b[31m[rejection] ${String(e?.reason ?? "?")}\x1b[0m`);
  try { e?.preventDefault?.(); } catch { /* */ }
});

/** Config without prompting — the TUI does all the talking. */
async function loadConfig(): Promise<any> {
  try {
    return await Switch.file(CONFIG_PATH).json();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  log(`\x1b[1mfx-embedded v${APP_VERSION}\x1b[0m — fx (wasm) on the Switch`);
  log(`[boot] per-run log: ${flogPath}`);
  log("runtime: " + JSON.stringify({
    wasm: typeof (globalThis as any).WebAssembly === "object",
    jspi: typeof (WebAssembly as any).Suspending === "function",
  }));

  const cfg = await loadConfig();
  if (cfg?.env || cfg?.apiKey) {
    log("\x1b[2m[boot] config: env/key loaded\x1b[0m");
  } else {
    // No key is fine: fx's own /login (Sign in with Vercel, device code)
    // works on device and the session persists under term/oauth-session.json.
    log("\x1b[2m[boot] no config.json key — use /login inside fx, or add config.json\x1b[0m");
  }

  if (!localTermAvailable()) {
    log("\x1b[31m[boot] local terminal unavailable: wasm missing or JSPI off.\x1b[0m");
    log("Check that fx-term.wasm is in the NRO romfs and the runtime is");
    log("the V8 build; launch hbmenu via title takeover (hold R on a game).");
    // Leave the message on screen briefly, then return to hbmenu.
    await new Promise((r) => setTimeout(r, 6000));
    return;
  }

  // TLS probes — before fx exists. "Sign in with Vercel"/model calls died in
  // the runtime's socket layer, so the probes isolate exactly which request
  // shape kills it (every result lands in fx-embedded.log):
  //   P1 HEAD, no body      — proven baseline (HTTP 200 on every boot so far)
  //   P2 POST + JSON body   — the shape fx uses for model calls; suspect #1
  //   P3 GET + read body    — response-body read over TLS; suspect #2
  // Any HTTP status counts as PASS (DNS+TCP+TLS+HTTP all worked). A hang or
  // crash on P2/P3 = runtime fetch bug, isolated with a one-line repro.
  const probes: [string, () => Promise<any>][] = [
    ["P1 HEAD no-body https://ai-gateway.vercel.sh/",
      () => fetch("https://ai-gateway.vercel.sh/", { method: "HEAD" } as any)],
    ["P2 POST+body /v3/ai/language-model",
      () => fetch("https://ai-gateway.vercel.sh/v3/ai/language-model", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer probe" },
        body: JSON.stringify({ model: "openai/gpt-5-nano", messages: [{ role: "user", content: "ping" }] }),
      } as any)],
    ["P3 GET+read-body https://ai-gateway.vercel.sh/",
      () => fetch("https://ai-gateway.vercel.sh/", { method: "GET" } as any).then((r: any) => r.text())],
  ];
  for (const [label, run] of cfg?.diagnostics?.tlsProbes === true ? probes : []) {
    flog(`[tls] ${label} …`);
    try {
      const res = await Promise.race([
        run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG (15s, no response)")), 15_000)),
      ]);
      const status = (res as any).status ?? `body ${(res as any).length}B`;
      log(`\x1b[2m[tls] ${label.split(" ")[0]} ok (HTTP ${status})\x1b[0m`);
      flog(`[tls] ${label} -> HTTP ${status}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log(`\x1b[33m[tls] ${label} FAILED: ${msg}\x1b[0m`);
      flog(`[tls] ${label} FAILED: ${msg}`);
      // Continue: the failure is now on the record before fx runs.
    }
  }

  const session = new TermSession(termConfigFrom(cfg));
  await session.run();
  session.stop();

  log("\x1b[2mbye\x1b[0m");
}

void main()
  .catch((e: unknown) => {
    log(`\x1b[31mfatal: ${(e as Error).stack ?? e}\x1b[0m`);
  })
  .finally(async () => {
    // Every completion path, including missing config, missing WASM, and a
    // rejected startup promise, must return through nx.js/libnx cleanly.
    // Settle first so in-flight socket/TLS teardown and durable logs finish.
    await new Promise((r) => setTimeout(r, 1200));
    log("[exit] requesting clean Switch.exit");
    try {
      (globalThis as any).Switch?.exit?.();
    } catch { /* stay on screen if exit is unavailable */ }
  });
