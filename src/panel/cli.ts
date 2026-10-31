// The partner's panel, on this PC.
//
//   npm run panel                     every engagement opened here, and in every folder
//                                     `harness open` has run in (listed in ~/.af/panel-folders.json)
//   npm run panel -- --dir <folder>   only that folder; repeat --dir for several
//   npm run panel -- --demo           a throwaway workspace with three simulated engagements
//   --port 4700 (the next free one if taken)   --no-open (don't open the browser)
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPolicy } from "../harness/project.ts";
import { panelFolders } from "./folders.ts";
import { startPanel } from "./server.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));

const asked = args.flatMap((a, i) => (a === "--dir" && i + 1 < args.length && !args[i + 1].startsWith("--") ? [args[i + 1]] : []));
const demo = args.includes("--demo");
let dirs = demo ? [] : panelFolders(asked, process.cwd());
let dir = "";
if (demo) {
  const { makeDemo } = await import("./demo.ts");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-panel-demo-"));
  console.log(`building a demo workspace in ${dir} ...`);
  await makeDemo(dir, policy);
  dirs = [dir];
}
const withWork = dirs.filter((d) => fs.existsSync(path.join(d, ".af", "harness")));
if (!withWork.length) console.log(`no engagements in ${dirs.join(", ")} yet (open one with: npm run harness -- open <engagement.json>)`);
else console.log(`engagements from: ${withWork.join(", ")}`);

const panel = await startPanel({ dir: dirs, policy, port: Number(flag("port") ?? 4700), log: (l) => console.log(`${new Date().toLocaleTimeString()} ${l}`) });
console.log(`panel: ${panel.url}  (Ctrl+C to stop)`);
if (!args.includes("--no-open")) openBrowser(panel.url);

function openBrowser(url: string): void {
  // Fixed URL, no shell: explorer.exe opens it in the default browser on Windows.
  const [cmd, a] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, a, { stdio: "ignore", detached: true, windowsHide: true });
    p.on("error", () => console.log(`open ${url} in your browser`));
    p.unref();
  } catch {
    console.log(`open ${url} in your browser`);
  }
}

const stop = async () => {
  await panel.close();
  if (demo) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
