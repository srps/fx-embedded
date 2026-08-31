/**
 * Push (and auto-launch) the fx-switch NRO to hbmenu's netloader — a pure-Bun
 * reimplementation of devkitPro's `nxlink`, so no devkitPro install needed.
 *
 * Protocol implemented against nx-hbmenu's common/netloader.c (loadnro +
 * decompress), which is the receiving ground truth:
 *
 *   TCP connect <switch>:28280
 *   -> u32le namelen, path bytes            (server prefixes sdmc:/switch/)
 *   -> u32le filelen  (UNcompressed size)
 *   <- int32  response A (0 once the file is open for writing)
 *   -> zlib deflate of the file, in chunks: u32le chunklen (<= 16384) + bytes
 *   <- int32  response B (0 after the server hits Z_STREAM_END)
 *   -> u32le cmdlen, cmdlen arg bytes       (0 = no extra args)
 *   hbmenu then writes the file and launches it.
 *
 * All lengths are little-endian: netloader.c recvall()s raw ints and the
 * device is little-endian aarch64. (A widely-copied Python gist sends
 * filelen big-endian; it only "works" because the server barely uses it.)
 *
 * Discovery: if --ip is omitted, broadcast "nxboot" from UDP :28281 and take
 * the "bootnx" reply's source address (netloader.c netloader_loop). Falls
 * back to SWITCH_IP env. Note: UDP broadcast does not cross WSL2 NAT mode —
 * pass --ip there (mirrored networking is fine).
 *
 * Usage: bun host/push.ts [nro] [--ip a.b.c.d] [--name fx-switch/fx-switch.nro]
 */

import { createSocket } from "node:dgram";
import { deflateSync } from "node:zlib";
import { createConnection } from "node:net";

const ZLIB_CHUNK = 16 * 1024; // netloader.c: chunksize > sizeof(in) is rejected
const NETLOADER_PORT = 28280; // NXLINK_SERVER_PORT (override with --port for tests)

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const positional = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--") || a === "--");
const nroPath = positional[0] ?? arg("nro") ?? "fx-switch.nro";
const remoteName = arg("name") ?? "fx-switch/fx-switch.nro";
const port = Number(arg("port") ?? NETLOADER_PORT);

async function discoverSwitch(timeoutMs = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const done = (ip?: string) => {
      try {
        sock.close();
      } catch { /* already closed */ }
      clearTimeout(timer);
      resolve(ip);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    sock.on("message", (msg, rinfo) => {
      if (msg.toString("ascii").startsWith("bootnx")) done(rinfo.address);
    });
    sock.on("listening", () => {
      sock.setBroadcast(true);
      sock.send(Buffer.from("nxboot", "ascii"), NETLOADER_PORT, "255.255.255.255");
    });
    sock.bind(28281); // NXLINK_CLIENT_PORT: netloader replies here
  });
}

function readExact(sock: import("node:net").Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        sock.off("data", onData);
        sock.off("error", onErr);
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    };
    const onErr = (e: Error) => reject(e);
    sock.on("data", onData);
    sock.on("error", onErr);
  });
}

function writeAll(sock: import("node:net").Socket, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(buf, (e) => (e ? reject(e) : resolve()));
  });
}

async function main(): Promise<void> {
  const file = Bun.file(nroPath);
  if (!(await file.exists())) {
    console.error(`push: ${nroPath} not found — run "bun run nro" first`);
    process.exit(1);
  }
  const raw = Buffer.from(await file.arrayBuffer());
  const deflated = deflateSync(raw);

  let ip = arg("ip") ?? process.env.SWITCH_IP;
  if (!ip) {
    console.log("push: no --ip given, discovering via UDP broadcast...");
    ip = await discoverSwitch();
    if (ip) console.log(`push: found Switch at ${ip}`);
  }
  if (!ip) {
    console.error(
      "push: no Switch found. Press Y in hbmenu to arm the netloader, then:\n" +
        "  bun host/push.ts fx-switch.nro --ip <switch-ip>",
    );
    process.exit(1);
  }
  if (!remoteName.endsWith(".nro")) {
    console.error("push: --name must end in .nro (netloader only launches NROs)");
    process.exit(1);
  }
  if (remoteName.includes("..")) {
    console.error("push: --name must not traverse directories");
    process.exit(1);
  }

  console.log(
    `push: ${nroPath} (${raw.length} B, ${deflated.length} B deflated) -> ` +
      `${ip}: sdmc:/switch/${remoteName}`,
  );

  const sock = createConnection({ host: ip, port: port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });

  const name = Buffer.from(remoteName, "ascii");
  const nameHead = Buffer.alloc(4);
  nameHead.writeUInt32LE(name.length, 0);
  await writeAll(sock, Buffer.concat([nameHead, name]));

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(raw.length, 0);
  await writeAll(sock, lenBuf);

  const respA = await readExact(sock, 4);
  if (respA.readInt32LE(0) !== 0) {
    throw new Error(`netloader rejected the file (response A = ${respA.readInt32LE(0)})`);
  }

  for (let off = 0; off < deflated.length; off += ZLIB_CHUNK) {
    const chunk = deflated.subarray(off, Math.min(off + ZLIB_CHUNK, deflated.length));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(chunk.length, 0);
    await writeAll(sock, Buffer.concat([head, chunk]));
  }

  const respB = await readExact(sock, 4);
  if (respB.readInt32LE(0) !== 0) {
    throw new Error(`transfer failed (response B = ${respB.readInt32LE(0)})`);
  }

  // empty extra args
  const cmd = Buffer.alloc(4);
  cmd.writeUInt32LE(0, 0);
  await writeAll(sock, cmd);

  sock.end();
  console.log(`push: done — hbmenu is launching ${remoteName}`);
  console.log("push: (screen shows a progress box; the app starts right after)");
}

main().catch((e: unknown) => {
  console.error(`push: ${(e as Error).message}`);
  console.error("push: is hbmenu showing 'netloader' (press Y in hbmenu)?");
  process.exit(1);
});
