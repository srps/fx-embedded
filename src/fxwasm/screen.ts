/**
 * TermScreen: full-screen renderer for the embedded fx terminal.
 *
 * Owns an isolated nx.js Console (the runtime's canvas-backed headless
 * xterm.js — real ANSI state machine with scrollback) and composites it onto
 * the screen every frame it is dirty, with a slim status bar. While this
 * loop runs it owns the framebuffer; the runtime's own console-present is
 * suspended the moment we take `screen.getContext('2d')`.
 *
 * Geometry must match the runtime Terminal's internal math exactly
 * (packages/runtime/src/terminal.ts): charWidth = round(measureText('M')),
 * lineHeight = ceil(fontSize * 1.25), cols/rows = floor(size/cell). We
 * compute the same values here to report a truthful size to fx_term_size.
 */

import { GAMEPAD_HELP } from "./keys.js";
import { flog } from "../flog.js";

const FONT_SIZE = 20;
const BAR_H = 40;

type Theme = Record<string, string>;

const TERM_THEME: Theme = {
  background: "#0b0f14",
  foreground: "#e2e8f0",
  cursor: "#4ade80",
  black: "#0b0f14",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#93c5fd",
  magenta: "#f0abfc",
  cyan: "#67e8f9",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightWhite: "#f8fafc",
};

export class TermScreen {
  readonly console: any;
  readonly cols: number;
  readonly rows: number;
  private ctx: any;
  private w: number;
  private h: number;
  private running = false;
  private dirty = true;
  /** Transient boot banner lines (cleared once the TUI takes over). */
  private banner: string[] = [];
  private status = "fx embedded";
  /** Native keyboard inset — shifts the terminal up so the input stays visible. */
  private inset = 0;
  /** Draft mirrored from the inline keyboard, which does not draw an input box. */
  private keyboardDraft: string | null = null;
  /** Set when console.print throws — keeps the failure visible without killing the loop. */
  private renderFailed = false;
  /** Model streaming indicator (set from stream lifecycle events). */
  private streaming = false;
  private streamPhase = 0;
  private frames = 0;
  /** Terminal line height in px (same rounding as the runtime Terminal). */
  private rowPx = Math.ceil(FONT_SIZE * 1.25);
  /**
   * Underlying xterm instance (fork runtime's Console#terminal). fx anchors
   * its transcript at the TOP, so the input line's row varies with session
   * depth — the keyboard viewport must follow the cursor, not assume the
   * prompt sits at the canvas bottom. null on runtimes without the getter.
   */
  private xterm: any = null;

  constructor() {
    const screen = (globalThis as any).screen;
    this.ctx = screen.getContext("2d");
    this.w = screen.width;
    this.h = screen.height;

    const ConsoleCtor = (globalThis as any).Console;
    this.console = new ConsoleCtor({
      height: this.h - BAR_H,
      width: this.w,
      fontSize: FONT_SIZE,
      scrollback: 3000,
      cursorStyle: "bar",
      theme: TERM_THEME,
    });

    // Mirror the runtime Terminal's geometry math (same font string, same
    // measure, same rounding) so cols/rows are exactly the terminal's.
    let charWidth = 0;
    try {
      this.ctx.font = `${FONT_SIZE}px "Geist Mono"`;
      charWidth = this.ctx.measureText("M").width;
    } catch { /* fall through */ }
    if (!charWidth || !isFinite(charWidth)) charWidth = FONT_SIZE * 0.6;
    const cw = Math.max(1, Math.round(charWidth));
    const lh = Math.max(1, Math.ceil(FONT_SIZE * 1.25));
    this.cols = Math.max(1, Math.floor(this.w / cw));
    this.rows = Math.max(1, Math.floor((this.h - BAR_H) / lh));
    // Device diagnosis (swkbd mirror): the inset math assumes the console
    // canvas is (h - BAR_H) tall with the last row at its bottom edge. Log
    // the real geometry once so a wrong assumption is visible in the log.
    try {
      const c = this.console.canvas;
      flog(`[scr] canvas ${c?.width}x${c?.height} screen ${this.w}x${this.h} rows=${this.rows} lh=${lh} rowPx=${this.rowPx}`);
    } catch { /* */ }
    try {
      this.xterm = (this.console as any).terminal?.terminal ?? null;
      flog(`[scr] cursor tracking ${this.xterm ? "on (Console#terminal)" : "OFF — stock runtime, blind inset"}`);
    } catch { this.xterm = null; }
  }

  /** Raw TUI bytes from the wasm module. */
  write(data: Uint8Array | string): void {
    let text = typeof data === "string" ? data : new TextDecoder().decode(data);
    // Mathematical Alphanumeric Symbols (U+1D400-1D7FF): fx's wordmark (𝒇 =
    // U+1D487) and any math in model replies are tofu on device — Geist Mono
    // lacks the whole block, and the runtime can't fall back to system fonts.
    // Map the four clean latin ranges to ASCII; strip the exotic rest.
    text = text.replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => {
      const c = (ch as any).codePointAt(0)!;
      const latin: [number, number][] = [
        [0x1d400, 65], [0x1d41a, 97], [0x1d434, 65], [0x1d44e, 97],
        [0x1d468, 65], [0x1d482, 97],
      ];
      for (const [base0, letter] of latin) {
        if (c >= base0 && c < base0 + 26) return String.fromCharCode(letter + (c - base0));
      }
      return "";
    });
    // The runtime's Terminal.write normalizes \n -> \r\n, which is exactly
    // what a TUI that emits CRLF wants; strip CRs so CRLF stays CRLF and the
    // normalization is an identity transform.
    // NEVER let an exception escape into the wasm import callback: V8 dies
    // formatting the error (CallPrinter -> parser -> OS::Abort — see the
    // 2345-0008 crash report). Log to SD and keep the terminal alive.
    try {
      this.console.print(text.replace(/\r\n/g, "\n"));
    } catch (e) {
      try {
        flog(`[render] console.print FAILED: ${(e as Error).message ?? e} ` +
          `(chunk ${text.length}B: ${JSON.stringify(text.slice(0, 80))})`);
      } catch { /* */ }
      this.renderFailed = true;
    }
    this.dirty = true;
  }

  bannerLine(line: string): void {
    this.banner.push(line);
    this.dirty = true;
  }

  bannerDone(): void {
    this.banner = [];
    this.dirty = true;
  }

  setStatus(text: string): void {
    if (text === this.status) return;
    this.status = text;
    this.dirty = true;
  }

  /** Model streaming state: animates the status bar until cleared. */
  setStreaming(v: boolean): void {
    if (v === this.streaming) return;
    this.streaming = v;
    this.streamPhase = 0;
    this.dirty = true;
  }

  setInset(px: number): void {
    // The inline swkbd LibraryApplet is ~450 px tall on a 720 px screen and is
    // composited ABOVE our frame. The old h/2 (360 px) clamp placed the draft
    // bar underneath it — "can't see anything while typing". Allow any inset
    // that still leaves a few terminal rows visible above the bar.
    const v = Math.max(0, Math.min(this.h - BAR_H - 3 * this.rowPx, px | 0));
    if (v === this.inset) return;
    this.inset = v;
    this.dirty = true;
  }

  setKeyboardDraft(text: string | null): void {
    if (text === this.keyboardDraft) return;
    this.keyboardDraft = text;
    this.dirty = true;
  }

  scroll(rows: number): void {
    if (rows < 0) this.console.scrollUp?.(-rows);
    else this.console.scrollDown?.(rows);
    this.dirty = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    let lastFrameAt = Date.now();
    const loop = () => {
      if (!this.running) return;
      this.frames++;
      // Main-thread stall detector (JS side): the runtime's wake heuristic is
      // wall-clock based, so anything that blocks this thread for seconds
      // (synchronous WASM work, big renders) looks like a sleep to it.
      const now = Date.now();
      if (now - lastFrameAt >= 2000) {
        try { flog(`[stall] ${((now - lastFrameAt) / 1000).toFixed(1)}s between frames`); } catch { /* */ }
      }
      lastFrameAt = now;
      if (this.streaming && this.frames % 21 === 0) {
        // ~175 ms at 60 fps: cycle the streaming dots without a busy repaint.
        this.streamPhase = (this.streamPhase + 1) % 4;
        this.dirty = true;
      }
      if (this.dirty) {
        this.dirty = false;
        // The frame loop must survive ANY render error — a dead loop means a
        // frozen screen while input keeps flowing invisibly (observed as
        // "typed but nothing rendered"). Catch, log, keep going.
        try {
          this.render();
        } catch (e) {
          try {
            flog(`[render] frame FAILED: ${(e as Error).message ?? e}`);
          } catch { /* */ }
          this.renderFailed = true;
        }
        if (this.renderFailed) {
          this.renderFailed = false;
          try {
            const ctx = this.ctx;
            ctx.fillStyle = "#0b0f14";
            ctx.fillRect(0, 0, this.w, this.h);
            ctx.fillStyle = "#f87171";
            ctx.font = '22px "Geist Mono", monospace';
            ctx.fillText("render error — see fx-embedded.log", 14, 14);
          } catch { /* nothing left to try */ }
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, this.w, this.h);
    // Keyboard viewport: put the input line (cursor row) at the top of the
    // strip left visible above the applet, so the prompt AND the slash-menu
    // fx draws below it stay on screen. Deep sessions clamp to the plain
    // inset (cursor near the canvas bottom already). Assumes an unscrolled
    // viewport — the Terminal draws its cursor at cursorY*lh the same way.
    let offset = this.inset;
    if (this.inset > 0 && this.xterm) {
      try {
        const cur = this.xterm.buffer.active.cursorY * this.rowPx;
        offset = Math.max(0, Math.min(cur, this.inset));
      } catch { /* blind inset */ }
    }
    // Reading .canvas renders pending output first (runtime contract).
    ctx.drawImage(this.console.canvas, 0, -offset);

    if (this.banner.length > 0) this.drawBanner(ctx);
    this.drawBar(ctx);
  }

  private drawBanner(ctx: any): void {
    const boxW = Math.min(this.w - 80, 760);
    const lineH = 30;
    const boxH = 36 + this.banner.length * lineH + 20;
    const x = (this.w - boxW) / 2;
    const y = (this.h - boxH) / 3;
    ctx.fillStyle = "rgba(6, 10, 16, 0.96)";
    ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, boxW, boxH);
    ctx.textBaseline = "top";
    ctx.font = '20px "Geist Mono", monospace';
    let ty = y + 18;
    for (const line of this.banner) {
      ctx.fillStyle = line.startsWith("!") ? "#fbbf24" : line.startsWith("+") ? "#4ade80" : "#94a3b8";
      ctx.fillText(line.replace(/^[!+\s]+/, ""), x + 24, ty);
      ty += lineH;
    }
  }

  private drawBar(ctx: any): void {
    // The LibraryApplet overlays the bottom `inset` pixels. Keep the bar in
    // the remaining visible area; adding the inset placed it below the screen.
    const by = this.h - this.inset - BAR_H;
    ctx.fillStyle = "#10161d";
    ctx.fillRect(0, by, this.w, BAR_H);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, by, this.w, 2);
    ctx.textBaseline = "top";
    ctx.font = '17px "Geist Mono", monospace';
    if (this.keyboardDraft !== null) {
      ctx.fillStyle = "#e2e8f0";
      const draft = this.keyboardDraft || "type a prompt…";
      ctx.fillText(`> ${draft.slice(-108)}`, 14, by + 3);
    } else if (this.streaming) {
      const dots = ".".repeat(1 + (this.streamPhase % 3));
      ctx.fillStyle = "#67e8f9";
      ctx.fillText(`${this.status} — streaming${dots}`, 14, by + 3);
    } else {
      ctx.fillStyle = "#4ade80";
      ctx.fillText(this.status, 14, by + 3);
    }
    ctx.fillStyle = "#64748b";
    ctx.font = '15px "Geist Mono", monospace';
    ctx.fillText(this.keyboardDraft !== null ? "Send or + submits · B cancels" : GAMEPAD_HELP, 14, by + 22);
  }
}
