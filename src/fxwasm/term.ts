/**
 * TermSession: runs fx-term.wasm — the REAL fx agent harness — entirely on
 * the Switch (V8 WebAssembly + JSPI, no PC involved). The Switch renders the
 * real fx TUI and talks to the AI Gateway over WiFi; the only PC in the
 * loop is `zig build` when fx changes.
 *
 * Boot path:
 *   romfs:/fx-term.wasm                  (bundled in the NRO — canonical)
 *   sdmc:/switch/fx-embedded/fx-term.wasm (hot-swap copy for wasm iteration;
 *                                         wins when present)
 *
 * Input model: see keys.ts. The system keyboard (X) submits whole lines —
 * fx's input box gets the text followed by \r, like a terminal paste+enter.
 *
 * Exit: Minus interrupts the active turn, closes stdin so fx can unwind, and
 * then returns through nx.js/libnx's clean applet teardown.
 */

import { createFxTermSession, supportsJspi, type FxTermSession } from "./runtime.js";
import { createSwitchStores } from "./stores.js";
import { createSwitchWorkspace } from "./workspace.js";
import { encodeKeyEvent, mapGamepad } from "./keys.js";
import { TermScreen } from "./screen.js";
import { flog } from "../flog.js";
import { Button } from "@nx.js/constants";

const ROMFS_WASM = "romfs:/fx-term.wasm";
const SD_WASM = "sdmc:/switch/fx-embedded/fx-term.wasm";

export type TermConfig = {
  /** Env for the module (AI_GATEWAY_API_KEY, FX_MODEL, ...). */
  env?: Record<string, string>;
  /** Let fx resume the latest SD session at boot (config.json `resume: true`). Default: fresh session. */
  resume?: boolean;
};

function readWasmSync(): Uint8Array | null {
  const SW: any = (globalThis as any).Switch;
  if (typeof SW?.readFileSync !== "function") return null;
  for (const path of [SD_WASM, ROMFS_WASM]) {
    try {
      const buf = SW.readFileSync(path);
      if (buf && buf.byteLength > 0) return new Uint8Array(buf);
    } catch { /* try next */ }
  }
  return null;
}

/** True when the terminal can start (wasm present + JSPI). */
export function localTermAvailable(): boolean {
  return supportsJspi() && readWasmSync() !== null;
}

export class TermSession {
  private screen: TermScreen | null = null;
  private session: FxTermSession | null = null;
  private cleanupFns: (() => void)[] = [];
  /** Set by each swkbd mirror write; cleared by the first stdout chunk. */
  private kbEchoProbe = false;
  private kbEchoLogs = 0;

  constructor(private config: TermConfig = {}) {}

  /** Runs until the user exits (Minus) or the module dies. */
  async run(): Promise<void> {
    const screen = new TermScreen();
    this.screen = screen;
    const t0 = Date.now();
    const say = (line: string) => {
      screen.bannerLine(line);
      try { flog(`[term] ${line}`); } catch { /* log optional */ }
    };

    screen.start();
    screen.setStatus("fx embedded — loading");

    if (!supportsJspi()) {
      say("!JSPI missing in this runtime (WebAssembly.Suspending).");
      say("!Update the runtime NRO / check nxjs.ini [v8] flags.");
      await this.waitExit();
      return;
    }
    say("JSPI OK (V8 stack switching)");

    say("reading fx-term.wasm…");
    const wasm = readWasmSync();
    if (!wasm) {
      say("!fx-term.wasm not found:");
      say(`!  ${ROMFS_WASM} (bundled)`);
      say(`!  ${SD_WASM} (hot-swap)`);
      say("!Rebuild: bun run wasm  (or redeploy the NRO)");
      await this.waitExit();
      return;
    }
    say(`+ wasm ${(wasm.byteLength / 1048576).toFixed(1)} MB`);

    let session: FxTermSession;
    try {
      say("compiling…");
      const stores = createSwitchStores();
      if (!this.config.resume) {
        // fx auto-resumes the newest session and re-dispatches an unfinished
        // turn ("resent the previous prompt", device run 2026-08-30). Hide the
        // list at boot; sessions still persist for opt-in resume.
        const session = stores.session;
        stores.session = { ...session, async list() { return []; } };
      }
      session = await createFxTermSession({
        wasm: wasm as any,
        terminal: { cols: screen.cols, rows: screen.rows },
        env: this.config.env ?? {},
        stdout: (chunk) => {
          screen.write(chunk);
          if (this.kbEchoProbe) {
            this.kbEchoProbe = false;
            if (this.kbEchoLogs < 6) {
              this.kbEchoLogs++;
              try { flog(`[kb] fx echoed ${chunk.byteLength ?? chunk.length}B after mirror`); } catch { /* */ }
            }
          }
        },
        stderr: (chunk) => {
          try { flog(`[term:err] ${new TextDecoder().decode(chunk)}`); } catch { /* */ }
        },
        stores,
        workspace: createSwitchWorkspace(),
        onEvent: (type, detail) => {
          if (type === "runtime.crash") say(`!crash: ${String(detail?.error).slice(0, 120)}`);
          // Network breadcrumbs: the last lines in fx-embedded.log name the
          // exact request in flight if the console dies in the TLS/socket
          // path (first exercised by "Sign in with Vercel").
          if (type === "http.request") {
            try { flog(`[net] ${detail?.method} ${detail?.url}`); } catch { /* */ }
          } else if (type === "http.result") {
            try {
              flog(`[net] <- ${detail?.status ?? "ERR"} ${String(detail?.url ?? "").slice(0, 96)}` +
                (detail?.bytes !== undefined ? ` ${detail.bytes}B` : "") +
                (detail?.note ? ` (${detail.note})` : "") +
                (detail?.error ? ` !! ${String(detail.error).slice(0, 120)}` : ""));
            } catch { /* */ }
          }
          if (type === "stdout.error") {
            say("!render error (logged) — see fx-embedded.log");
            try { flog(`[render] stdout side-channel threw: ${String(detail?.error).slice(0, 200)}`); } catch { /* */ }
          }
          if (type === "stream.open") {
            try { flog(`[net] stream open (#${detail?.handle}) status ${detail?.status}`); } catch { /* */ }
            screen.setStreaming(true);
            // Gateway 429/503 are retried inside fx silently; say so on the bar
            // (device runs 2026-08-30 showed 3x503 and 7x429 with no UI hint).
            const st = Number(detail?.status ?? 0);
            if (st >= 400) screen.setStatus(`fx embedded · gateway HTTP ${st} — fx retrying`);
            else if (st > 0) screen.setStatus(`fx embedded · ${screen.cols}x${screen.rows}`);
          }
          if (type === "stream.end") {
            try { flog(`[net] stream end (#${detail?.handle})${detail?.error ? ` !! ${String(detail.error).slice(0, 120)}` : ""}`); } catch { /* */ }
            screen.setStreaming(false);
            // A socket never survives a console sleep (W1, 2026-08-30): the
            // runtime's tlsRead fails after wake and fx reports the turn as a
            // host stream failure. Say why, so "resend" is the obvious move.
            if (detail?.error) {
              const wake = Number((globalThis as any).Switch?.lastWakeAt ?? 0);
              const recent = wake > 0 && Date.now() - wake < 120_000;
              screen.setStatus(recent
                ? "connection lost during sleep — send the prompt again"
                : `fx embedded · stream error: ${String(detail.error).slice(0, 60)}`);
            }
          }
        },
      });
      this.session = session;
      say(`+ compiled in ${Date.now() - t0} ms — starting agent…`);
      await Promise.race([
        session.interactive,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for TUI (60s)")), 60_000)),
      ]);
    } catch (e) {
      say(`!fx-term failed: ${(e as Error).message ?? e}`);
      await this.waitExit();
      return;
    }

    // The TUI is live: it owns the whole canvas now.
    screen.bannerDone();
    screen.setStatus(`fx embedded · ${screen.cols}x${screen.rows}`);

    this.wireInput(screen, session);
    const code = await session.exited;
    this.unwire();
    screen.setStatus(code === 0 || code === 130 ? "fx embedded — exited" : `fx embedded — exit ${code}`);
    // Let the exit status paint for a beat before returning to hbmenu.
    await new Promise((r) => setTimeout(r, 900));
  }

  stop(): void {
    try { this.session?.end(); } catch { /* already gone */ }
    this.unwire();
    this.screen?.stop();
  }

  // ------------------------------------------------------------------ input

  private wireInput(screen: TermScreen, session: FxTermSession): void {
    const vk: any = (globalThis as any).navigator?.virtualKeyboard ?? null;

    // USB / system keyboards: keydown -> terminal bytes.
    let keyLogs = 0;
    const onKeyDown = (e: any) => {
      // USB-keyboard diagnosis (device run 2026-09-01: typing did nothing
      // unless the swkbd was up): breadcrumb the first few raw events so a
      // silent HID path is distinguishable from an encode/consume problem.
      if (keyLogs < 8) {
        keyLogs++;
        try { flog(`[key] keydown code=${e?.keyCode} key=${JSON.stringify(e?.key ?? "")} mod=${e?.modifiers ?? e?.ctrlKey}`); } catch { /* */ }
      }
      const data = encodeKeyEvent(e);
      if (data !== null) {
        e.preventDefault?.();
        session.write(data);
      }
    };
    addEventListener("keydown", onKeyDown);
    try { flog(`[key] keydown listener registered (globalThis===window: ${(globalThis as any) === (globalThis as any).window})`); } catch { /* */ }
    this.cleanupFns.push(() => removeEventListener("keydown", onKeyDown));

    // X opens the system keyboard; its submit becomes a line + \r.
    let vkUp = false;
    // swkbd draft text currently mirrored into fx's own input line. Each
    // change event kills the line (Ctrl+U, fx: delete_to_line_start) and
    // retypes the draft, so fx's real footer renders it live — including
    // "/" command completions. Submit then only has to commit with \r.
    let mirrored = "";
    // Debug breadcrumbs for the mirror path: log the first mirror write and
    // whether fx echoes stdout while the applet is up (device diagnosis).
    let mirrorLogs = 0;
    // The inline swkbd is a touch overlay: its own Send/Cancel taps are ALSO
    // delivered to our screen as touch events. A tap must never reopen the
    // keyboard while it is up or right after it closed (device run 2026-08-30:
    // Send had to be pressed three times because each tap respawned it).
    let vkHiddenAt = 0;
    let firstChangeLogged = false;
    const noteHidden = () => { vkHiddenAt = Date.now(); };
    const openKeyboard = () => {
      if (!vk || vkUp) return;
      if (Date.now() - vkHiddenAt < 700) return;
      try {
        vk.type = 0; // Normal
        vk.okButtonText = "Send";
        // libnx SwkbdInlineCalcArg has a 0x3f4-byte UTF-16 input buffer
        // (506 code units including the terminator). Stay below that boundary.
        vk.maxLength = 500;
        // Seed from fx's real input line: text the host never saw (USB
        // keystrokes, an up-arrow history recall) is invisible to `mirrored`,
        // and a keyboard opened on an empty buffer cannot delete it. The
        // screen read is ground truth; when it returns null (stock runtime,
        // cursor off the prompt row) the last mirror is the best available.
        const onScreen = screen.readInputLine();
        if (onScreen !== null) mirrored = onScreen;
        vk.value = mirrored;
        // K1 v4 on the stock runtime (2026-08-30): after a submit the applet
        // clears its text but keeps the old cursor position, so every later
        // keystroke lands past the end of an empty buffer and is dropped
        // (ChangedString ""). Resetting the cursor before Appear restores
        // input deterministically (strategies C/D); a hide() round-trip
        // alone does not (B).
        try { vk.cursorIndex = mirrored.length; } catch { /* older runtime */ }
        screen.setKeyboardDraft(mirrored);
        vk.show();
        vkUp = true;
        firstChangeLogged = false;
        try { flog(`[kb] show rect h=${vk.boundingRect?.height ?? "?"}`); } catch { /* */ }
        // The rect is assigned synchronously by show(); only a change/submit/
        // cancel event proves the LibraryApplet launched. A crashed system
        // swkbd (Atmosphère report for 0100000000001008) leaves this silent.
        const shownAt = Date.now();
        setTimeout(() => {
          if (vkUp && !firstChangeLogged && Date.now() - shownAt >= 3900) {
            try { flog("[kb] no event 4 s after show — swkbd applet likely dead; reboot the console"); } catch { /* */ }
            screen.setStatus("keyboard applet not responding — reboot console (B to dismiss)");
          }
        }, 4000);
      } catch (e) {
        try { flog(`[kb] show FAILED: ${(e as Error).message ?? e}`); } catch { /* */ }
      }
    };
    if (vk) {
      // After DecidedEnter/DecidedCancel nx.js stops pumping swkbdInlineUpdate
      // and never sends Disappear; libnx keeps the applet session half-open
      // and the NEXT show() reused it — device logs (2026-08-30, stock and
      // fork): first session delivered text, every later one reported empty
      // strings on each keystroke ("submit 0 chars"). Close the session
      // explicitly (the patched runtime flushes Disappear with an Update).
      const closeOut = (why: string) => {
        try { vk.hide(); } catch { /* already gone */ }
        try { flog(`[kb] close-out after ${why}`); } catch { /* */ }
      };
      const onSubmit = () => {
        const value = String(vk.value ?? "");
        vkUp = false;
        noteHidden();
        screen.setInset(0);
        screen.setKeyboardDraft(null);
        try { flog(`[kb] submit ${value.length} chars`); } catch { /* */ }
        closeOut("submit");
        session.write(value ? `\x15${value}\r` : "\x15");
        mirrored = "";
      };
      const onChange = () => {
        if (!firstChangeLogged) {
          firstChangeLogged = true;
          try { flog("[kb] first change event received"); } catch { /* */ }
        }
        const draft = String(vk.value ?? "");
        screen.setKeyboardDraft(draft);
        if (draft !== mirrored) {
          session.write(`\x15${draft}`);
          mirrored = draft;
          this.kbEchoProbe = true;
          if (mirrorLogs < 6) {
            mirrorLogs++;
            try { flog(`[kb] mirror ${draft.length}ch -> fx stdin`); } catch { /* */ }
          }
        }
      };
      const onCancel = () => {
        vkUp = false;
        noteHidden();
        screen.setInset(0);
        screen.setKeyboardDraft(null);
        try { flog(`[kb] cancel (draft ${mirrored.length}ch kept in fx line)`); } catch { /* */ }
        closeOut("cancel");
      };
      const onGeom = () => {
        const h = vk.boundingRect?.height ?? 0;
        try { flog(`[kb] geometry h=${h}`); } catch { /* */ }
        screen.setInset(h > 0 ? h : 0);
        if (h <= 0) {
          if (vkUp) noteHidden();
          vkUp = false;
          screen.setKeyboardDraft(null);
        }
      };
      vk.addEventListener("submit", onSubmit);
      vk.addEventListener("change", onChange);
      vk.addEventListener("cancel", onCancel);
      vk.addEventListener("geometrychange", onGeom);
      this.cleanupFns.push(() => {
        vk.removeEventListener?.("submit", onSubmit);
        vk.removeEventListener?.("change", onChange);
        vk.removeEventListener?.("cancel", onCancel);
        vk.removeEventListener?.("geometrychange", onGeom);
        // Do not return to hbmenu while the inline LibraryApplet is still
        // visible or transitioning. The patched runtime flushes hide() with
        // swkbdInlineUpdate() before native teardown continues.
        if (vkUp) {
          try { vk.hide(); } catch { /* best-effort shutdown */ }
        }
        vkUp = false;
      });
    }

    // Joy-Con: polled edges (same pattern the nx.js examples use).
    let lastPressed = new Set<number>();
    let pollActive = true;
    let exitRequested = false;
    let wasmExited = false;
    void session.exited.then(() => { wasmExited = true; });
    const requestExit = () => {
      if (exitRequested) return;
      exitRequested = true;
      try { flog(`[exit] requested (wasmExited=${wasmExited}, vkUp=${vkUp})`); } catch { /* */ }
      screen.setStatus("exiting fx… (up to 3 s while a request is in flight)");
      pollActive = false;
      try { session.interrupt(); } catch { /* already stopping */ }
      try { session.end(); } catch { /* already stopped */ }
      // EOF is the normal path. Keep a bounded fallback for a module stuck in
      // non-input work so the user can still return to hbmenu.
      setTimeout(() => {
        if (!wasmExited) {
          try { flog("[exit] wasm did not exit on EOF in 3 s — aborting"); } catch { /* */ }
          try { session.abort(); } catch { /* already stopped */ }
        }
      }, 3000);
    };
    // Escape hatch (fx-switch lesson): once an exit is pending, a second
    // Minus or a Plus must never be swallowed — let the runtime hard-exit.
    const exitPending = () => exitRequested && !wasmExited;
    // `+` reaches us as the runtime's beforeunload. While the inline keyboard
    // is up it means Send (the runtime's own keyboard listener already asks to
    // prevent the exit; we used to override that by tearing fx down anyway).
    // Otherwise it is an exit request — but a CLEAN one through requestExit
    // (stdin EOF → wasm exit → Switch.exit, 3 s abort fallback), never the
    // runtime's hard exit that skips socket/keyboard teardown.
    const onBeforeUnload = (e: any) => {
      if (exitPending()) {
        try { flog("[exit] plus during pending exit — runtime hard exit"); } catch { /* */ }
        return; // no preventDefault: the runtime exits the process
      }
      try { e?.preventDefault?.(); } catch { /* */ }
      if (vkUp && vk) {
        const value = String(vk.value ?? "");
        try { flog(`[kb] plus-send ${value.length} chars`); } catch { /* */ }
        vkUp = false;
        noteHidden();
        try { vk.hide(); } catch { /* already gone */ }
        screen.setInset(0);
        screen.setKeyboardDraft(null);
        session.write(value ? `\x15${value}\r` : "\x15");
        mirrored = "";
        return;
      }
      requestExit();
    };
    addEventListener("beforeunload", onBeforeUnload);
    this.cleanupFns.push(() => removeEventListener("beforeunload", onBeforeUnload));
    const poll = () => {
      if (!pollActive) return;
      try {
        const gp = (globalThis as any).navigator?.getGamepads?.()?.[0];
        if (gp) {
          const now = new Set<number>();
          const edges: number[] = [];
          for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) now.add(i);
          }
          for (const i of now) if (!lastPressed.has(i)) edges.push(i);
          lastPressed = now;
          for (const i of edges) {
            const action = mapGamepad(i);
            if (!action) continue;
            // While the inline applet is up it owns the controller: the same
            // press is ALSO delivered here (like the Send-tap touches), so A
            // while typing would inject \r into fx's now-mirrored line and
            // send a partial prompt. Only Minus (exit) stays live.
            if (vkUp && action.kind !== "exit") continue;
            if (action.kind === "bytes") session.write(action.data);
            else if (action.kind === "scroll") screen.scroll(action.rows);
            else if (action.kind === "keyboard") openKeyboard();
            else if (action.kind === "exit") {
              if (exitPending()) {
                try { flog("[exit] second Minus — forcing Switch.exit"); } catch { /* */ }
                try { (globalThis as any).Switch?.exit?.(); } catch { /* */ }
              } else requestExit();
            }
          }
        }
      } catch { /* gamepad optional */ }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
    this.cleanupFns.push(() => { pollActive = false; });

    // Touch scrolling of the scrollback; a tap opens the keyboard.
    // Device data (2026-08-30): a stationary finger tap reports 4–14 px of
    // y jitter across several touchmove events, so a 10 px cumulative budget
    // rejected real taps ("tap-open does nothing"). Tap = never left a 40 px
    // radius; scrolling starts only after 24 px of displacement from start.
    let lastY = -1;
    let startY = -1;
    let moved = 0;
    let scrolling = false;
    let touchStartedWithKb = false;
    const onTouchStart = (e: any) => {
      const t = e.touches?.[0];
      if (!t) { try { flog("[touch] start without touches[0]"); } catch { /* */ } return; }
      lastY = startY = t.screenY ?? t.clientY ?? 0;
      moved = 0;
      scrolling = false;
      touchStartedWithKb = vkUp;
    };
    const onTouchMove = (e: any) => {
      const t = e.touches?.[0];
      if (!t || lastY < 0) return;
      const y = t.screenY ?? t.clientY ?? 0;
      const dy = y - lastY;
      lastY = y;
      moved = Math.max(moved, Math.abs(y - startY));
      if (!scrolling && moved >= 24) scrolling = true;
      if (scrolling && Math.abs(dy) >= 12) screen.scroll(dy > 0 ? -3 : 3);
    };
    let touchLogged = 0;
    const onTouchEnd = (e: any) => {
      // A tap that began while the keyboard was up belongs to the keyboard
      // (Send/Cancel/keys), never to us.
      const t = e.changedTouches?.[0];
      const isTap = lastY >= 0 && !scrolling && moved < 40 && !!t;
      const verdict = !isTap ? "not-a-tap" : touchStartedWithKb ? "kb-owned" : vkUp ? "kb-up" :
        Date.now() - vkHiddenAt < 700 ? "just-hidden" : "open";
      if (touchLogged++ < 40) {
        try { flog(`[touch] end x=${t?.screenX ?? "?"} y=${t?.screenY ?? "?"} moved=${moved.toFixed(0)} lastY=${lastY} -> ${verdict}`); } catch { /* */ }
      }
      if (verdict === "open") openKeyboard();
      lastY = -1;
      touchStartedWithKb = false;
    };
    const scr = (globalThis as any).screen;
    scr.addEventListener("touchstart", onTouchStart);
    scr.addEventListener("touchmove", onTouchMove);
    scr.addEventListener("touchend", onTouchEnd);
    this.cleanupFns.push(() => {
      scr.removeEventListener?.("touchstart", onTouchStart);
      scr.removeEventListener?.("touchmove", onTouchMove);
      scr.removeEventListener?.("touchend", onTouchEnd);
    });
  }

  private unwire(): void {
    for (const fn of this.cleanupFns.splice(0)) {
      try { fn(); } catch { /* best effort */ }
    }
    this.screen?.setInset(0);
    this.screen?.setKeyboardDraft(null);
  }

  private async waitExit(): Promise<void> {
    // Fatal-path wait: any gamepad edge (B) or key dismisses.
    this.screen?.setStatus("fx embedded — press B / any key");
    await new Promise<void>((resolve) => {
      const onKey = () => done();
      const done = () => {
        removeEventListener("keydown", onKey);
        clearInterval(timer);
        resolve();
      };
      const timer = setInterval(() => {
        const gp = (globalThis as any).navigator?.getGamepads?.()?.[0];
        if (!gp) return;
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i].pressed && i !== Button.ZL && i !== Button.ZR) return done();
        }
      }, 100);
      addEventListener("keydown", onKey);
      this.cleanupFns.push(() => done());
    });
  }
}

/** Config additions for the terminal (env: API key etc.). */
export function termConfigFrom(cfg: any): TermConfig {
  const env: Record<string, string> = {};
  const raw = cfg?.env ?? {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v) env[k] = v;
  }
  if (typeof cfg?.apiKey === "string" && cfg.apiKey && !env.AI_GATEWAY_API_KEY) {
    env.AI_GATEWAY_API_KEY = cfg.apiKey;
  }
  return { env, resume: cfg?.resume === true };
}
