/**
 * Mock hbmenu netloader for host-side verification of host/push.ts.
 *
 * Implements exactly what netloader.c does on the Switch (loadnro +
 * decompress), including both response writes and the arg phase, then checks:
 *   - the requested path is an .nro under the menu root (sdmc:/switch/)
 *   - the deflated stream inflates to exactly `filelen` bytes
 *   - those bytes are identical to the source file
 *
 * Usage: bun host/mock-hbmenu.ts <source.nro> [port]
 * Exits 0 with PASS when a conforming push completes.
 */

import { createServer } from "node:net";
import { inflateSync } from "node:zlib";

const sourcePath = process.argv[2];
const port = Number(process.argv[3] ?? 28280);
if (!sourcePath) {
  console.error("usage: bun host/mock-hbmenu.ts <source.nro> [port]");
  process.exit(2);
}
const expected = Buffer.from(await Bun.file(sourcePath).arrayBuffer());

function readExact(
  sock: import("node:net").Socket,
  state: { buf: Buffer },
  n: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const finish = (err: Error | undefined, out?: Buffer) => {
      sock.off("data", onData);
      sock.off("close", onClose);
      sock.off("error", onErr);
      err ? reject(err) : resolve(out!);
    };
    const pull = () => {
      if (state.buf.length >= n) {
        const out = state.buf.subarray(0, n);
        state.buf = state.buf.subarray(n);
        finish(undefined, out);
      }
    };
    const onData = (c: Buffer) => {
      state.buf = Buffer.concat([state.buf, c]);
      pull();
    };
    const onClose = () => finish(new Error("client closed early"));
    const onErr = (e: Error) => finish(e);
    sock.on("data", onData);
    sock.on("close", onClose);
    sock.on("error", onErr);
    pull();
  });
}

const server = createServer((sock) => {
  const state = { buf: Buffer.alloc(0) };
  void (async () => {
    // --- loadnro() ---
    const nameLen = (await readExact(sock, state, 4)).readUInt32LE(0);
    const name = (await readExact(sock, state, nameLen)).toString("ascii");
    const fileLen = (await readExact(sock, state, 4)).readUInt32LE(0);
    const path = `sdmc:/switch/${name}`;
    console.log(`[mock] loadnro: path=${path} filelen=${fileLen}`);

    if (!path.endsWith(".nro")) throw new Error("not an .nro");

    // response A: sent right after the file is opened for writing
    const a = Buffer.alloc(4);
    a.writeInt32LE(0, 0);
    sock.write(a);

    // --- decompress(): chunked zlib until the stream ends ---
    // The C code inflates incrementally; inflateSync() throws on truncated
    // input, so treat "incomplete stream" as "need more chunks" and only
    // break when the full stream inflates to >= fileLen bytes.
    const parts: Buffer[] = [];
    let raw: Buffer | undefined;
    for (;;) {
      const chunkLen = (await readExact(sock, state, 4)).readUInt32LE(0);
      if (chunkLen > 16 * 1024) throw new Error("chunk too large");
      parts.push(await readExact(sock, state, chunkLen));
      let probe: Buffer | undefined;
      try {
        probe = inflateSync(Buffer.concat(parts));
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (msg.includes("end of file") || msg.includes("buffer")) continue;
        throw e;
      }
      if (probe.length < fileLen) continue;
      if (probe.length > fileLen) {
        throw new Error(`inflated ${probe.length} > announced ${fileLen}`);
      }
      raw = probe;
      break;
    }
    if (!raw) throw new Error("no data");

    // response B: sent after successful decompress
    const b = Buffer.alloc(4);
    b.writeInt32LE(0, 0);
    sock.write(b);

    // --- args phase ---
    const cmdLen = (await readExact(sock, state, 4)).readUInt32LE(0);
    if (cmdLen > 0) await readExact(sock, state, cmdLen);

    // --- verify ---
    if (raw.length !== fileLen) {
      throw new Error(`size mismatch: sent ${fileLen}, inflated ${raw.length}`);
    }
    if (!raw.equals(expected)) {
      throw new Error("content mismatch: inflated bytes differ from source");
    }
    console.log(`[mock] received ${raw.length} bytes, byte-identical to ${sourcePath}`);
    console.log("[mock] PASS — push.ts speaks netloader correctly");
    sock.end();
    server.close();
    process.exit(0);
  })().catch((e: unknown) => {
    console.error(`[mock] FAIL — ${(e as Error).message}`);
    sock.destroy();
    process.exit(1);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] netloader listening on 127.0.0.1:${port}`);
});

setTimeout(() => {
  console.error("[mock] FAIL — timed out waiting for a push");
  process.exit(1);
}, 15000);
