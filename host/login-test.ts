/**
 * Does "Sign in with Vercel" end in a usable Gateway credential on the
 * embedded surface? Boots fx-term.wasm with a mock Vercel (OpenID metadata,
 * device authorization, token polling, teams, model catalog, inference) and
 * in-memory stores, runs `/login`, and reports what the TUI showed, what fx
 * persisted in the OAuth session, and which credential/team the first model
 * call carried.
 *
 *   bun host/login-test.ts            # no API key (login is the only source)
 *   LOGIN_TEST_KEY=1 bun host/login-test.ts   # AI_GATEWAY_API_KEY also set
 *   LOGIN_TEST_TEAMS=0|1|2            # how many teams the account has
 *   LOGIN_TEST_TYPE=2                 # type into the team picker after sign-in
 *   LOGIN_TEST_PICK=1                 # press Enter once after sign-in (team picker)
 */
import { readFileSync } from "node:fs";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wasm = new Uint8Array(readFileSync("romfs/fx-term.wasm"));
const teamCount = Number(process.env.LOGIN_TEST_TEAMS ?? "1");
const withKey = process.env.LOGIN_TEST_KEY === "1";
const pick = process.env.LOGIN_TEST_PICK === "1";

const teams = Array.from({ length: teamCount }, (_, i) => ({
  id: `team_${String(i + 1).padStart(24, "0")}`,
  slug: `mock-team-${i + 1}`,
  name: `Mock Team ${i + 1}`,
}));

const calls: string[] = [];
const inference: { authorization: string | null; team: string | null }[] = [];
let tokenPolls = 0;
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const mockFetch = (async (input: any, init: any) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url}`);
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
      device_code: "mock-device-code",
      user_code: "MOCK-CODE",
      verification_uri: "https://vercel.com/device",
      verification_uri_complete: "https://vercel.com/device?user_code=MOCK-CODE",
      expires_in: 600,
      interval: 1,
    });
  }
  if (url.endsWith("/login/oauth/token")) {
    tokenPolls++;
    if (tokenPolls < 2) return json(400, { error: "authorization_pending" });
    return json(200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      token_type: "Bearer",
      scope: "openid offline_access",
      expires_in: 3600,
    });
  }
  if (url.endsWith("/v2/teams")) {
    return json(200, { teams, pagination: { count: teams.length, next: null, prev: null } });
  }
  if (url.includes("/coding-agent/v1/models")) {
    return json(200, { data: [{ id: "mock/model", name: "Mock", specification: { provider: "mock", modelId: "model" } }] });
  }
  if (url.includes("/v3/ai/language-model")) {
    inference.push({
      authorization: headers.get("authorization"),
      team: headers.get("x-vercel-ai-gateway-team"),
    });
    return json(401, { error: { message: "mock: authentication failed" } });
  }
  return json(404, { error: "unmocked" });
}) as any;

// In-memory stores mirroring src/fxwasm/stores.ts contracts.
const configMap = new Map<string, string>();
let oauthRecord: { bytes: Uint8Array; revision: string } | null = null;
let revisionCounter = 0;
const stores = {
  config: {
    async get(id: string) { return configMap.get(id) ?? null; },
    async set(id: string, value: string) { configMap.set(id, value); },
  },
  oauth: {
    async load() { return oauthRecord ? { bytes: oauthRecord.bytes.slice(), revision: oauthRecord.revision } : null; },
    async commit(bytes: Uint8Array, expected?: string) {
      if (oauthRecord && expected !== undefined && oauthRecord.revision !== expected) {
        const error: any = new Error("conflict");
        error.code = "FX_OAUTH_SESSION_REVISION_CONFLICT";
        throw error;
      }
      oauthRecord = { bytes: bytes.slice(), revision: `r${++revisionCounter}` };
      return { revision: oauthRecord.revision };
    },
    async remove(expected?: string) {
      if (!oauthRecord) return "missing" as const;
      if (expected !== undefined && oauthRecord.revision !== expected) return false;
      oauthRecord = null;
      return true;
    },
  },
};

let all = "";
const events: string[] = [];
const session = await createFxTermSession({
  wasm,
  terminal: { cols: 106, rows: 27 },
  env: { HOME: "/fx-login-test", ...(withKey ? { AI_GATEWAY_API_KEY: "mock-api-key" } : {}) },
  stdout: (c: Uint8Array) => { all += new TextDecoder().decode(c); },
  fetch: mockFetch,
  stores,
  onEvent: (t: string, d: any) => { events.push(`${t} ${JSON.stringify(d ?? {}).slice(0, 140)}`); },
});
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, " ").trim();

await Promise.race([session.interactive, sleep(90_000).then(() => { throw new Error("not interactive"); })]);
await sleep(1500);
let mark = all.length;
for (const ch of "/login") session.write(ch);
await sleep(300);
session.write("\r");
// Device flow: metadata, device code, then token polling on fx's own timer.
for (let i = 0; i < 40 && tokenPolls < 2; i++) await sleep(500);
await sleep(2500);
console.log("--- screen after sign-in:\n" + plain(all.slice(mark)).slice(-1400));
{
  // Device clip 2026-09-02: the sign-in card re-rendered as "Preparing sign-in…"
  // for ~1.6 s between "Signed in to Vercel." and the team adoption.
  const raw = plain(all.slice(mark));
  const signedIn = raw.indexOf("Signed in to Vercel.");
  const flash = signedIn >= 0 && raw.slice(signedIn).includes("Preparing sign-in");
  console.log(`--- sign-in card after "Signed in": ${flash ? "SHOWN (flash)" : "not shown"}`);
}
console.log("--- oauth session after sign-in:", oauthRecord ? new TextDecoder().decode(oauthRecord.bytes) : null);
console.log("--- config store:", Object.fromEntries(configMap));

const typed = process.env.LOGIN_TEST_TYPE ?? "";
if (typed) {
  mark = all.length;
  for (const ch of typed) session.write(ch);
  await sleep(800);
  console.log("--- screen after typing:\n" + plain(all.slice(mark)).slice(-400));
}
if (pick) {
  mark = all.length;
  session.write("\r");
  await sleep(1500);
  console.log("--- screen after Enter:\n" + plain(all.slice(mark)).slice(-600));
  console.log("--- oauth session after Enter:", oauthRecord ? new TextDecoder().decode(oauthRecord.bytes) : null);
}

mark = all.length;
for (const ch of "hello") session.write(ch);
await sleep(300);
session.write("\r");
await sleep(4000);
console.log("--- screen after prompt:\n" + plain(all.slice(mark)).slice(-700));
console.log("--- fetch calls:", calls);
console.log("--- inference headers:", inference);
console.log("--- oauth session at end:", oauthRecord ? new TextDecoder().decode(oauthRecord.bytes) : null);

session.write("\x03"); await sleep(300);
session.end();
await Promise.race([session.exited, sleep(5000)]);
process.exit(0);
