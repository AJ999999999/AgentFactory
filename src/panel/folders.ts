// The folders the panel looks in when it isn't told. Each `harness open` adds the folder
// it ran in, so engagements for different projects, opened in different folders, all
// show up in one panel without anyone keeping a list by hand.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// AF_PANEL_FOLDERS points somewhere else, for tests and for a second setup on one PC.
export function foldersFile(): string {
  return process.env.AF_PANEL_FOLDERS || path.join(os.homedir(), ".af", "panel-folders.json");
}

export function readFolders(file = foldersFile()): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { folders?: unknown };
    return Array.isArray(v.folders) ? v.folders.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
  } catch {
    return [];
  }
}

// Best effort: a list that can't be written costs only the convenience, never the open.
export function rememberFolder(dir: string, file = foldersFile()): void {
  try {
    const all = readFolders(file);
    const abs = path.resolve(dir);
    if (all.some((f) => samePath(f, abs))) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ folders: [...all, abs] }, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    /* see above */
  }
}

// Windows paths differ only in case and slashes more often than not.
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

// The folders to show: the ones asked for, or this one plus the remembered ones. A
// remembered folder that's gone (moved, deleted) is skipped, not an error.
export function panelFolders(asked: string[], cwd: string, file = foldersFile()): string[] {
  const all = asked.length ? asked.map((d) => path.resolve(d)) : [path.resolve(cwd), ...readFolders(file).filter((d) => fs.existsSync(path.join(d, ".af", "harness")))];
  const out: string[] = [];
  for (const d of all) if (!out.some((x) => samePath(x, d))) out.push(d);
  return out;
}
