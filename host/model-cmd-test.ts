/**
 * Does `/model` work on the embedded surface? Boots fx-term.wasm with a mock
 * host, types `/model`, and reports which host imports fx touches (the model
 * catalog goes through fx_http_request, the Suspending import that the
 * device build avoids) and what the TUI rendered.
 */
import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wasm = new Uint8Array(readFileSync("romfs/fx-term.wasm"));
const calls: string[] = [];
const mockFetch = (async (url: any, init: any) => {
  calls.push(`${init?.method ?? "GET"} ${String(url)}`);
  if (String(url).includes("/v1/models") || String(url).includes("catalog")) {
    return { ok: true, status: 200, body: null, text: async () => "{\"data\":[]}", arrayBuffer: async () => new TextEncoder().encode('{"data":[]}').buffer, headers: new Map() };
  }
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "", headers: new Map() };
}) as any;
let all = "";
const events: string[] = [];
const session = await createFxTermSession({
  wasm, terminal: { cols: 106, rows: 28 },
  env: { HOME: "/fx-model-test", AI_GATEWAY_API_KEY: "mock", FX_MODEL: process.env.FX_MODEL ?? "" },
  stdout: (c: Uint8Array) => { all += new TextDecoder().decode(c); },
  fetch: mockFetch,
  stores: { config: { async get() { return null; }, async set() {} } },
  onEvent: (t: string, d: any) => { events.push(`${t} ${JSON.stringify(d ?? {}).slice(0, 120)}`); },
});
await Promise.race([session.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
const before = all.length;
for (const ch of "/model") session.write(ch);
await sleep(300);
session.write("\r");
await sleep(4000);
const shown = all.slice(before).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+/g, " ");
console.log("fetch calls:", calls);
console.log("events:", events.filter(e => e.startsWith("http")));
console.log("screen after /model:", shown.slice(-900));
session.write("\x1b"); await sleep(300);
session.end(); await Promise.race([session.exited, sleep(5000)]);
process.exit(0);
