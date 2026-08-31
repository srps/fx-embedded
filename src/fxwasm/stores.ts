/**
 * SD-backed stores for the embedded fx terminal (config / prompt history /
 * fx sessions), matching the store contracts of fx's sdk host layer.
 *
 * Everything lives under sdmc:/switch/fx-embedded/term/ — plain JSON files
 * plus one file per session (name embeds the revision, so commit-conflict
 * detection is a filename compare; no read-modify-write races on device).
 *
 * All Switch fs calls are the SYNC variants (native, no threadpool hop) and
 * every method is failure-tolerant: a missing/corrupt file degrades to
 * "empty", never to a crashed terminal.
 */

const ROOT = "sdmc:/switch/fx-embedded/term";
const CONFIG_FILE = `${ROOT}/config.json`;
const HISTORY_FILE = `${ROOT}/history.json`;
const SESSIONS_DIR = `${ROOT}/sessions`;
const OAUTH_FILE = `${ROOT}/oauth-session.json`;

const SW: any = (globalThis as any).Switch;

function readJson<T>(path: string, fallback: T): T {
  try {
    const buf = SW.readFileSync(path);
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): boolean {
  try {
    SW.writeFileSync(path, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function ensureDirs(): void {
  try { SW.mkdirSync(ROOT); } catch { /* exists */ }
  try { SW.mkdirSync(SESSIONS_DIR); } catch { /* exists */ }
}

/** fx config ids -> string values (model, theme, ...) — persisted on SD. */
export function createConfigStore() {
  ensureDirs();
  return {
    async get(id: string): Promise<string | null> {
      const map = readJson<Record<string, string>>(CONFIG_FILE, {});
      return map[id] ?? null;
    },
    async set(id: string, value: string): Promise<void> {
      const map = readJson<Record<string, string>>(CONFIG_FILE, {});
      map[id] = value;
      writeJson(CONFIG_FILE, map);
    },
  };
}

const HISTORY_CAP = 100;

/** Per-workspace prompt history (up-arrow recall inside fx). */
export function createPromptHistoryStore() {
  ensureDirs();
  return {
    async load(workspaceRoot: string, limit: number): Promise<string[]> {
      const all = readJson<Record<string, string[]>>(HISTORY_FILE, {});
      return (all[workspaceRoot] ?? []).slice(-limit);
    },
    async append(
      workspaceRoot: string,
      value: string,
    ): Promise<"ok" | "duplicate" | "record_too_large"> {
      if (value.length > 16 * 1024) return "record_too_large";
      const all = readJson<Record<string, string[]>>(HISTORY_FILE, {});
      const values = all[workspaceRoot] ?? [];
      if (values[values.length - 1] === value) return "duplicate";
      values.push(value);
      all[workspaceRoot] = values.slice(-HISTORY_CAP);
      writeJson(HISTORY_FILE, all);
      return "ok";
    },
    async clear(workspaceRoot: string): Promise<void> {
      const all = readJson<Record<string, string[]>>(HISTORY_FILE, {});
      delete all[workspaceRoot];
      writeJson(HISTORY_FILE, all);
    },
  };
}

const safeId = (id: string) => {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length > 80 ? clean.slice(0, 80) : clean;
};

/**
 * fx session persistence for resume across app restarts. One file per
 * session: `<safeId>__<revision>.fxs`. Revision conflicts (two writers, e.g.
 * a stale app instance) resolve by filename compare, never by overwrite.
 */
export function createSessionStore() {
  ensureDirs();
  const listFiles = (): { file: string; id: string; revision: string }[] => {
    try {
      const out: { file: string; id: string; revision: string }[] = [];
      for (const entry of SW.readDirSync(SESSIONS_DIR) as Iterable<any>) {
        const name = entry?.name ?? String(entry);
        const m = /^(.+)__([^_]+(?:_[^_]+)*)\.fxs$/.exec(name);
        if (m) out.push({ file: name, id: m[1]!, revision: m[2]! });
      }
      return out;
    } catch {
      return [];
    }
  };

  return {
    async load(id: string): Promise<{ bytes: Uint8Array; revision: string } | null> {
      const key = safeId(id);
      const hit = listFiles().find((f) => f.id === key);
      if (!hit) return null;
      try {
        const buf = SW.readFileSync(`${SESSIONS_DIR}/${hit.file}`);
        return { bytes: new Uint8Array(buf), revision: hit.revision };
      } catch {
        return null;
      }
    },
    async commit(
      id: string,
      bytes: Uint8Array,
      expected?: string,
    ): Promise<{ revision: string }> {
      const key = safeId(id);
      const hit = listFiles().find((f) => f.id === key);
      if (hit && expected !== undefined && hit.revision !== expected) {
        const error: any = new Error("session revision conflict");
        error.code = "FX_SESSION_REVISION_CONFLICT";
        throw error;
      }
      const revision = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const next = `${key}__${revision}.fxs`;
      SW.writeFileSync(`${SESSIONS_DIR}/${next}`, bytes);
      if (hit) {
        try { SW.removeSync(`${SESSIONS_DIR}/${hit.file}`); } catch { /* best effort */ }
      }
      return { revision };
    },
    async list(): Promise<{ id: string; updatedAtMs: number }[]> {
      return listFiles().map((f) => {
        let updatedAtMs = 0;
        try {
          updatedAtMs = Number((SW.statSync(`${SESSIONS_DIR}/${f.file}`) as any)?.mtime ?? 0);
        } catch { /* stat optional */ }
        return { id: f.id, updatedAtMs };
      });
    },
    async remove(id: string): Promise<void> {
      const key = safeId(id);
      for (const hit of listFiles().filter((f) => f.id === key)) {
        try { SW.removeSync(`${SESSIONS_DIR}/${hit.file}`); } catch { /* best effort */ }
      }
    },
  };
}

// Dependency-free base64 (no atob/btoa reliance in SD persistence).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    if (b1 === undefined) {
      out += B64[(b0 & 3) << 4] + "==";
    } else if (b2 === undefined) {
      out += B64[(b0 & 3) << 4 | (b1 >> 4)] + B64[(b1 & 15) << 2] + "=";
    } else {
      out += B64[(b0 & 3) << 4 | (b1 >> 4)] + B64[(b1 & 15) << 2 | (b2 >> 6)] + B64[b2 & 63];
    }
  }
  return out;
}
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const out = new Uint8Array(Math.floor(len / 4) * 3);
  const val = (ch: string | undefined): number =>
    ch === undefined || ch === "=" ? 0 : B64.indexOf(ch);
  let o = 0;
  for (let i = 0; i + 3 < len; i += 4) {
    const n = (val(clean[i]) << 18) | (val(clean[i + 1]) << 12) |
      (val(clean[i + 2]) << 6) | val(clean[i + 3]);
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length && clean[i + 2] !== "=") out[o++] = (n >> 8) & 0xff;
    if (o < out.length && clean[i + 3] !== "=") out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

/**
 * OAuth session persistence ("Sign in with Vercel"). One file holding
 * {revision, bytesBase64}; commit conflicts are revision compares. Without
 * this, fx gets tokens from the device flow and then can't save them —
 * every app restart would demand a fresh sign-in.
 */
export function createOAuthSessionStore() {
  ensureDirs();
  const read = (): { revision: string; bytesBase64: string } | null =>
    readJson(OAUTH_FILE, null as any);

  return {
    async load(): Promise<{ bytes: Uint8Array; revision: string } | null> {
      const record = read();
      if (!record || typeof record.bytesBase64 !== "string" || typeof record.revision !== "string") {
        return null;
      }
      try {
        return { bytes: base64ToBytes(record.bytesBase64), revision: record.revision };
      } catch {
        return null;
      }
    },
    async commit(bytes: Uint8Array, expected?: string): Promise<{ revision: string }> {
      const record = read();
      if (record && expected !== undefined && record.revision !== expected) {
        const error: any = new Error("oauth session revision conflict");
        error.code = "FX_OAUTH_SESSION_REVISION_CONFLICT";
        throw error;
      }
      const revision = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      writeJson(OAUTH_FILE, { revision, bytesBase64: bytesToBase64(bytes) });
      return { revision };
    },
    async remove(expected?: string): Promise<boolean | "missing"> {
      const record = read();
      if (!record) return "missing";
      if (expected !== undefined && record.revision !== expected) return false;
      try { SW.removeSync(OAUTH_FILE); } catch { /* best effort */ }
      return true;
    },
  };
}

/** Everything at once, guarded — TermSession takes a single stores object. */
export function createSwitchStores() {
  return {
    config: createConfigStore(),
    promptHistory: createPromptHistoryStore(),
    session: createSessionStore(),
    oauth: createOAuthSessionStore(),
  };
}
