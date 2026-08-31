/**
 * Key → terminal byte encoders for the embedded fx terminal.
 *
 * Two input sources feed fx-term.wasm's stdin:
 *   - USB/system keyboards: keydown events encoded CSI-style (the same map
 *     a real terminal emulator would produce; mirrors fx sdk's
 *     encodeXtermKeyEvent, extended with the control keys the TUI uses)
 *   - Joy-Con buttons: a fixed map (see mapGamepad) — A submit, B escape,
 *     Y interrupt, X opens the system keyboard, d-pad arrows.
 */

import { Button } from "@nx.js/constants";

const CSI = "\x1b[";

/** keydown event -> input bytes, or null when the key produces nothing. */
export function encodeKeyEvent(e: any): string | null {
  const key: string = e.key ?? "";

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (key.length === 1) {
      const c = key.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
    }
    return null;
  }
  if (e.metaKey || e.altKey) {
    // ESC-prefixed variant for the keys that matter; else let it through.
    if (key.length === 1) return `\x1b${key}`;
    const arrow = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D" }[key];
    if (arrow) {
      const mods = (e.metaKey ? 8 : 2) + (e.shiftKey ? 1 : 0) + 1;
      return `${CSI}1;${mods}${arrow}`;
    }
    if (key === "Backspace") return `${CSI}127;${(e.metaKey ? 8 : 2) + 1}u`;
    return null;
  }

  switch (key) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return e.shiftKey ? `${CSI}Z` : "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return `${CSI}A`;
    case "ArrowDown": return `${CSI}B`;
    case "ArrowRight": return `${CSI}C`;
    case "ArrowLeft": return `${CSI}D`;
    case "Home": return `${CSI}H`;
    case "End": return `${CSI}F`;
    case "PageUp": return `${CSI}5~`;
    case "PageDown": return `${CSI}6~`;
    case "Delete": return `${CSI}3~`;
    case "Insert": return `${CSI}2~`;
    default: break;
  }
  if (key.length === 1) return key;
  return null;
}

/** What a Joy-Con button edge means inside the fx terminal. */
export type GamepadAction =
  | { kind: "bytes"; data: string }
  | { kind: "scroll"; rows: number }
  | { kind: "keyboard" }
  | { kind: "exit" };

export function mapGamepad(button: number): GamepadAction | null {
  switch (button) {
    case Button.A: return { kind: "bytes", data: "\r" };
    case Button.B: return { kind: "bytes", data: "\x1b" };
    case Button.Y: return { kind: "bytes", data: "\x03" }; // Ctrl-C: interrupt
    case Button.X: return { kind: "keyboard" };
    case Button.Up: return { kind: "bytes", data: `${CSI}A` };
    case Button.Down: return { kind: "bytes", data: `${CSI}B` };
    case Button.Right: return { kind: "bytes", data: `${CSI}C` };
    case Button.Left: return { kind: "bytes", data: `${CSI}D` };
    case Button.L: return { kind: "bytes", data: `${CSI}5~` }; // PageUp
    case Button.R: return { kind: "bytes", data: `${CSI}6~` }; // PageDown
    case Button.StickL: return { kind: "bytes", data: "\t" };
    case Button.StickR: return { kind: "bytes", data: `${CSI}Z` }; // Shift-Tab
    case Button.ZL: return { kind: "scroll", rows: -8 };
    case Button.ZR: return { kind: "scroll", rows: 8 };
    case Button.Minus: return { kind: "exit" };
    default: return null;
  }
}

/** One line for the status bar — keep in sync with mapGamepad. */
export const GAMEPAD_HELP =
  "A enter · B esc · X keyboard · Y ctrl-c · d-pad move · L/R pgup/dn · ZL/ZR scroll · - exit";
