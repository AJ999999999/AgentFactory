// The desk on the command line.
//
//   npm run desk -- install          hook every Copilot CLI session on this PC (one file in ~/.copilot/hooks)
//   npm run desk                     the page: every terminal, and its permission asks held for you
//                                    [--port 4710] [--no-open]
//   npm run desk -- uninstall        stop recording
//   npm run desk -- report [--days 7]  how often each repo's session stopped for you, and for what
//   npm run desk -- tail [--n 20]    the last events, to check the hook is firing
import { spawn } from "node:child_process";
import * as path from "node:path";
import { copilotHooksDir, install, uninstall } from "./install.ts";
import { deskHome, logFile, readLog } from "./log.ts";
import { renderReport, report } from "./report.ts";
import { startDesk } from "./server.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

switch (cmd ?? "open") {
  case "open":
  case "--port":
  case "--no-open": {
    const all = process.argv.slice(2);
    const i = all.indexOf("--port");
    const desk = await startDesk({ port: i >= 0 ? Number(all[i + 1]) : 4710, log: (l) => console.log(`${new Date().toLocaleTimeString()} ${l}`) });
    console.log(`desk: ${desk.url}  (Ctrl+C to stop; while it runs, permission asks wait here instead of in the terminals)`);
    if (!all.includes("--no-open")) openBrowser(desk.url);
    const stop = async () => {
      await desk.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "install": {
    const file = install(path.join(import.meta.dirname, "hook.ts"));
    console.log(`installed ${file}\nevery Copilot CLI session you start from now on is recorded to ${logFile()}`);
    break;
  }
  case "uninstall":
    console.log(uninstall() ? `removed the desk's hook from ${copilotHooksDir()}` : "the desk's hook wasn't installed");
    break;
  case "report": {
    const days = Number(flag("days") ?? 7);
    console.log(renderReport(report(readLog(), Date.now() - days * 86_400_000)));
    break;
  }
  case "tail": {
    const n = Number(flag("n") ?? 20);
    for (const e of readLog().slice(-n)) console.log(`${new Date(e.at).toLocaleTimeString()}  ${path.basename(e.cwd).padEnd(20).slice(0, 20)}  ${e.event}${e.kind ? `:${e.kind}` : ""}${e.tool ? `  ${e.tool}` : ""}${e.detail ? `  ${e.detail}` : e.message ? `  ${e.message}` : ""}`);
    break;
  }
  default:
    console.log(`usage: npm run desk [-- --port 4710 --no-open] | -- install | uninstall | report [--days 7] | tail [--n 20]\nstate: ${deskHome()}`);
    process.exit(1);
}

function openBrowser(url: string): void {
  // Fixed URL, no shell: explorer.exe opens it in the default browser on Windows.
  const [c, a] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const p = spawn(c, a, { stdio: "ignore", detached: true, windowsHide: true });
    p.on("error", () => console.log(`open ${url} in your browser`));
    p.unref();
  } catch {
    console.log(`open ${url} in your browser`);
  }
}
