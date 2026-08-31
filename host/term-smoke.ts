/**
 * Host-side smoke test for the embedded fx terminal — no Switch required.
 *
 * Drives fx-term.wasm through the EXACT host layer the Switch app uses
 * (src/fxwasm/runtime.ts) under Bun/V8 JSPI. Memory stores stand in for the
 * SD card. What this proves
 * before touching hardware:
 *
 *   - the wasm compiles and links against our import object (name-for-name)
 *   - the TUI boots and reaches its first input poll (`interactive`)
 *   - fx's terminal probes (OSC 11 + DA1 fence, DECRQM 996) are answered
 *   - keyboard bytes flow through fd_read and change what fx renders
 *   - EOF (end()) shuts the module down gracefully
 *
 * With AI_GATEWAY_API_KEY in the env it also sends a real prompt and expects
 * streamed model output through fx_http_stream_* — the full "agent running
 * in the terminal" path, on the PC.
 *
 *   bun host/term-smoke.ts [--wasm romfs/fx-term.wasm] [--out file]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createFxTermSession, supportsJspi } from "../src/fxwasm/runtime.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gatewayKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_KEY;
const gatewayModel = process.env.FX_MODEL ?? process.env.VERCEL_AI_GATEWAY_MODEL;

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!supportsJspi()) {
  fail("this runtime lacks JSPI (use Bun 1.4 or Node 26)");
}
console.log(`Bun ${(globalThis as any).Bun?.version ?? "unknown"} / V8 ${process.version} — JSPI OK`);

const wasmPath = arg("wasm") ?? "romfs/fx-term.wasm";
let wasm: Uint8Array;
try {
  wasm = new Uint8Array(readFileSync(wasmPath));
} catch {
  fail(`wasm not found at ${wasmPath} — run: bun run wasm`);
}

// ---- memory stores (the SD card's stand-in) --------------------------------

const configMap = new Map<string, string>();
const history: string[] = [];
const sessions = new Map<string, { bytes: Uint8Array; revision: string }>();
let sessionRev = 0;

// ---- capture output ---------------------------------------------------------

const outFile = arg("out");
let all = new Uint8Array(0);
let frames = 0;
const sink = (chunk: Uint8Array) => {
  const next = new Uint8Array(all.length + chunk.length);
  next.set(all);
  next.set(chunk, all.length);
  all = next;
  frames += 1;
  if (process.stdout.isTTY && !outFile) process.stdout.write(chunk); // live view
};
const errors: string[] = [];
const events: { type: string; detail?: any }[] = [];

// ---- run --------------------------------------------------------------------

const t0 = Date.now();
const session = await createFxTermSession({
  wasm,
  terminal: { cols: 106, rows: 28 },
  traceWasi: process.argv.includes("--trace"),
  env: {
    HOME: "/fx-smoke",
    TERM: "xterm-256color",
    ...(gatewayKey ? { AI_GATEWAY_API_KEY: gatewayKey } : {}),
    ...(gatewayModel ? { FX_MODEL: gatewayModel } : {}),
  },
  stdout: sink,
  stderr: (chunk) => errors.push(new TextDecoder().decode(chunk)),
  stores: {
    config: {
      async get(id) { return configMap.get(id) ?? null; },
      async set(id, value) { configMap.set(id, value); },
    },
    promptHistory: {
      async load(_ws, limit) { return history.slice(-limit); },
      async append(_ws, value) {
        if (history[history.length - 1] === value) return "duplicate";
        history.push(value);
        return "ok";
      },
      async clear() { history.length = 0; },
    },
    session: {
      async load(id) { return sessions.get(id) ?? null; },
      async commit(id, bytes, expected) {
        const cur = sessions.get(id);
        if (cur && expected !== undefined && cur.revision !== expected) {
          const error: any = new Error("session revision conflict");
          error.code = "FX_SESSION_REVISION_CONFLICT";
          throw error;
        }
        const revision = `r${++sessionRev}`;
        sessions.set(id, { bytes: bytes.slice(), revision });
        return { revision };
      },
      async list() {
        return [...sessions.entries()].map(([id, s]) => ({
          id,
          updatedAtMs: Number(s.revision.slice(1)),
        }));
      },
      async remove(id) { sessions.delete(id); },
    },
  },
  onEvent: (type, detail) => events.push({ type, detail }),
});

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

await timeout(session.interactive, 60_000, "TUI never reached its first input poll")
  .catch((e) => {
    // Deadlock forensics: what did the module actually produce?
    console.error(`bytes=${all.length} chunks=${frames} events=${JSON.stringify(events.slice(0, 20))}`);
    const tail = all.subarray(Math.max(0, all.length - 128));
    console.error("stdout tail:", JSON.stringify(new TextDecoder().decode(tail)));
    throw e;
  });
const bootMs = Date.now() - t0;
console.log(`interactive after ${bootMs} ms — ${frames} stdout chunks, ${all.length} bytes`);

// ---- exercise the input path --------------------------------------------------

const sizeBefore = all.length;
for (const ch of "hello from the switch smoke test") session.write(ch);
await sleep(300);
session.write("\r");
if (gatewayKey) {
  // Input echo and spinner repaint are not model output. Require a successful
  // stream open, actual response bytes copied into wasm, and stream end.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !events.some((event) => event.type === "stream.end")) await sleep(250);
  const opened = events.find((event) => event.type === "stream.open");
  const streamedBytes = events
    .filter((event) => event.type === "stream.data")
    .reduce((total, event) => total + Number(event.detail?.bytes ?? 0), 0);
  const ended = events.some((event) => event.type === "stream.end");
  const streamed = Number(opened?.detail?.status) === 200 && streamedBytes > 0 && ended;
  console.log(
    ` ${streamed ? "PASS" : "FAIL"}  completed HTTP 200 model stream ` +
      `(${streamedBytes} transport bytes, ${all.length - sizeBefore} rendered bytes)`,
  );
  if (!streamed) {
    const streamEvents = events.filter((event) => event.type.startsWith("stream."));
    console.log(` stream diagnostics: ${JSON.stringify(streamEvents)}`);
    const visibleTail = new TextDecoder().decode(all)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
      .slice(-800);
    console.log(` rendered tail: ${JSON.stringify(visibleTail)}`);
    process.exitCode = 1;
  }
} else {
  await sleep(1200);
  console.log(` PASS  input bytes accepted (${all.length - sizeBefore} bytes rendered after typing)`);
}

// ---- verify the rendered stream ---------------------------------------------

const text = new TextDecoder().decode(all);
const checks: [string, boolean][] = [
  ["kitty keyboard push (>1u)", text.includes("\x1b[>1u")],
  ["bracketed paste on (?2004h)", text.includes("\x1b[?2004h")],
  ["synchronized output (?2026h)", text.includes("\x1b[?2026h")],
  ["color-scheme query seen (996n)", text.includes("\x1b[?996n")],
  ["full-screen frame repaint (CUP+EL)", /\x1b\[\d+;1H\x1b\[2K/.test(text)],
  ["title set (OSC 2: fx · …)", text.includes("\x1b]2;fx ")],
  ["banner rendered (v… + /help hint)", /v\d+\.\d+\.\d+/.test(text) && text.includes("Run /help for commands")],
  ["typed text echoed in input box", text.includes("hello from the switch smoke test")],
];
const replies = events.filter((e) => e.type === "query.replied");
checks.push(["terminal probes answered on stdin", replies.length >= 1]);
for (const [what, ok] of checks) {
  console.log(` ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
}

// Ctrl-C interrupt, then graceful EOF exit.
session.interrupt();
await sleep(800);
session.end();
const code = await timeout(session.exited, 30_000, "module did not exit after EOF");
console.log(`exit code ${code} in ${Date.now() - t0} ms total`);

if (outFile) {
  writeFileSync(outFile, all);
  console.log(`raw TUI stream written to ${outFile} (${all.length} bytes)`);
}
if (errors.length) {
  console.log(`stderr: ${errors.join("").slice(0, 400)}`);
}
const crash = events.find((e) => e.type === "runtime.crash");
if (crash) {
  console.log(`FAIL  runtime crash: ${crash.detail?.error}`);
  process.exitCode = 1;
}
console.log(process.exitCode ? "term-smoke: FAILED" : "term-smoke: OK");
