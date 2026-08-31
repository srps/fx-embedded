/**
 * fx-term.wasm host layer (V8 + JSPI).
 *
 * Ported from fx's own `sdk/fx-sdk.js` (term surface subset), keeping the
 * import contract byte-for-byte: the module expects a
 * `wasi_snapshot_preview1` namespace plus an `fx` namespace, with the
 * blocking ones wrapped in `WebAssembly.Suspending` and `_start` driven via
 * `WebAssembly.promising`. The wasm module itself is a plain WASI command
 * (zig build -Dwasm-surface=term) — JSPI is purely a host-side mechanism.
 *
 * Console-specific deltas vs the upstream sdk:
 *   - stores (config / prompt history / fx sessions) come in as options;
 *     the Switch wires them to SD files (stores.ts), Node smoke to memory
 *   - workspace is optional: the Switch host supplies a root-confined
 *     command interpreter backed by SD storage (not an OS shell)
 *   - oauth session store unsupported (-1): on-device login uses the API key
 *   - stdout additionally runs a terminal-query responder: fx probes the
 *     terminal (OSC 11 background + DA1 fence, DECRQM 996 color scheme) and
 *     expects replies on stdin; a real terminal answers, so we do too
 *     (matching the exact sequences of src/ui/terminal/terminal.zig)
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const WORKSPACE_INFO_LIMIT = 4 * 1024;
const WORKSPACE_COMMAND_LIMIT = 64 * 1024;
const WORKSPACE_OUTPUT_LIMIT = 64 * 1024;

function validWorkspacePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  if (strictDecoder.decode(encoder.encode(path)) !== path) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  return path.slice(1).split("/").every((part) => part && part !== "." && part !== "..");
}

/** Signature of the startup sequences we answer, with the replies. */
const QUERIES: { bytes: number[]; reply: string }[] = [
  // OSC 11 background query — answered with our dark theme, then the DA1
  // fence reply (\x1b[c -> \x1b[?1;2c) that tells fx the OSC answer ended.
  { bytes: [0x1b, 0x5d, 0x31, 0x31, 0x3b, 0x3f, 0x1b, 0x5c], reply: "\x1b]11;rgb:0b0b/0f0f/1414\x1b\\\x1b[?1;2c" },
  // Standalone DA1 (Primary Device Attributes) — VT102-class, 132 cols.
  { bytes: [0x1b, 0x5b, 0x63], reply: "\x1b[?1;2c" },
  // DECRQM color-scheme query -> "dark".
  { bytes: [0x1b, 0x5b, 0x3f, 0x39, 0x39, 0x36, 0x6e], reply: "\x1b[?996;2n" },
  // DSR cursor position — fx's engine swallows it; answer top-left anyway.
  { bytes: [0x1b, 0x5b, 0x36, 0x6e], reply: "\x1b[1;1R" },
];

const QUERY_MAX = 16;

/** Scans an outbound byte stream and answers terminal probes on stdin. */
class QueryResponder {
  private carry: number[] = [];
  private respond: (data: string) => void;

  constructor(respond: (data: string) => void) {
    this.respond = respond;
  }

  feed(chunk: Uint8Array): void {
    // Keep a short tail so queries split across fd_write calls still match.
    const buf = [...this.carry, ...chunk];
    let i = 0;
    while (i < buf.length) {
      const hit = QUERIES.find((q) => {
        if (buf.length - i < q.bytes.length) {
          // Might complete in a future chunk — only if it's a strict prefix
          // sitting at the very end of the buffer.
          return false;
        }
        return q.bytes.every((b, j) => buf[i + j] === b);
      });
      const partial = QUERIES.find((q) =>
        buf.length - i < q.bytes.length &&
        q.bytes.every((b, j) => buf[i + j] === b),
      );
      if (partial) break; // wait for the next chunk to complete it
      if (hit) {
        this.respond(hit.reply);
        i += hit.bytes.length;
        continue;
      }
      i += 1;
    }
    this.carry = buf.slice(Math.max(0, buf.length - QUERY_MAX));
  }
}

/** stdin: what we push is what fd_read eventually hands the module. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  closed = false;

  push(bytes: Uint8Array): void {
    if (this.closed) throw new Error("fx runtime stdin is closed");
    if (!bytes.length) return;
    this.chunks.push(bytes);
    this.wake();
  }

  read(max: number): Uint8Array | null {
    if (!this.chunks.length) return null;
    const chunk = this.chunks[0]!;
    const value = chunk.subarray(0, max);
    if (value.length === chunk.length) this.chunks.shift();
    else this.chunks[0] = chunk.subarray(value.length);
    return value;
  }

  wait(timeoutMs?: number): Promise<boolean> {
    // Closed stdin must NOT resolve as a microtask: fx keeps polling after
    // EOF while a turn/retry is in flight, and a Suspending import resumed
    // from a microtask never lets the host frame loop run — device run
    // 2026-08-30: screen froze, timers (incl. the abort fallback) and buttons
    // dead after Minus. Yield through a real macrotask instead.
    if (this.closed) return new Promise((resolve) => setTimeout(() => resolve(true), 10));
    return new Promise((resolve) => {
      let settled = false;
      let timer: any;
      const waiter = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  get pending(): boolean {
    return this.chunks.length > 0;
  }
}

export interface FxWorkspaceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FxWorkspaceAdapter {
  info: {
    version: 1;
    root: string;
    cwd: string;
    home: string;
    gitAvailable: false;
    ephemeral: true;
  };
  permission: "allow-sandboxed" | "prompt";
  exec(request: {
    command: string;
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    outputLimitBytes: number;
  }): FxWorkspaceResult | Promise<FxWorkspaceResult>;
}

export interface FxStores {
  config?: { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void> };
  promptHistory?: {
    load(workspaceRoot: string, limit: number): Promise<string[]>;
    append(workspaceRoot: string, value: string, ts: number): Promise<"ok" | "duplicate" | "record_too_large">;
    clear(workspaceRoot: string): Promise<void>;
  };
  session?: {
    load(id: string): Promise<{ bytes: Uint8Array; revision: string } | null>;
    commit(id: string, bytes: Uint8Array, expected?: string): Promise<{ revision: string }>;
    list(): Promise<{ id: string; updatedAtMs: number }[]>;
    remove(id: string): Promise<void>;
  };
  /** "Sign in with Vercel" persistence (device-flow tokens). */
  oauth?: {
    load(): Promise<{ bytes: Uint8Array; revision: string } | null>;
    commit(bytes: Uint8Array, expected?: string): Promise<{ revision: string }>;
    remove(expected?: string): Promise<boolean | "missing">;
  };
}

export interface FxTermOptions {
  wasm: BufferSource;
  args?: string[];
  env?: Record<string, string>;
  /** Terminal geometry reported via fx_term_size. */
  terminal: { cols: number; rows: number };
  /** Raw TUI output (ANSI). MUST be rendered verbatim. */
  stdout: (chunk: Uint8Array) => void;
  stderr?: (chunk: Uint8Array) => void;
  fetch?: typeof fetch;
  stores?: FxStores;
  workspace?: FxWorkspaceAdapter;
  onEvent?: (type: string, detail?: Record<string, unknown>) => void;
  traceWasi?: boolean;
}

export interface FxTermSession {
  /** Resolves once the TUI is up and waiting for input (first poll). */
  interactive: Promise<void>;
  /** Resolves with the exit code when the module returns. */
  exited: Promise<number>;
  /** Feed terminal input bytes (what a keyboard would have typed). */
  write(data: string | Uint8Array): void;
  /** Kick the input poller after a resize. */
  resize(): void;
  /** Ctrl-C semantics: cancel in-flight host effects, then interrupt. */
  interrupt(): void;
  /** Graceful: close stdin (EOF) so fx shuts down and _start returns. */
  end(): void;
  /** Hard stop. */
  abort(): void;
}

function compileModule(input: BufferSource): Promise<WebAssembly.Module> {
  return WebAssembly.compile(input as any);
}

function createRuntime(options: FxTermOptions) {
  const stdin = new ByteQueue();
  const responder = new QueryResponder((reply) => {
    options.onEvent?.("query.replied", { reply: JSON.stringify(reply) });
    stdin.push(encoder.encode(reply));
  });
  /** Set by createFxTermSession: first input poll == TUI is interactive. */
  const hooks = { onPoll: () => {} };
  const streams = new Map<number, any>();
  const workspaceExecs = new Set<{ abort(code: number): void }>();
  const workspace = (() => {
    const adapter = options.workspace;
    if (!adapter) return { present: false, valid: false } as const;
    try {
      const info = adapter.info;
      const valid = info.version === 1 && validWorkspacePath(info.root) &&
        validWorkspacePath(info.cwd) && validWorkspacePath(info.home) &&
        info.cwd === info.root && info.gitAvailable === false && info.ephemeral === true &&
        (adapter.permission === "allow-sandboxed" || adapter.permission === "prompt");
      if (!valid) return { present: true, valid: false } as const;
      const encoded = encoder.encode(JSON.stringify({
        version: 1,
        root: info.root,
        cwd: info.cwd,
        home: info.home,
        git: false,
        ephemeral: true,
        permission: adapter.permission,
      }));
      if (encoded.length > WORKSPACE_INFO_LIMIT) return { present: true, valid: false } as const;
      return { present: true, valid: true, adapter, info, encoded } as const;
    } catch {
      return { present: true, valid: false } as const;
    }
  })();
  const args = ["fx", ...(options.args ?? [])];
  const env = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const emit = (type: string, detail: Record<string, unknown> = {}) => {
    try { options.onEvent?.(type, detail); } catch { /* events never fatal */ }
  };
  let instance: WebAssembly.Instance | null = null;
  let nextHandle = 1;
  let exitedResolve!: (code: number) => void;
  let exitCode: number | null = null;
  let aborted = false;
  const exited = new Promise<number>((r) => { exitedResolve = r; });
  const markExited = (code: number) => {
    if (exitCode !== null) return;
    exitCode = code;
    exitedResolve(code);
  };

  const memory = () => (instance!.exports as any).memory;
  const bytes = (ptr: number, len: number) => new Uint8Array(memory().buffer, ptr, len);
  const text = (ptr: number, len: number) => decoder.decode(bytes(ptr, len));
  const writeU32 = (ptr: number, value: number) =>
    new DataView(memory().buffer).setUint32(ptr, value, true);
  const writeU64 = (ptr: number, value: number | bigint) =>
    new DataView(memory().buffer).setBigUint64(ptr, BigInt(value), true);

  function checkedBytes(ptr: number, len: number): Uint8Array | null {
    const size = memory().buffer.byteLength;
    if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0 ||
      ptr > size || len > size - ptr) return null;
    return bytes(ptr, len);
  }

  function writeVector(values: string[], ptrs: number, data: number): void {
    let cursor = data;
    values.forEach((value, index) => {
      const encoded = encoder.encode(`${value}\0`);
      writeU32(ptrs + index * 4, cursor);
      bytes(cursor, encoded.length).set(encoded);
      cursor += encoded.length;
    });
  }

  // ------------------------------------------------------------------ WASI

  function fdWrite(fd: number, iovs: number, count: number, nwritten: number): number {
    if (options.traceWasi) console.error("[wasi] fd_write", { fd, count });
    const view = new DataView(memory().buffer);
    let total = 0;
    for (let index = 0; index < count; index++) {
      total += view.getUint32(iovs + index * 8 + 4, true);
    }
    if (fd === 1 || fd === 2) {
      const chunk = new Uint8Array(total);
      let offset = 0;
      for (let index = 0; index < count; index++) {
        const ptr = view.getUint32(iovs + index * 8, true);
        const len = view.getUint32(iovs + index * 8 + 4, true);
        chunk.set(bytes(ptr, len), offset);
        offset += len;
      }
      if (fd === 1) {
        // The stdout side-channel must not throw into the wasm import
        // callback: a JS exception here becomes a wasm trap, and V8 has
        // crashed formatting such errors (CallPrinter -> parser -> Abort).
        try {
          responder.feed(chunk);
          options.stdout(chunk);
        } catch (error) {
          try {
            options.onEvent?.("stdout.error", {
              error: String(error).slice(0, 200),
              bytes: total,
            });
          } catch { /* */ }
        }
      } else options.stderr?.(chunk);
    }
    writeU32(nwritten, total);
    return 0;
  }

  const trapIfAborted = () => {
    if (aborted) throw new WebAssembly.RuntimeError("fx aborted by host");
  };
  function fdRead(fd: number, iovs: number, count: number, nread: number): number | Promise<number> {
    trapIfAborted();
    if (options.traceWasi) console.error("[wasi] fd_read", { fd, count });
    if (fd !== 0) return 8;
    const attempt = (): number | null => {
      const view = new DataView(memory().buffer);
      let total = 0;
      for (let index = 0; index < count; index++) {
        const ptr = view.getUint32(iovs + index * 8, true);
        const len = view.getUint32(iovs + index * 8 + 4, true);
        const chunk = stdin.read(len);
        if (!chunk) break;
        bytes(ptr, chunk.length).set(chunk);
        total += chunk.length;
        if (chunk.length < len) break;
      }
      if (total) { writeU32(nread, total); return 0; }
      return null;
    };
    const immediate = attempt();
    if (immediate !== null) return immediate;
    if (stdin.closed) {
      // Same reason as ByteQueue.wait: a synchronous EOF lets fx spin on
      // fd_read without ever yielding to the host.
      return new Promise<number>((resolve) => setTimeout(() => { writeU32(nread, 0); resolve(0); }, 10));
    }
    return stdin.wait().then(() => {
      const result = attempt();
      if (result !== null) return result;
      writeU32(nread, 0);
      return 0;
    });
  }

  function pollOneoff(subscriptions: number, events: number, count: number, nevents: number): number | Promise<number> {
    trapIfAborted();
    if (options.traceWasi) console.error("[wasi] poll_oneoff", { count });
    const view = new DataView(memory().buffer);
    for (let index = 0; index < count; index++) {
      const base = subscriptions + index * 48;
      if (view.getUint8(base + 8) === 1 && stdin.pending) {
        bytes(events, 32).fill(0);
        bytes(events, 8).set(bytes(base, 8));
        view.setUint8(events + 10, 1);
        writeU32(nevents, 1);
        return 0;
      }
    }
    let timeout: number | null = null;
    for (let index = 0; index < count; index++) {
      const base = subscriptions + index * 48;
      if (view.getUint8(base + 8) === 0) {
        timeout = Number(view.getBigUint64(base + 24, true) / 1000000n);
      }
    }
    return stdin.wait(timeout === null ? undefined : timeout).then(() => {
      bytes(events, 32).fill(0);
      bytes(events, 8).set(bytes(subscriptions, 8));
      writeU32(nevents, 1);
      return 0;
    });
  }

  // ------------------------------------------------- fx HTTP (the gateway)

  function headersFromJson(ptr: number, len: number): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const { name, value } of JSON.parse(text(ptr, len) || "[]")) {
      headers[name as string] = value as string;
    }
    return headers;
  }

  function streamOpen(
    methodPtr: number, methodLen: number, urlPtr: number, urlLen: number,
    headersPtr: number, headersLen: number, bodyPtr: number, bodyLen: number,
  ): number {
    emit("http.request", { method: text(methodPtr, methodLen), url: text(urlPtr, urlLen) });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const handle = nextHandle++;
    const state: any = {
      controller,
      openedAt: Date.now(),
      reader: null,
      leftover: new Uint8Array(),
      response: null,
      responseError: null as any,
      pendingRead: null as any,
      readResult: null as any,
      readError: null as any,
    };
    streams.set(handle, state);
    Promise.resolve().then(() =>
      (options.fetch ?? fetch)(text(urlPtr, urlLen), {
        method: text(methodPtr, methodLen),
        headers: headersFromJson(headersPtr, headersLen),
        body: bodyLen ? bytes(bodyPtr, bodyLen).slice() : undefined,
        ...(controller ? { signal: controller.signal } : {}),
      } as any),
    ).then((response: any) => {
      state.response = response;
      state.reader = response.body?.getReader() ?? null;
      emit("stream.open", { handle, status: response.status });
    }).catch((error: any) => {
      state.responseError = error;
      emit("stream.end", { handle, error: String(error).slice(0, 120) });
    });
    return handle;
  }

  function streamStatus(handle: number, statusOut: number): number {
    const state = streams.get(handle);
    if (!state) return -1;
    if (state.responseError) return state.responseError?.name === "AbortError" ? -2 : -1;
    if (!state.response) {
      // Response watchdog: a fetch whose worker got stuck (e.g. a socket
      // reset under a blocking TLS read) never settles — device run
      // 2026-08-30 showed "Thinking" for 12 minutes. Fail it so fx reports
      // the turn instead of waiting forever.
      if (Date.now() - state.openedAt > 60_000) {
        state.responseError = new Error("no response headers within 60 s");
        emit("stream.end", { handle, error: state.responseError.message });
        try { state.controller?.abort(); } catch { /* */ }
        return -1;
      }
      return 0; // headers not here yet — fx sleeps and re-polls
    }
    new DataView(memory().buffer).setUint16(statusOut, state.response.status, true);
    return 1;
  }

  function streamNext(handle: number, outPtr: number, outCap: number): number {
    const state = streams.get(handle);
    if (!state) return -1;
    const copy = (chunk: Uint8Array): number => {
      const written = chunk.subarray(0, outCap);
      bytes(outPtr, written.length).set(written);
      state.leftover = chunk.subarray(written.length);
      emit("stream.data", { handle, bytes: written.length });
      return written.length;
    };
    const consume = (): number | null => {
      if (state.leftover.length) return copy(state.leftover);
      if (state.readError) return state.readError?.name === "AbortError" ? -2 : -1;
      if (!state.readResult) return null;
      const { done, value } = state.readResult;
      state.readResult = null;
      if (done) {
        if (!state.ended) {
          state.ended = true;
          emit("stream.end", { handle });
        }
        return 0;
      }
      if (!value?.length) return null;
      return copy(value);
    };
    // Fully SYNCHRONOUS — fx paces itself with poll_oneoff sleeps between
    // polls (host_stream_provider.zig stream_poll_pace_ns), and those
    // timer-resumed suspends are the proven-safe pattern on device. Never
    // suspend from THIS import: JSPI resumes from network callbacks crash
    // the Switch's V8 (see README crash forensics).
    const immediate = consume();
    if (immediate !== null) return immediate;
    if (!state.reader) {
      if (!state.ended) {
        state.ended = true;
        emit("stream.end", { handle });
      }
      return 0;
    }
    if (!state.pendingRead) {
      state.pendingRead = state.reader.read().then((result: any) => {
        state.readResult = result;
        state.pendingRead = null;
      }).catch((error: any) => {
        state.readError = error;
        state.pendingRead = null;
      });
    }
    return -3; // read in flight — fx sleeps and re-polls
  }

  function streamClose(handle: number): void {
    const state = streams.get(handle);
    streams.delete(handle);
    // Device run 2026-08-30: aborting the controller while a reader was held
    // raised "TypeError: Cannot cancel a stream that already has a reader"
    // inside the runtime's fetch abort path, and the app never reached its
    // exit path afterwards. Cancel through the reader (the only legal owner),
    // then abort the request; swallow either failing — close must not throw.
    if (state?.reader) {
      try { state.reader.cancel().catch(() => {}); } catch { /* reader gone */ }
      state.reader = null;
    }
    try { state?.controller?.abort(); } catch { /* already settled */ }
    if (state) state.readError = state.readError ?? new Error("stream closed");
    if (state && !state.ended) {
      state.ended = true;
      emit("stream.end", { handle });
    }
  }
  // (streamClose is wired into the fx import table below as fx_http_stream_close.)

  function httpRequest(
    methodPtr: number, methodLen: number, urlPtr: number, urlLen: number,
    headersPtr: number, headersLen: number, bodyPtr: number, bodyLen: number,
    statusOut: number, responsePtr: number, responseCap: number,
  ): Promise<number> {
    const method = text(methodPtr, methodLen);
    const url = text(urlPtr, urlLen);
    emit("http.request", { method, url });
    return (options.fetch ?? fetch)(url, {
      method,
      headers: headersFromJson(headersPtr, headersLen),
      body: bodyLen ? bytes(bodyPtr, bodyLen).slice() : undefined,
    } as any).then(async (response: any) => {
      const body = new Uint8Array(await response.arrayBuffer());
      new DataView(memory().buffer).setUint16(statusOut, response.status, true);
      if (body.length > responseCap) {
        emit("http.result", { url, status: response.status, note: "body too large" });
        return -2;
      }
      bytes(responsePtr, body.length).set(body);
      emit("http.result", { url, status: response.status, bytes: body.length });
      return body.length;
    }).catch((error) => {
      emit("http.result", { url, error: String(error).slice(0, 160) });
      return -1;
    });
  }

  // ------------------------------------------------------- host workspace

  function workspaceInfo(outPtr: number, outCap: number): number {
    if (!workspace.present) return -2;
    if (!workspace.valid) return -4;
    const output = checkedBytes(outPtr, outCap);
    if (!output) return -4;
    if (workspace.encoded.length > outCap) return -3;
    output.set(workspace.encoded);
    return workspace.encoded.length;
  }

  function workspaceExec(
    commandPtr: number, commandLen: number, timeoutMs: number,
    outputPtr: number, outputCap: number, resultPtr: number,
  ): number | Promise<number> {
    if (!workspace.present) return -2;
    if (!workspace.valid) return -4;
    const commandBytes = checkedBytes(commandPtr, commandLen);
    const output = checkedBytes(outputPtr, outputCap);
    const resultBytes = checkedBytes(resultPtr, 32);
    if (!commandBytes || !output || !resultBytes || commandLen > WORKSPACE_COMMAND_LIMIT ||
      outputCap > WORKSPACE_OUTPUT_LIMIT || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30_000) return -4;

    let command: string;
    try { command = strictDecoder.decode(commandBytes); } catch { return -4; }
    if (command.includes("\0")) return -4;

    const controller = new AbortController();
    let status: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = {
      abort(code: number) {
        if (status !== null) return;
        status = code;
        controller.abort();
      },
    };
    workspaceExecs.add(state);

    const finish = (value: FxWorkspaceResult): number => {
      if (status !== null) return status;
      if (!value || !Number.isInteger(value.exitCode) ||
        value.exitCode < -0x80000000 || value.exitCode > 0x7fffffff ||
        typeof value.stdout !== "string" || typeof value.stderr !== "string") return -1;
      const stdout = encoder.encode(value.stdout);
      const stderr = encoder.encode(value.stderr);
      let stdoutCap = stdout.length;
      let stderrCap = stderr.length;
      if (stdoutCap + stderrCap > outputCap) {
        stdoutCap = Math.min(stdout.length, Math.ceil(outputCap / 2));
        stderrCap = Math.min(stderr.length, Math.floor(outputCap / 2));
        let remaining = outputCap - stdoutCap - stderrCap;
        const stdoutExtra = Math.min(remaining, stdout.length - stdoutCap);
        stdoutCap += stdoutExtra;
        remaining -= stdoutExtra;
        stderrCap += Math.min(remaining, stderr.length - stderrCap);
      }
      const utf8Prefix = (value: Uint8Array, limit: number) => {
        if (value.length <= limit) return value;
        let end = limit;
        while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
        return value.subarray(0, end);
      };
      const stdoutPreview = utf8Prefix(stdout, stdoutCap);
      const stderrPreview = utf8Prefix(stderr, stderrCap);
      output.set(stdoutPreview, 0);
      output.set(stderrPreview, stdoutPreview.length);
      const copied = stdoutPreview.length + stderrPreview.length;
      const view = new DataView(memory().buffer, resultPtr, 32);
      view.setInt32(0, value.exitCode, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, stdoutPreview.length, true);
      view.setUint32(12, stdout.length, true);
      view.setUint32(16, stdoutPreview.length, true);
      view.setUint32(20, stderrPreview.length, true);
      view.setUint32(24, stderr.length, true);
      view.setUint32(28, copied < stdout.length + stderr.length ? 1 : 0, true);
      emit("workspace.result", { command, exitCode: value.exitCode, bytes: copied });
      return 0;
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      workspaceExecs.delete(state);
    };

    try {
      const result = workspace.adapter.exec({
        command,
        cwd: workspace.info.cwd,
        signal: controller.signal,
        timeoutMs,
        outputLimitBytes: WORKSPACE_OUTPUT_LIMIT,
      });
      emit("workspace.exec", { command });
      if (!(result instanceof Promise)) {
        const code = finish(result);
        cleanup();
        return code;
      }
      timer = setTimeout(() => state.abort(-5), timeoutMs);
      return result.then(finish, () => status ?? -1).finally(cleanup);
    } catch {
      cleanup();
      return status ?? -1;
    }
  }

  // --------------------------------------------------------- config & co.

  function configGet(idPtr: number, idLen: number, outPtr: number, outCap: number): Promise<number> {
    if (!options.stores?.config?.get) return Promise.resolve(-2);
    const configId = text(idPtr, idLen);
    return Promise.resolve().then(() => options.stores!.config!.get(configId)).then((value) => {
      if (value === null || value === undefined) return -2;
      if (typeof value !== "string") throw new TypeError("configStore.get() must return a string or null");
      const encoded = encoder.encode(value);
      if (encoded.length > outCap) return -3;
      bytes(outPtr, encoded.length).set(encoded);
      emit("config.restore", { configId });
      return encoded.length;
    }).catch((error) => {
      emit("config.restore_error", { configId, error: String(error) });
      return -1;
    });
  }

  function configSet(idPtr: number, idLen: number, valuePtr: number, valueLen: number): Promise<number> {
    if (!options.stores?.config?.set) return Promise.resolve(0);
    const configId = text(idPtr, idLen);
    const value = text(valuePtr, valueLen);
    return Promise.resolve().then(() => options.stores!.config!.set(configId, value)).then(() => {
      emit("config.changed", { configId });
      return 0;
    }).catch(() => Promise.resolve(-1)).then((code) => code);
  }

  function promptHistoryLoad(
    workspacePtr: number, workspaceLen: number, limit: number, outPtr: number, outCap: number,
  ): Promise<number> {
    if (!options.stores?.promptHistory?.load) return Promise.resolve(-1);
    const workspaceRoot = text(workspacePtr, workspaceLen);
    return Promise.resolve().then(() =>
      options.stores!.promptHistory!.load(workspaceRoot, limit)).then((entries) => {
      if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string")) {
        throw new TypeError("promptHistoryStore.load() must return an array of strings");
      }
      const value = encoder.encode(JSON.stringify(entries));
      if (value.length > outCap) return -2;
      bytes(outPtr, value.length).set(value);
      return value.length;
    }).catch(() => -1);
  }

  function promptHistoryAppend(
    timestampMs: number, workspacePtr: number, workspaceLen: number, valuePtr: number, valueLen: number,
  ): Promise<number> {
    if (!options.stores?.promptHistory?.append) return Promise.resolve(-1);
    const workspaceRoot = text(workspacePtr, workspaceLen);
    const value = text(valuePtr, valueLen);
    return Promise.resolve().then(() =>
      options.stores!.promptHistory!.append(workspaceRoot, value, Number(timestampMs))).then((result) => {
      if (result === "duplicate") return 1;
      if (result === "record_too_large") return 2;
      return 0;
    }).catch(() => -1);
  }

  function promptHistoryClear(workspacePtr: number, workspaceLen: number): Promise<number> {
    if (!options.stores?.promptHistory?.clear) return Promise.resolve(-1);
    const workspaceRoot = text(workspacePtr, workspaceLen);
    return Promise.resolve().then(() => options.stores!.promptHistory!.clear(workspaceRoot)).then(() => 0)
      .catch(() => -1);
  }

  function sessionLoad(
    idPtr: number, idLen: number, outPtr: number, outCap: number,
    revisionPtr: number, revisionCap: number, revisionLenOut: number,
  ): Promise<number> {
    if (!options.stores?.session) return Promise.resolve(-1);
    return Promise.resolve().then(() => options.stores!.session!.load(text(idPtr, idLen))).then((record) => {
      if (!record) return -2;
      const value = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
      const revision = encoder.encode(record.revision);
      if (value.length > outCap || revision.length > revisionCap) return -3;
      bytes(outPtr, value.length).set(value);
      bytes(revisionPtr, revision.length).set(revision);
      writeU32(revisionLenOut, revision.length);
      return value.length;
    }).catch(() => -1);
  }

  function sessionCommit(
    idPtr: number, idLen: number, valuePtr: number, valueLen: number,
    expectedPtr: number, expectedLen: number, revisionPtr: number, revisionCap: number, revisionLenOut: number,
  ): Promise<number> {
    if (!options.stores?.session) return Promise.resolve(-1);
    const id = text(idPtr, idLen);
    const expectedRevision = expectedLen ? text(expectedPtr, expectedLen) : undefined;
    const value = bytes(valuePtr, valueLen).slice();
    return Promise.resolve().then(() =>
      options.stores!.session!.commit(id, value, expectedRevision)).then((result) => {
      const revision = encoder.encode(result.revision);
      if (revision.length > revisionCap) return -1;
      bytes(revisionPtr, revision.length).set(revision);
      writeU32(revisionLenOut, revision.length);
      return 0;
    }).catch(() => -1);
  }

  function sessionList(outPtr: number, outCap: number): Promise<number> {
    if (!options.stores?.session) return Promise.resolve(-1);
    return Promise.resolve().then(() => options.stores!.session!.list()).then((records) => {
      const value = encoder.encode(JSON.stringify(records));
      if (value.length > outCap) return -2;
      bytes(outPtr, value.length).set(value);
      return value.length;
    }).catch(() => -1);
  }

  function sessionRemove(idPtr: number, idLen: number): Promise<number> {
    if (!options.stores?.session) return Promise.resolve(-1);
    return Promise.resolve().then(() => options.stores!.session!.remove(text(idPtr, idLen))).then(() => 0)
      .catch(() => -1);
  }

  // OAuth session persistence ("Sign in with Vercel"). Return contract from
  // fx's sdk host: load -2=none -3=too-small -1=error; commit 0/-2(conflict)/-1;
  // remove 1(gone-or-missing)/0(conflict)/-1.
  function oauthSessionLoad(outPtr: number, outCap: number, revisionPtr: number, revisionCap: number, revisionLenOut: number): Promise<number> {
    if (!options.stores?.oauth?.load) return Promise.resolve(-1);
    return Promise.resolve().then(() => options.stores!.oauth!.load()).then((record) => {
      if (!record) return -2;
      const value = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
      if (typeof record.revision !== "string") return -1;
      const revision = encoder.encode(record.revision);
      if (value.length > outCap || revision.length > revisionCap) return -3;
      bytes(outPtr, value.length).set(value);
      bytes(revisionPtr, revision.length).set(revision);
      writeU32(revisionLenOut, revision.length);
      return value.length;
    }).catch(() => -1);
  }

  function oauthSessionCommit(valuePtr: number, valueLen: number, expectedPtr: number, expectedLen: number, revisionPtr: number, revisionCap: number, revisionLenOut: number): Promise<number> {
    if (!options.stores?.oauth?.commit) return Promise.resolve(-1);
    const expectedRevision = expectedLen ? text(expectedPtr, expectedLen) : undefined;
    const value = bytes(valuePtr, valueLen).slice();
    return Promise.resolve().then(() => options.stores!.oauth!.commit(value, expectedRevision)).then((result) => {
      if (typeof result?.revision !== "string") return -1;
      const revision = encoder.encode(result.revision);
      if (revision.length > revisionCap) return -1;
      bytes(revisionPtr, revision.length).set(revision);
      writeU32(revisionLenOut, revision.length);
      return 0;
    }).catch((error) => error?.code === "FX_OAUTH_SESSION_REVISION_CONFLICT" ? -2 : -1);
  }

  function oauthSessionRemove(expectedPtr: number, expectedLen: number): Promise<number> {
    if (!options.stores?.oauth?.remove) return Promise.resolve(-1);
    const expectedRevision = expectedLen ? text(expectedPtr, expectedLen) : undefined;
    return Promise.resolve().then(() => options.stores!.oauth!.remove(expectedRevision)).then((result) =>
      result === false || result === "missing" ? 1 : 0
    ).catch((error) => error?.code === "FX_OAUTH_SESSION_REVISION_CONFLICT" ? -2 : -1);
  }

  function abortHostEffects(): void {
    // The runtime's fetch throws from abort() on an in-flight request
    // ("Cannot abort a stream that already has a writer"); never let that
    // escape into the exit path.
    streams.forEach((state) => {
      try { state.reader?.cancel().catch(() => {}); } catch { /* */ }
      try { state.controller?.abort(); } catch { /* */ }
    });
    streams.clear();
    workspaceExecs.forEach((state) => state.abort(-3));
  }

  const unavailable = () => 52;

  const wasi: Record<string, any> = {
    args_sizes_get(count: number, size: number) {
      writeU32(count, args.length);
      writeU32(size, args.reduce((n, v) => n + encoder.encode(v).length + 1, 0));
      return 0;
    },
    args_get(ptrs: number, data: number) { writeVector(args, ptrs, data); return 0; },
    environ_sizes_get(count: number, size: number) {
      writeU32(count, env.length);
      writeU32(size, env.reduce((n, v) => n + encoder.encode(v).length + 1, 0));
      return 0;
    },
    environ_get(ptrs: number, data: number) { writeVector(env, ptrs, data); return 0; },
    fd_write: fdWrite,
    fd_read: new (WebAssembly as any).Suspending(fdRead),
    fd_close() { return 0; },
    fd_fdstat_get(fd: number, out: number) {
      bytes(out, 24).fill(0);
      const view = new DataView(memory().buffer);
      view.setUint8(out, fd <= 2 ? 2 : 0);
      view.setBigUint64(out + 8, 0xffffffffffffffffn, true);
      view.setBigUint64(out + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_filestat_get: unavailable,
    fd_filestat_set_size: unavailable,
    fd_filestat_set_times: unavailable,
    fd_pread: unavailable,
    fd_prestat_get() { return 8; },
    fd_prestat_dir_name: unavailable,
    fd_pwrite: unavailable,
    fd_readdir: unavailable,
    fd_seek() { return 29; },
    fd_sync() { return 0; },
    clock_res_get(_id: number, out: number) { writeU64(out, 1000000n); return 0; },
    clock_time_get(_id: number, _precision: number, out: number) {
      writeU64(out, BigInt(Date.now()) * 1000000n);
      return 0;
    },
    path_create_directory: unavailable,
    path_filestat_get: unavailable,
    path_filestat_set_times: unavailable,
    path_link: unavailable,
    path_open: unavailable,
    path_readlink: unavailable,
    path_remove_directory: unavailable,
    path_rename: unavailable,
    path_symlink: unavailable,
    path_unlink_file: unavailable,
    random_get(ptr: number, len: number) { crypto.getRandomValues(bytes(ptr, len)); return 0; },
    poll_oneoff: new (WebAssembly as any).Suspending(pollOneoff),
    proc_exit(code: number) {
      markExited(code);
      throw new WebAssembly.RuntimeError(`proc_exit(${code})`);
    },
  };

  function termPollInput(timeoutMs: number): number | Promise<number> {
    trapIfAborted();
    if (options.traceWasi) console.error("[fx] fx_term_poll_input", timeoutMs, "pending:", stdin.pending);
    hooks.onPoll();
    if (stdin.pending) return 1;
    if (stdin.closed) return -1;
    if (timeoutMs === 0) return 0;
    return stdin.wait(timeoutMs >= 0 ? timeoutMs : undefined).then(() =>
      stdin.pending ? 1 : (stdin.closed ? -1 : 0));
  }

  const fx: Record<string, any> = {
    fx_term_poll_input: new (WebAssembly as any).Suspending(termPollInput),
    fx_prompt_history_available() { return options.stores?.promptHistory ? 1 : 0; },
    fx_workspace_available() { return workspace.present ? 1 : 0; },
    fx_workspace_info: workspaceInfo,
    fx_workspace_exec: new (WebAssembly as any).Suspending(workspaceExec),
    fx_http_stream_open: streamOpen,
    fx_http_stream_status: streamStatus,
    fx_http_stream_next: streamNext,
    fx_http_stream_close: streamClose,
    fx_http_request: new (WebAssembly as any).Suspending(httpRequest),
    // No browser to hand a login URL to on a console.
    fx_open_url: () => Promise.resolve(0),
    fx_oauth_session_load: new (WebAssembly as any).Suspending(oauthSessionLoad),
    fx_oauth_session_commit: new (WebAssembly as any).Suspending(oauthSessionCommit),
    fx_oauth_session_remove: new (WebAssembly as any).Suspending(oauthSessionRemove),
    fx_config_get: new (WebAssembly as any).Suspending(configGet),
    fx_config_set: new (WebAssembly as any).Suspending(configSet),
    fx_prompt_history_load: new (WebAssembly as any).Suspending(promptHistoryLoad),
    fx_prompt_history_append: new (WebAssembly as any).Suspending(promptHistoryAppend),
    fx_prompt_history_clear: new (WebAssembly as any).Suspending(promptHistoryClear),
    fx_session_load: new (WebAssembly as any).Suspending(sessionLoad),
    fx_session_commit: new (WebAssembly as any).Suspending(sessionCommit),
    fx_session_list: new (WebAssembly as any).Suspending(sessionList),
    fx_session_remove: new (WebAssembly as any).Suspending(sessionRemove),
    fx_term_size(cols: number, rows: number) {
      const width = options.terminal.cols || 80;
      const height = options.terminal.rows || 24;
      new DataView(memory().buffer).setUint16(cols, width, true);
      new DataView(memory().buffer).setUint16(rows, height, true);
      emit("terminal.size", { cols: width, rows: height });
    },
  };

  return {
    imports: { wasi_snapshot_preview1: wasi, fx },
    exited,
    hooks,
    setInstance(value: WebAssembly.Instance) { instance = value; },
    markExited,
    write(data: string | Uint8Array) { stdin.push(typeof data === "string" ? encoder.encode(data) : data); },
    wake() { stdin.wake(); },
    closeStdin() { stdin.close(); },
    abortHostEffects,
    abort() {
      aborted = true;
      abortHostEffects();
      stdin.close();
      // Device run 2026-08-30: fx stuck in a Gateway 429 retry loop ignored
      // stdin EOF, `_start` never returned, `exited` never settled and the app
      // could not leave (no Minus/Plus). A hard stop must settle `exited`
      // even if the module stays suspended — the process is exiting anyway.
      setTimeout(() => markExited(130), 500);
      stdin.close();
      markExited(130);
    },
    get aborted() { return aborted; },
    get exitCode() { return exitCode; },
  };
}

export function supportsJspi(): boolean {
  return typeof (WebAssembly as any).Suspending === "function" &&
    typeof (WebAssembly as any).promising === "function";
}

export async function createFxTermSession(options: FxTermOptions): Promise<FxTermSession> {
  if (!supportsJspi()) {
    throw new Error(
      "JSPI unavailable in this runtime — fx-term.wasm needs WebAssembly.Suspending/promising " +
        "(V8 with stack switching; check nxjs.ini [v8] flags)",
    );
  }
  let resolveInteractive!: () => void;
  let rejectInteractive!: (e: unknown) => void;
  let interactiveScheduled = false;
  const interactive = new Promise<void>((resolve, reject) => {
    resolveInteractive = resolve;
    rejectInteractive = reject;
  });

  const runtime = createRuntime(options);
  // First input poll == the TUI is live and wants input (the interactive
  // signal fx's own sdk uses). Single Suspending wrap — never rewrap.
  let pollFired = false;
  runtime.hooks.onPoll = () => {
    if (pollFired) return;
    pollFired = true;
    interactiveScheduled = true;
    queueMicrotask(() => resolveInteractive());
  };

  emit(options.onEvent, "runtime.start");
  const module = await compileModule(options.wasm);
  const instance = await WebAssembly.instantiate(module, runtime.imports as any);
  runtime.setInstance(instance);
  const start = (WebAssembly as any).promising((instance.exports as any)._start);
  start().then(
    () => runtime.markExited(0),
    (error: unknown) => {
      // A host-initiated abort (Minus while fx is mid-retry) unwinds the
      // module with our own RuntimeError; that is the exit path working,
      // not a crash, so do not surface it as one.
      if (!String(error).includes("proc_exit") && !runtime.aborted) {
        emit(options.onEvent, "runtime.crash", { error: String(error) });
        console.error(error);
      }
      runtime.markExited(runtime.aborted ? 130 : 1);
    },
  );
  runtime.exited.then((code) => {
    if (!interactiveScheduled) {
      rejectInteractive(new Error(`fx terminal exited with code ${code} before becoming interactive`));
    }
    emit(options.onEvent, "runtime.exit", { code });
  });
  emit(options.onEvent, "runtime.ready");
  const interruptKey = "\x03";
  return {
    interactive,
    exited: runtime.exited,
    write(data) {
      if (typeof data === "string" && data.includes(interruptKey)) runtime.abortHostEffects();
      runtime.write(data);
    },
    resize() { runtime.wake(); },
    interrupt() { runtime.abortHostEffects(); runtime.write(interruptKey); },
    end() { runtime.closeStdin(); },
    abort() { runtime.abort(); },
  };
}

function emit(
  onEvent: ((type: string, detail?: Record<string, unknown>) => void) | undefined,
  type: string,
  detail: Record<string, unknown> = {},
): void {
  try { onEvent?.(type, detail); } catch { /* events never fatal */ }
}
