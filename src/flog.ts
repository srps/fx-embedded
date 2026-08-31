/**
 * Durable append-only logs on SD. The fixed file preserves the old workflow;
 * a unique per-boot file avoids stale MTP/DBI reads and makes crash runs easy
 * to correlate and copy independently.
 *
 * Uses Switch.appendFileSync (synchronous): a WritableStream writer's queued
 * chunks are lost when the app is killed without a clean close, which is how
 * we ended up with 0-byte logs. Synchronous appends survive hard exits.
 * All errors are swallowed — if the FS is unavailable, screen logging works.
 */

const LOG_DIR = "sdmc:/switch/fx-embedded/logs";
export const flogPath = `${LOG_DIR}/fx-embedded-${Date.now()}.log`;
let logDirReady = false;

export function flog(line: string): void {
  try {
    const runtime = (globalThis as any).Switch;
    if (!runtime?.appendFileSync) return;
    if (!logDirReady) {
      try { runtime.mkdirSync?.(LOG_DIR, 0o777); } catch { /* may already exist */ }
      logDirReady = true;
    }
    // Epoch-seconds prefix so app lines can be correlated with the runtime's
    // `t=` breadcrumbs (frame gaps, wake resets).
    const bytes = `${Math.floor(Date.now() / 1000)} ${line}\n`;
    let wrote = false;
    try {
      runtime.appendFileSync("sdmc:/switch/fx-embedded.log", bytes);
      wrote = true;
    } catch { /* unique log may still work */ }
    try {
      runtime.appendFileSync(flogPath, bytes);
      wrote = true;
    } catch { /* aggregate log may still work */ }
    // A hard process abort can happen before the filesystem service commits
    // recently closed files. Patched nx.js exposes the libnx primitive;
    // older runtimes simply keep the previous append-and-close behavior.
    if (wrote) runtime.commitDeviceSync?.("sdmc");
  } catch {
    /* no filesystem; screen only */
  }
}
