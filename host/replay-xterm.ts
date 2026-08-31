/**
 * Replay a captured fx TUI byte stream through @xterm/headless — the SAME
 * ANSI engine the nx.js Console uses on device — and print the resulting
 * buffer (scrollback + viewport) as plain text. This is exactly what the
 * Switch screen would show, minus fonts.
 *
 *   bun host/replay-xterm.ts --in cap.bin [--cols 106] [--rows 27] [--all]
 *
 * IMPORTANT: mirrors nx.js Terminal.write(): lone LF -> CRLF normalization
 * (packages/runtime/src/terminal.ts) after screen.ts stripped CRs from CRLF.
 */

import { readFileSync } from "node:fs";

// Use the exact dependency the device runtime bundles.
// @ts-ignore
import { Terminal } from "/mnt/c/Users/sergi/GitHub/nx.js/packages/runtime/node_modules/@xterm/headless/lib-headless/xterm-headless.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const inFile = arg("in");
if (!inFile) { console.error("--in required"); process.exit(1); }
const cols = Number(arg("cols") ?? 106);
const rows = Number(arg("rows") ?? 27);

const limit = arg("limit") ? Number(arg("limit")) : undefined;
const rawFull = readFileSync(inFile);
const raw = limit ? rawFull.subarray(0, limit) : rawFull;
let text = new TextDecoder().decode(raw);
const rawMode = process.argv.includes("--raw");

// screen.ts write(): map math-alphanumerics, strip CR from CRLF.
text = text.replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => {
  const c = ch.codePointAt(0)!;
  const latin: [number, number][] = [
    [0x1d400, 65], [0x1d41a, 97], [0x1d434, 65], [0x1d44e, 97],
    [0x1d468, 65], [0x1d482, 97],
  ];
  for (const [base0, letter] of latin) {
    if (c >= base0 && c < base0 + 26) return String.fromCharCode(letter + (c - base0));
  }
  return "";
});
if (!rawMode) {
  text = text.replace(/\r\n/g, "\n");
  // nx.js Terminal.write(): lone LF -> CRLF.
  text = text.replace(/\r?\n/g, "\r\n");
}

const term = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });

await new Promise<void>((resolve) => term.write(text, () => resolve()));

const buf = term.buffer.active;
const total = buf.baseY + term.rows;
const from = process.argv.includes("--all") ? 0 : Math.max(0, total - rows * 4);
const lines: string[] = [];
for (let y = from; y < total; y++) {
  const line = buf.getLine(y);
  lines.push(line ? line.translateToString(true) : "");
}
// Trim trailing empties.
while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
console.log(`# buffer: baseY=${buf.baseY} viewport=${term.rows} showing y=${from}..${total}`);
for (const [i, l] of lines.entries()) console.log(String(from + i).padStart(4) + "│" + l);
