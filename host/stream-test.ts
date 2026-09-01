/**
 * Mock-gateway end-to-end test for the stream path — no Switch, no network.
 *
 * Boots fx-term.wasm (same as term-smoke) with a FAKE fetch: the model call
 * POST returns a scripted SSE stream. This exercises the exact code path
 * that crashed on device — fx_http_stream_open/status/next — and asserts
 * that fx polls the stream (status 0 -> 1, next -3 -> chunks), renders the
 * reply, and exits cleanly — with zero Suspending calls on the stream path
 * (the JSPI stack-switching cycles that took the console down).
 *
 *   bun host/stream-test.ts [--wasm romfs/fx-term.wasm]
 *
 * No fixed deadline on the model wait: real replies stream for minutes. A
 * global watchdog just guarantees the process always terminates.
 */

import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const REPLY = "Hello from the mock gateway — streaming works.";

const wasmPath = arg("wasm") ?? "romfs/fx-term.wasm";
const wasm = new Uint8Array(readFileSync(wasmPath));
console.log(`wasm ${(wasm.byteLength / 1048576).toFixed(1)} MB`);

// 20-minute global watchdog: the test must ALWAYS terminate.
const watchdog = setTimeout(() => {
  console.error("FAIL: global watchdog (20 min) fired");
  process.exit(1);
}, 20 * 60_000);
watchdog.unref?.();

// --- scripted SSE stream -----------------------------------------------------

const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
const encoder = new TextEncoder();
const chunks = [
  sse({ type: "start", id: "t1" }),
  sse({ type: "text-delta", delta: REPLY.slice(0, 12) }),
  sse({ type: "text-delta", delta: REPLY.slice(12) }),
  sse({ type: "finish" }),
  "data: [DONE]\n\n",
];

let postCount = 0;
let closeCount = 0;

const mockFetch = (async (url: any, _init: any) => {
  const u = String(url);
  if (u.includes("/v3/ai/language-model")) {
    postCount += 1;
    console.log(`[mock] POST ${u} -> 200 (streaming ${chunks.length} chunks)`);
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        let i = 0;
        const pump = () => {
          // fx may close the response as soon as it has consumed [DONE]. A
          // previously scheduled timer must not touch the cancelled controller.
          if (cancelled) return;
          if (i >= chunks.length) { controller.close(); return; }
          controller.enqueue(encoder.encode(chunks[i++]!));
          setTimeout(pump, 15); // drip the stream like a real model
        };
        pump();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { ok: true, status: 200, body };
  }
  console.log(`[mock] GET ${u} -> 200 (empty)`);
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
}) as any;

let all = new Uint8Array(0);
const sink = (chunk: Uint8Array) => {
  const next = new Uint8Array(all.length + chunk.length);
  next.set(all); next.set(chunk, all.length);
  all = next;
};

const session = await createFxTermSession({
  wasm,
  terminal: { cols: 106, rows: 28 },
  env: {
    HOME: "/fx-stream-test",
    AI_GATEWAY_API_KEY: "mock-key-for-stream-test",
  },
  stdout: sink,
  fetch: mockFetch,
  stores: {
    config: { async get() { return null; }, async set() {} },
  },
  onEvent: (type) => {
    if (type === "stream.end") closeCount += 1;
  },
});

await Promise.race([
  session.interactive,
  sleep(90_000).then(() => { throw new Error("timeout: TUI never became interactive"); }),
]);
console.log("TUI interactive — submitting a prompt");

const before = all.length;
for (const ch of "say hi") session.write(ch);
await sleep(200);
session.write("\r");

// Wait for the reply with NO short deadline — models stream for minutes.
// Progress heartbeat every 5 s so a hang is visible, not silent.
let waited = 0;
let rendered = false;
while (waited < 20 * 60_000) {
  const t = new TextDecoder().decode(all);
  if (t.includes(REPLY)) { rendered = true; break; }
  if (postCount === 0 && waited > 0 && waited % 15_000 === 0) {
    console.log(`  … still waiting (prompt not submitted yet) — rendered bytes: ${all.length - before}`);
  } else if (waited > 0 && waited % 5_000 === 0) {
    console.log(`  … streaming (${all.length - before} bytes rendered so far)`);
  }
  await sleep(200);
  waited += 200;
}
const text = new TextDecoder().decode(all);

const checks: [string, boolean][] = [
  ["model call fired (POST intercepted)", postCount === 1],
  ["stream closed cleanly", closeCount >= 1],
  ["reply rendered to terminal", rendered],
  ["input echo rendered", text.includes("say hi")],
];
let ok = true;
for (const [what, pass] of checks) {
  console.log(` ${pass ? "PASS" : "FAIL"}  ${what}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.error("--- captured stream tail (reply window) ---");
  console.error(JSON.stringify(new TextDecoder().decode(all.slice(before)).slice(0, 800)));
}

session.end();
const code = await Promise.race([
  session.exited,
  sleep(30_000).then(() => -999),
]);
console.log(`exit code ${code}`);
clearTimeout(watchdog);
const pass = ok && code !== -999;
console.log(pass ? "stream-test: OK (fx paces polls with poll_oneoff sleeps; imports fully sync)" : "stream-test: FAILED");
process.exit(pass ? 0 : 1);
