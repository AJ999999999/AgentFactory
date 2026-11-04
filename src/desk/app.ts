// The desk as an app of its own rather than a tab: a window with no address bar or tabs,
// its own taskbar button and a Start menu shortcut with a key to bring it up. The window is
// Edge's (or Chrome's) app mode, which every Windows PC already has, so there's nothing to
// install and nothing for a company's app policy to refuse. The page is the same one.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pageFile, readJson } from "./hold.ts";

// The Chromium-based browsers that can open a page as an app window, most likely first.
export function appBrowsers(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter((x): x is string => !!x);
    return [
      ...roots.map((r) => path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin")
    return ["Microsoft Edge", "Google Chrome", "Chromium"].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`);
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return ["microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((b) => dirs.map((d) => path.join(d, b)));
}

export const findAppBrowser = (candidates = appBrowsers()): string | undefined => candidates.find((f) => fs.existsSync(f));

// Opens the desk in its own window, or in a tab of the default browser when no browser
// with an app mode is found (or you asked for a tab). Says which.
export function openApp(url: string, opts: { tab?: boolean; log?: (l: string) => void } = {}): "window" | "tab" | "none" {
  const log = opts.log ?? console.log;
  const browser = opts.tab ? undefined : findAppBrowser();
  const [cmd, args] = browser
    ? [browser, [`--app=${url}`]]
    : process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    // A fixed URL and no shell.
    const p = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: false });
    p.on("error", () => log(`open ${url} in your browser`));
    p.unref();
    return browser ? "window" : "tab";
  } catch {
    log(`open ${url} in your browser`);
    return "none";
  }
}

// The desk that's running now, from its beat in page.json: its address, if it beat in the
// last 15 seconds and its process is alive.
export function runningDesk(home: string, now = Date.now()): { url: string; pid: number } | undefined {
  const p = readJson<{ at?: number; pid?: number; url?: string }>(pageFile(home), {});
  if (!p.url || !p.pid || !p.at || now - p.at > 15_000) return undefined;
  try {
    process.kill(p.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return { url: p.url, pid: p.pid };
}

const CLI = path.join(import.meta.dirname, "cli.ts");

// Starts the desk with no window of its own (its log goes to desk.log), waits for it to
// beat, and returns where it is. Its terminals live in the keeper, so a desk nobody can
// see is safe to stop and start again.
export async function startInBackground(home: string, extra: string[] = [], timeoutMs = 15_000): Promise<{ url: string; pid: number }> {
  fs.mkdirSync(home, { recursive: true });
  const out = fs.openSync(path.join(home, "desk.log"), "a");
  const p = spawn(process.execPath, ["--no-warnings", CLI, "--no-open", ...extra], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  p.unref();
  fs.closeSync(out);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = runningDesk(home);
    if (d && d.pid === p.pid) return d;
    if (Date.now() > end) throw new Error(`the desk didn't start; see ${path.join(home, "desk.log")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A Start menu entry that starts the desk in the background and opens its window, with a
// key that brings it up from anywhere (Windows honours a shortcut's key for shortcuts in
// the Start menu). PowerShell writes it through Windows' own shell object.
export function shortcutScript(opts: { node: string; cli: string; key: string; folder: string; icon?: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(path.win32.join(opts.folder, "AgentFactory desk.lnk"))})`,
    `$s.TargetPath = ${q(opts.node)}`,
    `$s.Arguments = ${q(`--no-warnings "${opts.cli}" app`)}`,
    `$s.WorkingDirectory = ${q(path.win32.dirname(opts.cli))}`,
    `$s.WindowStyle = 7`,
    `$s.Hotkey = ${q(opts.key)}`,
    `$s.Description = 'Every Copilot terminal as a thread'`,
    ...(opts.icon ? [`$s.IconLocation = ${q(opts.icon)}`] : []),
    `$s.Save()`,
  ].join("; ");
}

export function startMenuFolder(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
}

// The window's icon, for the page, the installed app and the shortcut: the desk's mark,
// two terminals side by side.
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#13242c"/><rect x="9" y="14" width="21" height="36" rx="4" fill="#1d3a46"/><rect x="34" y="14" width="21" height="36" rx="4" fill="#1d3a46"/><path d="M14 24l5 4-5 4" fill="none" stroke="#7fd1b9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M39 24l5 4-5 4" fill="none" stroke="#f3c969" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 38h5M46 38h5" stroke="#9fb0bb" stroke-width="3" stroke-linecap="round"/></svg>`;

export const MANIFEST = JSON.stringify({
  name: "AgentFactory desk",
  short_name: "Desk",
  description: "Every Copilot terminal as a thread",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0f1d23",
  theme_color: "#13242c",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});
