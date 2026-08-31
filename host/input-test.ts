/**
 * Whole-line input fidelity test: the inline swkbd submits the entire prompt
 * as ONE stdin write (not per-key). Assert that fx forwards the exact text
 * to the model — a device run produced "switch-eemo.txt" / "mae by fx" from a
 * prompt containing "switch-demo.txt" / "made by fx".
 *
 *   bun host/input-test.ts [--wasm romfs/fx-term.wasm]
 */
import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PROMPT = 'Use the terminal tool to create switch-demo.txt containing "made by fx on Nintendo Switch", then read it back.';
const wasm = new Uint8Array(readFileSync(arg("wasm") ?? "romfs/fx-term.wasm"));
const enc = new TextEncoder();
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
let captured: string | null = null;
const mockFetch = (async (url: any, init: any) => {
  if (String(url).includes("/v3/ai/language-model")) {
    captured = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body ?? new Uint8Array());
    const chunks = [sse({ type: "start", id: "t1" }), sse({ type: "text-delta", delta: "ok" }), sse({ type: "finish" }), "data: [DONE]\n\n"];
    const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    return { ok: true, status: 200, body };
  }
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
}) as any;
let all = "";
const session = await createFxTermSession({
  wasm, terminal: { cols: 106, rows: 28 },
  env: { HOME: "/fx-input-test", AI_GATEWAY_API_KEY: "mock" },
  stdout: (c: Uint8Array) => { all += new TextDecoder().decode(c); },
  fetch: mockFetch,
  stores: { config: { async get() { return null; }, async set() {} } },
});
await Promise.race([session.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
session.write(`${PROMPT}\r`); // single write, like the swkbd submit path
let waited = 0;
while (captured === null && waited < 60_000) { await sleep(100); waited += 100; }
session.end();
await Promise.race([session.exited, sleep(5000)]);
if (captured === null) { console.error("FAIL: no model request"); process.exit(1); }
const body = JSON.parse(captured);
const text = JSON.stringify(body);
const ok = text.includes(PROMPT.replace(/"/g, '\\"'));
console.log(ok ? "PASS  exact prompt forwarded to the model" : "FAIL  prompt mangled");
if (!ok) { console.log("request body:", text.slice(0, 1500)); process.exit(1); }
console.log(all.includes("switch-demo.txt") ? "PASS  echo shows switch-demo.txt" : "WARN  echo missing (wrapped?)");
process.exit(0);
