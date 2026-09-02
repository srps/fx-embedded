/**
 * Redirection semantics of the Switch workspace interpreter, without fx.
 * Device run 2026-09-02: a model wrote `cmd 2>&1` and the interpreter
 * created a file literally named `&1`. Every form below must behave like a
 * shell would, inside the root-confined workspace.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkspaceCommand, type WorkspaceFs } from "../src/fxwasm/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "fx-embedded-redirect-"));
const toHost = (path: string) => join(root, path.replace(/^sdmc:\/?/, ""));
const fs: WorkspaceFs = {
  mkdirSync(path) { mkdirSync(toHost(path), { recursive: true }); },
  readDirSync(path) { return readdirSync(toHost(path)); },
  readFileSync(path) { try { return new Uint8Array(readFileSync(toHost(path))); } catch { return null; } },
  writeFileSync(path, data) { mkdirSync(dirname(toHost(path)), { recursive: true }); writeFileSync(toHost(path), typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)); },
  appendFileSync(path, data) { mkdirSync(dirname(toHost(path)), { recursive: true }); appendFileSync(toHost(path), typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)); },
  removeSync(path) { rmSync(toHost(path), { recursive: true, force: true }); },
  renameSync(path, dest) { renameSync(toHost(path), toHost(dest)); },
  statSync(path) { try { const s = statSync(toHost(path)); return { mode: s.mode, size: s.size }; } catch { return null; } },
};
mkdirSync(toHost("sdmc:/switch/fx-embedded/workspace"), { recursive: true });
const ws = (name: string) => toHost(`sdmc:/switch/fx-embedded/workspace/${name}`);
const files = () => readdirSync(ws("")).sort();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

// 1. stdout to file, stderr to stdout: no file named "&1" may appear.
let r = runWorkspaceCommand(fs, "echo hi 2>&1 > out.txt");
check("2>&1 with > file writes the file", readFileSync(ws("out.txt"), "utf8") === "hi\n", JSON.stringify(r));
check("no file named &1", !files().includes("&1"), files().join(","));

// 2. 2>&1 alone merges stderr into stdout.
r = runWorkspaceCommand(fs, "cat missing.txt 2>&1");
check("2>&1 merges stderr into stdout", r.stderr === "" && r.stdout.includes("missing.txt"), JSON.stringify(r));

// 3. 2>/dev/null drops stderr even on failure.
r = runWorkspaceCommand(fs, "cat missing.txt 2>/dev/null");
check("2>/dev/null drops stderr", r.stderr === "" && r.exitCode !== 0, JSON.stringify(r));
check("no /dev or null file created", !files().includes("dev") && !files().includes("null"), files().join(","));

// 4. >&2 sends stdout to stderr.
r = runWorkspaceCommand(fs, "echo warn >&2");
check(">&2 moves stdout to stderr", r.stdout === "" && r.stderr === "warn\n", JSON.stringify(r));

// 5. &> writes both streams.
r = runWorkspaceCommand(fs, "cat missing.txt &> both.txt; echo ok &>> both.txt");
check("&> and &>> append both streams", readFileSync(ws("both.txt"), "utf8").endsWith("ok\n"), readFileSync(ws("both.txt"), "utf8"));

// 6. Plain > and >> still work; a failed command creates no file.
runWorkspaceCommand(fs, "echo a > plain.txt && echo b >> plain.txt");
check("> then >> accumulate", readFileSync(ws("plain.txt"), "utf8") === "a\nb\n");
r = runWorkspaceCommand(fs, "cat missing.txt > never.txt");
check("failed command does not create the target", !files().includes("never.txt"), files().join(","));

// 7. A digit that is part of an argument is not a descriptor.
r = runWorkspaceCommand(fs, "echo 2 > two.txt");
check("`echo 2 > f` writes the 2", readFileSync(ws("two.txt"), "utf8") === "2\n", JSON.stringify(r));
r = runWorkspaceCommand(fs, "echo a2> notfd.txt");
check("`a2>` is a word, not fd 2", readFileSync(ws("notfd.txt"), "utf8") === "a2\n", JSON.stringify(r));

// 8. Missing target is an error, not a file named after the operator.
r = runWorkspaceCommand(fs, "echo x >");
check("bare > is a parse error", r.exitCode !== 0 && /needs a file/.test(r.stderr), JSON.stringify(r));

rmSync(root, { recursive: true, force: true });
console.log(failures ? `workspace-redirect-test: ${failures} FAILED` : "workspace-redirect-test: OK");
process.exit(failures ? 1 : 0);
