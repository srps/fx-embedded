/**
 * Is the /login team bug fx's, or fx-embedded's? This host does NOT use
 * src/fxwasm/runtime.ts. It boots fx-term.wasm through fx's own SDK
 * (sdk/fx-sdk.js `createFxTerminal`) under bun/JavaScriptCore with a mock
 * Vercel, runs `/login`, types a prompt straight after "Signed in", and
 * reports the persisted OAuth session and the first inference request's
 * auth headers.
 *
 *   FX_WASM=/path/to/fx-term.wasm FX_SDK=../fx/sdk/fx-sdk.js bun host/sdk-login-proof.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sdkPath = resolve(process.env.FX_SDK ?? "../fx/sdk/fx-sdk.js");
const wasmPath = resolve(process.env.FX_WASM ?? "romfs/fx-term.wasm");
const { createFxTerminal } = await import(sdkPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const teams = [{ id: "team_000000000000000000000001", slug: "mock-team-1", name: "Mock Team 1" }];
const calls: string[] = [];
const inference: { authorization: string | null; team: string | null }[] = [];
let tokenPolls = 0;
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mockFetch = (async (input: any, init: any) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  const headers = new Headers(init?.headers ?? {});
  if (url.endsWith("/.well-known/openid-configuration")) {
    return json(200, {
      issuer: "https://vercel.com",
      device_authorization_endpoint: "https://api.vercel.com/login/oauth/device-authorization",
      token_endpoint: "https://api.vercel.com/login/oauth/token",
    });
  }
  if (url.endsWith("/login/oauth/device-authorization")) {
    return json(200, {
      device_code: "mock-device-code", user_code: "MOCK-CODE",
      verification_uri: "https://vercel.com/device",
      verification_uri_complete: "https://vercel.com/device?user_code=MOCK-CODE",
      expires_in: 600, interval: 1,
    });
  }
  if (url.endsWith("/login/oauth/token")) {
    tokenPolls++;
    if (tokenPolls < 2) return json(400, { error: "authorization_pending" });
    return json(200, {
      access_token: "mock-access-token", refresh_token: "mock-refresh-token",
      token_type: "Bearer", scope: "openid offline_access", expires_in: 3600,
    });
  }
  if (url.endsWith("/v2/teams")) return json(200, { teams, pagination: { count: 1, next: null, prev: null } });
  if (url.includes("/coding-agent/v1/models")) return json(200, { data: [] });
  if (url.includes("/v3/ai/language-model")) {
    inference.push({ authorization: headers.get("authorization"), team: headers.get("x-vercel-ai-gateway-team") });
    return json(401, { error: { message: "mock: authentication failed" } });
  }
  return json(404, { error: "unmocked" });
}) as any;

let oauthRecord: { bytes: Uint8Array; revision: string } | null = null;
let rev = 0;
const oauthSessionStore = {
  async load() { return oauthRecord ? { bytes: oauthRecord.bytes.slice(), revision: oauthRecord.revision } : null; },
  async commit(bytes: Uint8Array, expected?: string) {
    if (oauthRecord && expected !== undefined && oauthRecord.revision !== expected) {
      const e: any = new Error("conflict"); e.code = "FX_OAUTH_SESSION_REVISION_CONFLICT"; throw e;
    }
    oauthRecord = { bytes: bytes.slice(), revision: `r${++rev}` };
    return { revision: oauthRecord.revision };
  },
  async remove(expected?: string) {
    if (!oauthRecord) return "missing" as const;
    if (expected !== undefined && oauthRecord.revision !== expected) return false;
    oauthRecord = null; return true;
  },
};

// Minimal terminal adapter (the shape xtermAdapter() produces), no xterm.
let all = "";
let dataHandler: ((data: string) => void) | null = null;
const terminal = {
  write(bytes: any) { all += typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes); },
  onData(cb: (data: string) => void) { dataHandler = cb; return () => { dataHandler = null; }; },
  onResize() { return () => {}; },
  cols: 106,
  rows: 27,
};
const type = (s: string) => dataHandler?.(s);
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, " ").trim();

const runtime = await createFxTerminal({
  wasm: new Uint8Array(readFileSync(wasmPath)),
  terminal,
  fetch: mockFetch,
  oauthSessionStore,
  configStore: { async get() { return null; }, async set() {} },
  env: { HOME: "/fx-sdk-proof" },
});
await Promise.race([runtime.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
await sleep(1500);
let mark = all.length;
for (const ch of "/login") type(ch);
await sleep(300);
type("\r");
for (let i = 0; i < 40 && tokenPolls < 2; i++) await sleep(500);
await sleep(2500);
console.log("wasm:", wasmPath);
console.log("--- footer after sign-in:", plain(all.slice(mark)).slice(-300));
console.log("--- session after sign-in:", oauthRecord ? new TextDecoder().decode(oauthRecord.bytes) : null);
mark = all.length;
for (const ch of "hello") type(ch);
await sleep(300);
type("\r");
await sleep(4000);
console.log("--- screen after prompt:", plain(all.slice(mark)).slice(-260));
console.log("--- inference headers:", JSON.stringify(inference));
console.log("--- session at end:", oauthRecord ? new TextDecoder().decode(oauthRecord.bytes) : null);
type("\x03"); await sleep(300);
try { runtime.end?.(); } catch {}
await Promise.race([runtime.exited, sleep(5000)]);
process.exit(0);
