import type { FxWorkspaceAdapter, FxWorkspaceResult } from "./runtime.js";

const VIRTUAL_ROOT = "/workspace";
const PHYSICAL_ROOT = "sdmc:/switch/fx-embedded/workspace";
const MAX_FILE_READ_BYTES = 256 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface WorkspaceFs {
  mkdirSync(path: string, mode?: number): unknown;
  readDirSync(path: string): string[];
  readFileSync(path: string): ArrayBuffer | Uint8Array | null;
  writeFileSync(path: string, data: string | ArrayBuffer | Uint8Array): unknown;
  appendFileSync(path: string, data: string | ArrayBuffer | Uint8Array): unknown;
  removeSync(path: string): unknown;
  renameSync(path: string, dest: string): unknown;
  statSync(path: string): { mode: number; size: number } | null;
  commitDeviceSync?(device: string): unknown;
}

type CommandResult = FxWorkspaceResult;
type Separator = "&&" | ";";

function result(exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (token.length) tokens.push(token);
    token = "";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (escaped) {
      token += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      if (ch === "\n") tokens.push(";");
      continue;
    }
    if (ch === ";") {
      push();
      tokens.push(";");
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      push();
      tokens.push("&&");
      i += 1;
      continue;
    }
    if (ch === "&" && source[i + 1] === ">") {
      // &>file: both streams to the file.
      push();
      tokens.push(source[i + 2] === ">" ? "&>>" : "&>");
      i += source[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (ch === ">") {
      // Redirections carry their descriptor: `>` and `2>` become "1>" /
      // "2>", and `2>&1` / `>&2` become one token so "&1" is never a path.
      let fd = "1";
      if ((token === "1" || token === "2") && (i - token.length === 0 || /\s/.test(source[i - token.length - 1]!))) {
        fd = token;
        token = "";
      }
      push();
      let op = `${fd}>`;
      if (source[i + 1] === ">") {
        op += ">";
        i += 1;
      }
      if (source[i + 1] === "&" && (source[i + 2] === "1" || source[i + 2] === "2")) {
        op += `&${source[i + 2]}`;
        i += 2;
      }
      tokens.push(op);
      continue;
    }
    if (ch === "|") {
      push();
      tokens.push("|");
      continue;
    }
    token += ch;
  }
  if (escaped || quote) throw new Error("unterminated quote or escape");
  push();
  return tokens;
}

function splitCommands(tokens: string[]): { argv: string[]; after: Separator | null }[] {
  const commands: { argv: string[]; after: Separator | null }[] = [];
  let argv: string[] = [];
  for (const token of tokens) {
    if (token === "&&" || token === ";") {
      if (argv.length) commands.push({ argv, after: token });
      argv = [];
    } else argv.push(token);
  }
  if (argv.length) commands.push({ argv, after: null });
  return commands;
}

function virtualPath(input = "."): string {
  if (input.includes("\\") || input.includes("\0") || input.includes(":")) {
    throw new Error(`invalid workspace path: ${input}`);
  }
  let raw = input === "~" ? VIRTUAL_ROOT : input;
  if (raw.startsWith("~/")) raw = `${VIRTUAL_ROOT}/${raw.slice(2)}`;
  if (!raw.startsWith("/")) raw = `${VIRTUAL_ROOT}/${raw}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length <= 1) throw new Error(`path escapes ${VIRTUAL_ROOT}: ${input}`);
      parts.pop();
    } else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== VIRTUAL_ROOT && !normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
    throw new Error(`path outside ${VIRTUAL_ROOT}: ${input}`);
  }
  return normalized;
}

function physicalPath(input = "."): string {
  const value = virtualPath(input);
  return value === VIRTUAL_ROOT ? PHYSICAL_ROOT : `${PHYSICAL_ROOT}/${value.slice(VIRTUAL_ROOT.length + 1)}`;
}

function isDirectory(stat: { mode: number } | null): boolean {
  return !!stat && (stat.mode & 0o170000) === 0o040000;
}

function readText(fs: WorkspaceFs, path: string): string {
  const stat = fs.statSync(physicalPath(path));
  if (!stat) throw new Error(`file not found: ${path}`);
  if (isDirectory(stat)) throw new Error(`is a directory: ${path}`);
  if (stat.size > MAX_FILE_READ_BYTES) {
    throw new Error(`file exceeds ${MAX_FILE_READ_BYTES} byte workspace read limit: ${path}`);
  }
  const data = fs.readFileSync(physicalPath(path));
  if (data === null) throw new Error(`file not found: ${path}`);
  return decoder.decode(data instanceof Uint8Array ? data : new Uint8Array(data));
}

function listFiles(fs: WorkspaceFs, path: string, maxDepth = 16): string[] {
  const root = virtualPath(path);
  const files: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > maxDepth || files.length >= 512) return;
    const stat = fs.statSync(physicalPath(current));
    if (!isDirectory(stat)) {
      files.push(current);
      return;
    }
    const entries = fs.readDirSync(physicalPath(current)).slice().sort();
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      walk(current === VIRTUAL_ROOT ? `${current}/${name}` : `${current}/${name}`, depth + 1);
      if (files.length >= 512) return;
    }
  };
  walk(root, 0);
  return files;
}

function displayPath(path: string): string {
  const value = virtualPath(path);
  return value === VIRTUAL_ROOT ? "." : value.slice(VIRTUAL_ROOT.length + 1);
}

interface FileRedirect { append: boolean; path: string }
interface Redirections {
  stdout: FileRedirect | null;
  stderr: FileRedirect | null;
  /** 2>&1 */
  stderrToStdout: boolean;
  /** >&2 */
  stdoutToStderr: boolean;
}

const REDIRECT_OP = /^(1>>|1>|2>>|2>|&>>|&>)$/;
const DUP_OP = /^([12])>>?&([12])$/;

function parseRedirection(argv: string[]): { argv: string[]; redirect: Redirections | null } {
  const rest: string[] = [];
  const redirect: Redirections = { stdout: null, stderr: null, stderrToStdout: false, stdoutToStderr: false };
  let any = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const dup = DUP_OP.exec(token);
    if (dup) {
      any = true;
      if (dup[1] === "2" && dup[2] === "1") redirect.stderrToStdout = true;
      else if (dup[1] === "1" && dup[2] === "2") redirect.stdoutToStderr = true;
      continue;
    }
    if (REDIRECT_OP.test(token)) {
      const path = argv[i + 1];
      if (path === undefined || REDIRECT_OP.test(path) || DUP_OP.test(path)) {
        throw new Error(`redirection ${token} needs a file`);
      }
      any = true;
      const target = { append: token.endsWith(">>"), path };
      if (token.startsWith("2")) redirect.stderr = target;
      else if (token.startsWith("&")) { redirect.stdout = target; redirect.stderr = target; }
      else redirect.stdout = target;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  return { argv: rest, redirect: any ? redirect : null };
}

function writeRedirect(fs: WorkspaceFs, target: FileRedirect, data: string): void {
  if (target.path === "/dev/null") return;
  const path = physicalPath(target.path);
  if (target.append) fs.appendFileSync(path, data);
  else fs.writeFileSync(path, data);
}

function runOne(fs: WorkspaceFs, rawArgv: string[]): CommandResult {
  if (rawArgv.includes("|")) return result(2, "", "pipelines are not supported by the Switch workspace\n");
  let parsed: ReturnType<typeof parseRedirection>;
  try { parsed = parseRedirection(rawArgv); } catch (error) {
    return result(2, "", `${(error as Error).message}\n`);
  }
  const [command, ...args] = parsed.argv;
  if (!command) return result();

  let value: CommandResult;
  try {
    switch (command) {
      case "help":
        value = result(0,
          "Switch workspace commands: pwd ls find cat head wc rg echo printf mkdir touch cp mv rm stat help\n");
        break;
      case "pwd":
        value = result(0, `${VIRTUAL_ROOT}\n`);
        break;
      case "ls": {
        const paths = args.filter((arg) => !arg.startsWith("-"));
        const target = paths[0] ?? ".";
        const stat = fs.statSync(physicalPath(target));
        if (!stat) throw new Error(`not found: ${target}`);
        if (!isDirectory(stat)) value = result(0, `${displayPath(target)}\n`);
        else {
          const long = args.some((arg) => arg.includes("l"));
          const lines = fs.readDirSync(physicalPath(target)).slice().sort().map((name) => {
            if (!long) return name;
            const child = target === "." ? name : `${target}/${name}`;
            const childStat = fs.statSync(physicalPath(child));
            return `${isDirectory(childStat) ? "d" : "-"} ${String(childStat?.size ?? 0).padStart(8)} ${name}`;
          });
          value = result(0, lines.length ? `${lines.join("\n")}\n` : "");
        }
        break;
      }
      case "cat": {
        if (!args.length) throw new Error("cat requires a file");
        value = result(0, args.map((path) => readText(fs, path)).join(""));
        break;
      }
      case "head": {
        let count = 10;
        const paths: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-n") count = Number(args[++i]);
          else paths.push(args[i]!);
        }
        if (!paths[0] || !Number.isInteger(count) || count < 0) throw new Error("usage: head [-n count] file");
        const lines = readText(fs, paths[0]).split("\n").slice(0, count).join("\n");
        value = result(0, `${lines}${lines ? "\n" : ""}`);
        break;
      }
      case "wc": {
        const paths = args.filter((arg) => !arg.startsWith("-"));
        if (!paths[0]) throw new Error("wc requires a file");
        const text = readText(fs, paths[0]);
        if (args.includes("-c")) value = result(0, `${new TextEncoder().encode(text).length} ${paths[0]}\n`);
        else value = result(0, `${text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0} ${paths[0]}\n`);
        break;
      }
      case "echo":
        value = result(0, `${args.join(" ")}\n`);
        break;
      case "printf": {
        const format = args.shift() ?? "";
        let index = 0;
        const rendered = format.replace(/%s|%d|%%/g, (match) => {
          if (match === "%%") return "%";
          return args[index++] ?? "";
        }).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        value = result(0, rendered);
        break;
      }
      case "mkdir": {
        const paths = args.filter((arg) => arg !== "-p");
        if (!paths.length) throw new Error("mkdir requires a path");
        for (const path of paths) fs.mkdirSync(physicalPath(path), 0o777);
        value = result();
        break;
      }
      case "touch": {
        if (!args.length) throw new Error("touch requires a path");
        for (const path of args) {
          const physical = physicalPath(path);
          if (!fs.statSync(physical)) fs.writeFileSync(physical, "");
        }
        value = result();
        break;
      }
      case "cp": {
        if (args.length !== 2) throw new Error("usage: cp source destination");
        const data = fs.readFileSync(physicalPath(args[0]!));
        if (data === null) throw new Error(`file not found: ${args[0]}`);
        fs.writeFileSync(physicalPath(args[1]!), data);
        value = result();
        break;
      }
      case "mv": {
        if (args.length !== 2) throw new Error("usage: mv source destination");
        fs.renameSync(physicalPath(args[0]!), physicalPath(args[1]!));
        value = result();
        break;
      }
      case "rm": {
        const paths = args.filter((arg) => !arg.startsWith("-"));
        if (!paths.length) throw new Error("rm requires a path");
        for (const path of paths) fs.removeSync(physicalPath(path));
        value = result();
        break;
      }
      case "stat": {
        if (!args[0]) throw new Error("stat requires a path");
        const stat = fs.statSync(physicalPath(args[0]));
        if (!stat) throw new Error(`not found: ${args[0]}`);
        value = result(0, `${isDirectory(stat) ? "directory" : "file"} ${stat.size} ${virtualPath(args[0])}\n`);
        break;
      }
      case "find": {
        const target = args.find((arg) => !arg.startsWith("-")) ?? ".";
        const entries = listFiles(fs, target).map(displayPath);
        value = result(0, entries.length ? `${entries.join("\n")}\n` : "");
        break;
      }
      case "rg": {
        if (args.includes("--files")) {
          const target = args.find((arg) => !arg.startsWith("-")) ?? ".";
          const entries = listFiles(fs, target).map(displayPath);
          value = result(0, entries.length ? `${entries.join("\n")}\n` : "");
          break;
        }
        const positional = args.filter((arg) => !arg.startsWith("-"));
        if (!positional[0]) throw new Error("usage: rg pattern [path]");
        const pattern = positional[0];
        const target = positional[1] ?? ".";
        const matches: string[] = [];
        for (const file of listFiles(fs, target)) {
          const stat = fs.statSync(physicalPath(file));
          if (!stat || isDirectory(stat) || stat.size > 256 * 1024) continue;
          const lines = readText(fs, file).split("\n");
          lines.forEach((line, index) => {
            if (line.includes(pattern!)) matches.push(`${displayPath(file)}:${index + 1}:${line}`);
          });
        }
        value = result(matches.length ? 0 : 1, matches.length ? `${matches.join("\n")}\n` : "");
        break;
      }
      default:
        value = result(127, "", `${command}: unsupported in the Switch workspace; run help\n`);
    }
  } catch (error) {
    value = result(1, "", `${command}: ${(error as Error).message}\n`);
  }

  const redirect = parsed.redirect;
  if (redirect) {
    if (redirect.stderrToStdout) {
      value.stdout += value.stderr;
      value.stderr = "";
    } else if (redirect.stdoutToStderr) {
      value.stderr += value.stdout;
      value.stdout = "";
    }
    // Files are only written for successful commands (a failed `cat > out`
    // must not leave an empty file behind); /dev/null always swallows.
    let wrote = false;
    if (redirect.stdout && redirect.stderr && redirect.stdout === redirect.stderr) {
      if (value.exitCode === 0 || redirect.stdout.path === "/dev/null") {
        writeRedirect(fs, redirect.stdout, value.stdout + value.stderr);
        value.stdout = "";
        value.stderr = "";
        wrote = true;
      }
    } else {
      if (redirect.stdout && (value.exitCode === 0 || redirect.stdout.path === "/dev/null")) {
        writeRedirect(fs, redirect.stdout, value.stdout);
        value.stdout = "";
        wrote = true;
      }
      if (redirect.stderr && (value.exitCode === 0 || redirect.stderr.path === "/dev/null")) {
        writeRedirect(fs, redirect.stderr, value.stderr);
        value.stderr = "";
        wrote = true;
      }
    }
    if (wrote) {
      try { fs.commitDeviceSync?.("sdmc"); } catch { /* durability is best effort */ }
    }
  }
  return value;
}

export function runWorkspaceCommand(fs: WorkspaceFs, command: string): FxWorkspaceResult {
  let tokens: string[];
  try { tokens = tokenize(command); } catch (error) {
    return result(2, "", `parse error: ${(error as Error).message}\n`);
  }
  const commands = splitCommands(tokens);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let previousSeparator: Separator | null = null;
  for (const entry of commands) {
    if (previousSeparator === "&&" && exitCode !== 0) {
      previousSeparator = entry.after;
      continue;
    }
    const current = runOne(fs, entry.argv);
    stdout += current.stdout;
    stderr += current.stderr;
    exitCode = current.exitCode;
    previousSeparator = entry.after;
  }
  return { exitCode, stdout, stderr };
}

export function createSwitchWorkspace(fs: WorkspaceFs = (globalThis as any).Switch): FxWorkspaceAdapter {
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new Error("Switch filesystem APIs are unavailable");
  }
  fs.mkdirSync(PHYSICAL_ROOT, 0o777);
  return {
    info: {
      version: 1,
      root: VIRTUAL_ROOT,
      cwd: VIRTUAL_ROOT,
      home: VIRTUAL_ROOT,
      gitAvailable: false,
      ephemeral: true,
    },
    permission: "allow-sandboxed",
    exec({ command, signal }) {
      if (signal.aborted) throw new DOMException("workspace command aborted", "AbortError");
      const value = runWorkspaceCommand(fs, command);
      // One explicit durability boundary per tool call also covers mutations
      // such as touch/cp/mv/rm that do not use output redirection.
      try { fs.commitDeviceSync?.("sdmc"); } catch { /* best effort on old runtimes */ }
      return value;
    },
  };
}
