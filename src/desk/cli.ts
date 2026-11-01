// The desk on the command line.
//
//   npm run desk -- install          hook every Copilot CLI session on this PC (one file in ~/.copilot/hooks)
//   npm run desk                     the page: every terminal's Copilot session as a thread
//                                    [--port 4710] [--no-open] [--demo: five simulated threads, nothing real touched]
//   npm run desk -- learn [--session <id>] [--force]   learn from ended sessions now (or one session)
//   npm run desk -- knows [<folder>]  what a new session in that folder is told
//   npm run desk -- note <terminal|all> <text>   a note to a terminal's session, read during its work
//   npm run desk -- uninstall        stop recording
//   npm run desk -- report [--days 7]  how often each repo's session stopped for you, and for what
//   npm run desk -- tail [--n 20]    the last events, to check the hook is firing
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copilotHooksDir, install, installMcp, mcpConfigFile, uninstall, uninstallMcp } from "./install.ts";
import { deskHome, logFile, readLog } from "./log.ts";
import { renderReport, report } from "./report.ts";
import { startDesk } from "./server.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

switch (cmd === undefined || cmd.startsWith("--") ? "open" : cmd) {
  case "open": {
    const all = process.argv.slice(2);
    const i = all.indexOf("--port");
    const demo = all.includes("--demo");
    let home: string | undefined;
    let analyst;
    if (demo) {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "af-desk-demo-"));
      process.env.AF_DESK_HOME = home;
      const d = await import("./demo.ts");
      await d.makeDemo(home);
      analyst = d.demoAnalyst;
      console.log(`a demo desk in ${home}`);
    }
    const desk = await startDesk({ ...(home ? { home } : {}), ...(analyst ? { analyst } : {}), port: i >= 0 ? Number(all[i + 1]) : 4710, log: (l) => console.log(`${new Date().toLocaleTimeString()} ${l}`) });
    console.log(`desk: ${desk.url}  (Ctrl+C to stop)`);
    if (!all.includes("--no-open")) openBrowser(desk.url);
    const stop = async () => {
      await desk.close();
      if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "install": {
    const file = install(path.join(import.meta.dirname, "hook.ts"));
    installMcp(path.join(import.meta.dirname, "mcp.ts"));
    console.log(`installed ${file}\nadded the af-desk tools (list_terminals, send_note) to ${mcpConfigFile()}\nevery Copilot CLI session you start from now on is recorded to ${logFile()}`);
    break;
  }
  case "uninstall":
    console.log(uninstall() ? `removed the desk's hook from ${copilotHooksDir()}` : "the desk's hook wasn't installed");
    if (uninstallMcp()) console.log(`removed the af-desk tools from ${mcpConfigFile()}`);
    break;
  case "report": {
    const days = Number(flag("days") ?? 7);
    console.log(renderReport(report(readLog(), Date.now() - days * 86_400_000)));
    break;
  }
  case "learn": {
    const { copilotAnalyst, learn, learnConfig, toLearn } = await import("./learn.ts");
    const { knowledgeDir } = await import("./knowledge.ts");
    const analyst = copilotAnalyst(learnConfig(), (l) => console.log(`  ${l}`));
    const one = flag("session");
    const todo = one ? [{ session: one }] : toLearn(readLog(), knowledgeDir());
    if (!todo.length) console.log("no ended session waiting to be learned from");
    for (const t of todo) {
      const a = await learn(t.session, { analyst, force: args.includes("--force") || !!one, log: (l) => console.log(l) });
      if (a) for (const d of a.dropped) console.log(`  left out: ${d.why}: ${JSON.stringify(d.proposal).slice(0, 160)}`);
    }
    break;
  }
  case "knows": {
    const { contextFor, knowledgeDir } = await import("./knowledge.ts");
    console.log(contextFor(path.resolve(args[0] ?? process.cwd())) ?? `nothing known yet for ${path.resolve(args[0] ?? process.cwd())} (kept in ${knowledgeDir()})`);
    break;
  }
  case "note": {
    // npm run desk -- note <terminal|all> <text...>: the same as the desk's note box.
    const { send } = await import("./notes.ts");
    const { terminals } = await import("./mcp.ts");
    const notes = send("you", args[0] ?? "", args.slice(1).join(" "), { known: terminals().map((t) => t.name) });
    console.log(`sent to ${notes.map((n) => n.to).join(", ")}; delivered after its next tool call`);
    break;
  }
  case "tail": {
    const n = Number(flag("n") ?? 20);
    for (const e of readLog().slice(-n)) console.log(`${new Date(e.at).toLocaleTimeString()}  ${path.basename(e.cwd).padEnd(20).slice(0, 20)}  ${e.event}${e.kind ? `:${e.kind}` : ""}${e.tool ? `  ${e.tool}` : ""}${e.detail ? `  ${e.detail}` : e.message ? `  ${e.message}` : ""}`);
    break;
  }
  default:
    console.log(`usage: npm run desk [-- --port 4710 --no-open --demo] | -- install | uninstall | learn [--session id] | knows [folder] | note <terminal|all> <text> | report [--days 7] | tail [--n 20]\nstate: ${deskHome()}`);
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
