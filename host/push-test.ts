/** Cross-platform host test for the hbmenu netloader client. */

const sourcePath = process.argv[2] ?? "fx-embedded.nro";
const port = process.argv[3] ?? "28280";

if (!(await Bun.file(sourcePath).exists())) {
  console.error(`push-test: ${sourcePath} not found; run "bun run nro" first`);
  process.exit(1);
}

const mock = Bun.spawn(
  ["bun", "host/mock-hbmenu.ts", sourcePath, port],
  { stdout: "pipe", stderr: "pipe" },
);

let ready = false;
let resolveReady!: () => void;
const readySignal = new Promise<void>((resolve) => { resolveReady = resolve; });

async function relay(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
  watchForReady = false,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    write(text);
    if (watchForReady && !ready && text.includes("netloader listening")) {
      ready = true;
      resolveReady();
    }
  }
  const tail = decoder.decode();
  if (tail) write(tail);
}

const mockOut = relay(mock.stdout, (text) => process.stdout.write(text), true);
const mockErr = relay(mock.stderr, (text) => process.stderr.write(text));

const startup = await Promise.race([
  readySignal.then(() => "ready" as const),
  mock.exited.then((code) => ({ code })),
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
]);

if (startup !== "ready") {
  mock.kill();
  await Promise.allSettled([mockOut, mockErr]);
  const detail = startup === "timeout" ? "startup timed out" : `mock exited ${startup.code}`;
  console.error(`push-test: ${detail}`);
  process.exit(1);
}

const push = Bun.spawn(
  [
    "bun",
    "host/push.ts",
    sourcePath,
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    "--name",
    "fx-embedded/fx-embedded.nro",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

const pushCode = await push.exited;
if (pushCode !== 0) mock.kill();
const mockCode = await mock.exited;
await Promise.allSettled([mockOut, mockErr]);

if (pushCode !== 0 || mockCode !== 0) {
  console.error(`push-test: FAILED (push=${pushCode}, mock=${mockCode})`);
  process.exit(1);
}

console.log("push-test: OK");
