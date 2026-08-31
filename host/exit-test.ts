/**
 * Exit-during-retry regression: the Gateway answers 429 forever, the user
 * requests exit (Ctrl-C + stdin EOF) mid-retry. Device runs 2026-08-30 froze
 * here (closed stdin resolved as a microtask → host loop starved → no timers,
 * no abort fallback). Assert the session settles within the fallback budget.
 */
import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wasm = new Uint8Array(readFileSync("romfs/fx-term.wasm"));
let posts = 0;
const mockFetch = (async (url: any) => {
  if (String(url).includes("/v3/ai/language-model")) {
    posts++;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":"rate limited"}')); c.close(); } });
    return { ok: false, status: 429, body };
  }
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
}) as any;
let ticks = 0; const tick = setInterval(() => ticks++, 50);
const session = await createFxTermSession({
  wasm, terminal: { cols: 106, rows: 28 }, env: { HOME: "/fx-exit-test", AI_GATEWAY_API_KEY: "mock" },
  stdout: () => {}, fetch: mockFetch, stores: { config: { async get() { return null; }, async set() {} } },
});
await Promise.race([session.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
session.write("hi\r");
let w = 0; while (posts < 2 && w < 30_000) { await sleep(100); w += 100; }
console.log(`retrying (${posts} POSTs) — requesting exit`);
const t0 = Date.now(); const ticksBefore = ticks;
session.interrupt(); session.end();
setTimeout(() => { if (session.exitCode === null) session.abort(); }, 3000);
const code = await Promise.race([session.exited, sleep(8000).then(() => "TIMEOUT" as const)]);
clearInterval(tick);
const hostAlive = ticks - ticksBefore;
console.log(`exit code ${String(code)} after ${Date.now() - t0} ms; host timer ticks during exit: ${hostAlive}`);
const ok = code !== "TIMEOUT"; // ticks are informational: a fast exit has none
console.log(ok ? "PASS  session exited and the host loop kept running" : "FAIL  exit hung (host loop starved or abort fallback dead)");
process.exit(ok ? 0 : 1);
