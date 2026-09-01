/**
 * Deterministic end-to-end proof that fx-term.wasm advertises and executes
 * the Switch workspace tool. The fake Gateway asks fx to create a file with
 * the terminal tool, then returns a final answer after receiving the result.
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createFxTermSession } from "../src/fxwasm/runtime.ts";
import {
  createSwitchWorkspace,
  runWorkspaceCommand,
  type WorkspaceFs,
} from "../src/fxwasm/workspace.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = <T>(promise: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const root = mkdtempSync(join(tmpdir(), "fx-embedded-workspace-"));
const toHost = (path: string) => join(root, path.replace(/^sdmc:\/?/, "").replaceAll("/", "\\"));
let commits = 0;

const fsAdapter: WorkspaceFs = {
  mkdirSync(path) { mkdirSync(toHost(path), { recursive: true }); },
  readDirSync(path) { return readdirSync(toHost(path)); },
  readFileSync(path) {
    try { return new Uint8Array(readFileSync(toHost(path))); } catch { return null; }
  },
  writeFileSync(path, data) {
    const target = toHost(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  },
  appendFileSync(path, data) {
    const target = toHost(path);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  },
  removeSync(path) { rmSync(toHost(path), { recursive: true, force: true }); },
  renameSync(path, dest) { renameSync(toHost(path), toHost(dest)); },
  statSync(path) {
    try {
      const stat = statSync(toHost(path));
      return { mode: stat.mode, size: stat.size };
    } catch { return null; }
  },
  commitDeviceSync(device) {
    if (device !== "sdmc") throw new Error(`unexpected device ${device}`);
    commits += 1;
  },
};

const sse = (...events: unknown[]) => events.map((event) =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

let requests = 0;
const bodies: string[] = [];
const mockFetch = (async (_url: unknown, init: any) => {
  requests += 1;
  bodies.push(decoder.decode(init?.body));
  const payload = requests === 1
    ? sse(
      { type: "start", id: "turn-1" },
      {
        type: "tool-call",
        toolCallId: "switch-tool-1",
        toolName: "terminal",
        input: {
          action: "exec",
          command: "printf 'made by fx on Nintendo Switch\\n' > switch-demo.txt && cat switch-demo.txt",
        },
      },
      { type: "finish", finishReason: { unified: "tool-calls" } },
      "[DONE]",
    )
    : sse(
      { type: "start", id: "turn-2" },
      { type: "text-delta", delta: "Created switch-demo.txt with the on-device workspace tool." },
      { type: "finish", finishReason: { unified: "stop" } },
      "[DONE]",
    );
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;

let output = new Uint8Array();
const events: { type: string; detail?: Record<string, unknown> }[] = [];
const appendOutput = (chunk: Uint8Array) => {
  const next = new Uint8Array(output.length + chunk.length);
  next.set(output);
  next.set(chunk, output.length);
  output = next;
};

try {
  const traversal = runWorkspaceCommand(fsAdapter, "cat ../../outside.txt");
  const backslashTraversal = runWorkspaceCommand(fsAdapter, "cat '..\\..\\outside.txt'");
  const pipeline = runWorkspaceCommand(fsAdapter, "echo unsafe | cat");
  const committed = runWorkspaceCommand(fsAdapter, "printf durable > durability.txt");
  const wasm = new Uint8Array(readFileSync("romfs/fx-term.wasm"));
  const session = await createFxTermSession({
    wasm,
    terminal: { cols: 106, rows: 28 },
    env: { HOME: "/workspace", AI_GATEWAY_API_KEY: "workspace-test-key" },
    stdout: appendOutput,
    fetch: mockFetch,
    workspace: createSwitchWorkspace(fsAdapter),
    stores: { config: { async get() { return null; }, async set() {} } },
    onEvent(type, detail) { events.push({ type, detail }); },
  });

  await timeout(session.interactive, 60_000, "TUI did not become interactive");
  session.write("Use the terminal tool to create the requested Switch demo file.\r");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && requests < 2) await sleep(100);
  while (Date.now() < deadline && events.filter((event) => event.type === "stream.end").length < 2) {
    await sleep(100);
  }
  while (Date.now() < deadline && !decoder.decode(output).includes("Created switch-demo.txt")) {
    await sleep(50);
  }

  const created = readFileSync(
    toHost("sdmc:/switch/fx-embedded/workspace/switch-demo.txt"),
    "utf8",
  );
  const rendered = decoder.decode(output);
  const checks: [string, boolean][] = [
    ["Gateway received initial and follow-up turns", requests === 2],
    ["fx advertised the terminal workspace tool", bodies[0]?.includes('"name":"terminal"') === true],
    ["workspace import executed the model command", events.some((event) => event.type === "workspace.exec")],
    ["file was created through the root-confined adapter", created === "made by fx on Nintendo Switch\n"],
    ["workspace rejects traversal outside /workspace", traversal.exitCode !== 0 && traversal.stderr.includes("escapes")],
    ["workspace rejects host-style backslash traversal", backslashTraversal.exitCode !== 0 && backslashTraversal.stderr.includes("invalid")],
    ["workspace rejects unsupported shell pipelines", pipeline.exitCode === 2],
    ["redirected writes request an SD filesystem commit", committed.exitCode === 0 && commits >= 2],
    ["tool result was sent in the follow-up request", bodies[1]?.includes("made by fx on Nintendo Switch") === true],
    ["final assistant answer rendered", rendered.includes("Created switch-demo.txt")],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(` ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  session.interrupt();
  await sleep(300);
  session.end();
  const exitCode = await timeout(session.exited, 15_000, "fx did not exit")
    .catch(() => { session.abort(); return -999; });
  console.log(`workspace-test: ${ok ? "OK" : "FAILED"} (exit ${exitCode})`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
