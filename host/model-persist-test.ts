/**
 * Picking a model on the embedded surface must persist through the host
 * config store and must NOT print fx's HOME-based user-settings failure
 * ("Model picker: active for this process but not saved to user settings
 * (HomeNotSet)"), which showed up on device 2026-09-02.
 */
import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wasm = new Uint8Array(readFileSync(process.env.FX_WASM ?? "romfs/fx-term.wasm"));
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mockFetch = (async (input: any) => {
  const url = String(input);
  if (url.includes("/coding-agent/v1/models")) {
    return json(200, { data: [
      { id: "mock/alpha", name: "Alpha", specification: { provider: "mock", modelId: "alpha" } },
      { id: "mock/beta", name: "Beta", specification: { provider: "mock", modelId: "beta" } },
    ] });
  }
  return json(404, { error: "unmocked" });
}) as any;

const configMap = new Map<string, string>();
let all = "";
const session = await createFxTermSession({
  wasm, terminal: { cols: 106, rows: 27 },
  env: { HOME: "/fx-model-persist", AI_GATEWAY_API_KEY: "mock-api-key" },
  stdout: (c: Uint8Array) => { all += new TextDecoder().decode(c); },
  fetch: mockFetch,
  stores: { config: { async get(id: string) { return configMap.get(id) ?? null; }, async set(id: string, v: string) { configMap.set(id, v); } } },
});
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, " ");
await Promise.race([session.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
await sleep(1000);
for (const ch of "/model") session.write(ch);
await sleep(300); session.write("\r"); await sleep(2500);
// Move to the second model, select it, accept the default effort.
session.write("\x1b[B"); await sleep(200); session.write("\r"); await sleep(1200);
session.write("\r"); await sleep(1500);
const screen = plain(all);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
check("model switched", /Switched to mock\/(alpha|beta)|mock\/(alpha|beta)/.test(screen), screen.slice(-300));
check("host config store received the model", [...configMap.entries()].some(([k, v]) => k === "model" && /^mock\//.test(v)), JSON.stringify([...configMap.entries()]));
check("no user-settings failure notice", !/not saved to user settings|HomeNotSet/.test(screen), (screen.match(/.{0,80}not saved to user settings.{0,40}/) ?? [""])[0]);
session.write("\x03"); await sleep(200); session.end();
await Promise.race([session.exited, sleep(5000)]);
console.log(failures ? `model-persist-test: ${failures} FAILED` : "model-persist-test: OK");
process.exit(failures ? 1 : 0);
