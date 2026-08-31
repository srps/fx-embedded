/**
 * Render forensics: boot fx-term.wasm against the REAL gateway, send one
 * scripted prompt, and dump the raw TUI byte stream to a file. The capture is
 * the ground truth for "what did fx actually emit for this model" — replay it
 * with host/replay-xterm.ts to see what the device's xterm/headless shows.
 *
 *   bun host/render-capture.ts --model zai/glm-5.3-flash --out cap-glm.bin \
 *     [--prompt "..."] [--wasm romfs/fx-term.wasm] [--cols 106] [--rows 27]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createFxTermSession, supportsJspi } from "../src/fxwasm/runtime.ts";
import { createSwitchWorkspace, type WorkspaceFs } from "../src/fxwasm/workspace.ts";
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync as rfs, readdirSync,
  renameSync, rmSync, statSync, writeFileSync as wfs,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!supportsJspi()) fail("no JSPI");
const gatewayKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_KEY;
if (!gatewayKey) fail("no gateway key in env");
const model = arg("model") ?? fail("--model required");
const outFile = arg("out") ?? fail("--out required");
const prompt = arg("prompt") ??
  "make a couple of tool calls with some of your response text between them, one at a time: run a terminal command, then say a sentence, then list files, then finish";
const cols = Number(arg("cols") ?? 106);
const rows = Number(arg("rows") ?? 27);

const wasm = new Uint8Array(readFileSync(arg("wasm") ?? "romfs/fx-term.wasm"));

// Real on-disk workspace so terminal/list/read tool calls actually run,
// like the SD card does on device.
const root = mkdtempSync(join(tmpdir(), "fx-render-cap-"));
const toHost = (path: string) => join(root, path.replace(/^sdmc:\/?/, ""));
const fsAdapter: WorkspaceFs = {
  mkdirSync(path) { mkdirSync(toHost(path), { recursive: true }); },
  readDirSync(path) { return readdirSync(toHost(path)); },
  readFileSync(path) { try { return new Uint8Array(rfs(toHost(path))); } catch { return null; } },
  writeFileSync(path, data) {
    const t = toHost(path); mkdirSync(dirname(t), { recursive: true });
    wfs(t, typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  },
  appendFileSync(path, data) {
    const t = toHost(path); mkdirSync(dirname(t), { recursive: true });
    appendFileSync(t, typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  },
  removeSync(path) { rmSync(toHost(path), { recursive: true, force: true }); },
  renameSync(path, dest) { renameSync(toHost(path), toHost(dest)); },
  statSync(path) {
    try { const st = statSync(toHost(path)); return { mode: st.mode, size: st.size }; } catch { return null; }
  },
  commitDeviceSync() {},
};
fsAdapter.mkdirSync("sdmc:/switch/fx-embedded/workspace");
fsAdapter.writeFileSync("sdmc:/switch/fx-embedded/workspace/readme.txt", "capture workspace\n");

let all = new Uint8Array(0);
const sink = (chunk: Uint8Array) => {
  const next = new Uint8Array(all.length + chunk.length);
  next.set(all);
  next.set(chunk, all.length);
  all = next;
};

const configMap = new Map<string, string>();
const events: { type: string; at: number; detail?: any }[] = [];
let lastStreamEvent = 0;
let streamEnds = 0;

const session = await createFxTermSession({
  wasm,
  terminal: { cols, rows },
  env: {
    HOME: "/fx-capture",
    TERM: "xterm-256color",
    AI_GATEWAY_API_KEY: gatewayKey,
    FX_MODEL: model,
    ...(process.env.FX_TRACE ? { FX_TRACE: process.env.FX_TRACE } : {}),
    ...(process.env.FX_TRACE_STDERR ? { FX_TRACE_STDERR: process.env.FX_TRACE_STDERR } : {}),
    ...(process.env.FX_TRACE_SCOPES ? { FX_TRACE_SCOPES: process.env.FX_TRACE_SCOPES } : {}),
  },
  stdout: sink,
  stderr: (chunk) => { try { require("node:fs").appendFileSync(process.env.CAP_STDERR_FILE ?? "/dev/null", chunk); } catch {} },
  stores: {
    config: {
      async get(id) { return configMap.get(id) ?? null; },
      async set(id, value) { configMap.set(id, value); },
    },
    promptHistory: {
      async load() { return []; },
      async append() { return "ok"; },
      async clear() {},
    },
    session: {
      async load() { return null; },
      async commit() { return { revision: "r1" }; },
      async list() { return []; },
      async remove() {},
    },
  },
  workspace: createSwitchWorkspace(fsAdapter),
  onEvent: (type, detail) => {
    events.push({ type, at: Date.now(), detail });
    if (type.startsWith("stream.") || type.startsWith("http.")) {
      lastStreamEvent = Date.now();
      if (type === "stream.end") streamEnds += 1;
      console.error(`[ev] ${type} ${JSON.stringify(detail ?? {}).slice(0, 120)}`);
    }
  },
});

await session.interactive;
console.error(`interactive; sending prompt to ${model}: ${JSON.stringify(prompt)}`);
const markStart = all.length;
for (const ch of prompt) session.write(ch);
await sleep(200);
session.write("\r");
lastStreamEvent = Date.now();

// Wait for the turn to finish: at least one stream.end, then 12 s of
// network quiescence (tool-call turns chain several requests).
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  await sleep(500);
  if (streamEnds > 0 && Date.now() - lastStreamEvent > 20_000) break;
}
console.error(`turn done: ${streamEnds} streams, ${all.length - markStart} bytes rendered after prompt`);

session.interrupt();
await sleep(500);
session.end();
await Promise.race([session.exited, sleep(15_000)]);

writeFileSync(outFile, all);
writeFileSync(`${outFile}.events.json`, JSON.stringify(events, null, 1));
console.error(`wrote ${outFile} (${all.length} bytes) + events`);
process.exit(0);
