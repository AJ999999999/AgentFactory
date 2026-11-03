// The desk on the command line.
//
//   npm run desk -- install [--mcp]  hook every Copilot CLI session on this PC (one file in ~/.copilot/hooks);
//                                    --mcp also registers the af-desk MCP tools, where your company allows it
//   npm run desk                     the page: every terminal's Copilot session as a thread, in a window of its own
//                                    [--port 4710] [--no-open] [--tab: a browser tab instead] [--demo: five simulated threads, nothing real touched]
//   npm run desk -- app              the desk in the background (no console window) and its window; what the shortcut runs
//   npm run desk -- stop             stop a desk running in the background; its terminals stay with the keeper
//   npm run desk -- shortcut [--key Ctrl+Alt+D]   a Start menu entry for the desk, with a key that brings it up
//   npm run desk -- learn [--session <id>] [--force]   learn from ended sessions now (or one session)
//   npm run desk -- knows [<folder>]  what a new session in that folder is told
//   node src/desk/cli.ts note <terminal|all|you> <text> [--from <terminal>]
//                                    what a session runs to send a note (sessions are told this at their start)
//   node src/desk/cli.ts threads [--from <terminal>]   the open terminals, as a session sees them
//   npm run desk -- terminals [stop] the terminals the keeper holds (they outlive the desk); stop ends them all
//   npm run desk -- uninstall        stop recording
//   npm run desk -- report [--days 7]  how often each repo's session stopped for you, and for what
//   npm run desk -- tail [--n 20]    the last events, to check the hook is firing
//   npm run desk -- away [on|off]    while you're away, asks go to Teams as cards (needs teams in config.json)
//   npm run desk -- teams test       send one test card to Teams and wait for your tap
//   npm run desk -- slack test       post one test message to your Slack workflow, and wait for your answer by mail if set up
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openApp, runningDesk, shortcutScript, startInBackground, startMenuFolder } from "./app.ts";
import { copilotHooksDir, install, installMcp, mcpConfigFile, uninstall, uninstallMcp } from "./install.ts";
import { deskHome, logFile, readLog } from "./log.ts";
import { renderReport, report } from "./report.ts";
import { startDesk } from "./server.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const withoutFrom = args.filter((_, i) => args[i] !== "--from" && args[i - 1] !== "--from");

switch (cmd === undefined || cmd.startsWith("--") ? "open" : cmd) {
  case "open": {
    const all = process.argv.slice(2);
    const i = all.indexOf("--port");
    const demo = all.includes("--demo");
    const tab = all.includes("--tab");
    // One desk at a time: a second start opens the window of the one already running.
    const already = demo ? undefined : runningDesk(deskHome());
    if (already) {
      console.log(`the desk is already running at ${already.url} (pid ${already.pid}); opening its window`);
      if (!all.includes("--no-open")) openApp(already.url, { tab });
      break;
    }
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
    if (!all.includes("--no-open")) {
      const how = openApp(desk.url, { tab });
      if (how === "tab") console.log("no Edge or Chrome found for a window of its own: opened a browser tab");
    }
    const stop = async () => {
      await desk.close();
      if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "app": {
    const d = runningDesk(deskHome()) ?? (await startInBackground(deskHome()));
    openApp(d.url, { tab: args.includes("--tab") });
    console.log(`the desk: ${d.url} (pid ${d.pid}); npm run desk -- stop to stop it`);
    break;
  }
  case "stop": {
    const d = runningDesk(deskHome());
    if (!d) {
      console.log("no desk is running");
      break;
    }
    process.kill(d.pid, "SIGTERM");
    console.log(`stopped the desk (pid ${d.pid}); its terminals keep running (npm run desk -- terminals)`);
    break;
  }
  case "shortcut": {
    if (process.platform !== "win32") {
      console.log("the Start menu shortcut is for Windows; elsewhere run npm run desk -- app");
      break;
    }
    const key = flag("key") ?? "Ctrl+Alt+D";
    const { findAppBrowser } = await import("./app.ts");
    const browser = findAppBrowser();
    const script = shortcutScript({ node: process.execPath, cli: path.join(import.meta.dirname, "cli.ts"), key, folder: startMenuFolder(), ...(browser ? { icon: `${browser},0` } : {}) });
    const { runCommand } = await import("../proc.ts");
    try {
      await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    } catch (e) {
      // Constrained language mode refuses the shell object; the desk itself still works.
      console.error(`couldn't write the shortcut: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0]}`);
      process.exitCode = 1;
      break;
    }
    console.log(`added "AgentFactory desk" to the Start menu; ${key} brings it up from anywhere`);
    break;
  }
  case "install": {
    const file = install(path.join(import.meta.dirname, "hook.ts"));
    // Sessions reach each other with the desk's own command; the MCP server is only for
    // a company that allows it. Without --mcp, an entry left by an earlier install goes.
    const mcp = args.includes("--mcp");
    if (mcp) installMcp(path.join(import.meta.dirname, "mcp.ts"));
    const removed = !mcp && uninstallMcp();
    console.log([
      `installed ${file}`,
      mcp ? `added the af-desk MCP tools (list_terminals, send_note) to ${mcpConfigFile()}` : `sessions reach each other with the desk's own command, no MCP server needed${removed ? ` (removed the af-desk entry from ${mcpConfigFile()})` : ""}`,
      `every Copilot CLI session you start from now on is recorded to ${logFile()}`,
    ].join("\n"));
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
    // What a session runs: note <terminal|all|you> <text...> [--from <terminal>]. It's
    // from the terminal it runs in; your own notes go from the desk's page.
    const { send } = await import("./notes.ts");
    const { terminals } = await import("./others.ts");
    const { senderOf } = await import("./reach.ts");
    const [to = "", ...words] = withoutFrom;
    try {
      const notes = send(senderOf(process.env, flag("from")), to, words.join(" "), { known: terminals().map((t) => t.name) });
      console.log(`Sent to ${notes.map((n) => n.to).join(", ")}. ${notes.some((n) => n.to === "you") ? "The user sees it on the desk." : "It's read after that session's next tool call."}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
    break;
  }
  case "threads": {
    const { threadList } = await import("./others.ts");
    console.log(threadList(process.env.AF_DESK_TERMINAL?.trim() || flag("from") || ""));
    break;
  }
  case "away": {
    const { awaySince, awayTo, loadConfig, setAway } = await import("./hold.ts");
    if (args[0] === "on" || args[0] === "off") {
      if (args[0] === "on" && !awayTo(loadConfig())) {
        console.error(`set up Teams or Slack first in ${path.join(deskHome(), "config.json")}; see docs/desk.md`);
        process.exitCode = 1;
        break;
      }
      setAway(args[0] === "on");
    }
    const since = awaySince();
    console.log(since ? `away since ${new Date(since).toLocaleTimeString()}: asks go to ${awayTo(loadConfig())?.to ?? "nowhere (set up Teams or Slack)"} while the desk runs` : "at the desk: asks go where each terminal is set");
    break;
  }
  case "slack": {
    if (args[0] !== "test") {
      console.error("usage: npm run desk -- slack test");
      process.exit(2);
    }
    const { slackTest } = await import("./slack.ts");
    const r = await slackTest();
    for (const l of r.lines) console.log(l);
    process.exit(r.ok ? 0 : 1);
  }
  case "teams": {
    if (args[0] !== "test") {
      console.error("usage: npm run desk -- teams test");
      process.exitCode = 1;
      break;
    }
    const { teamsTest } = await import("./teams.ts");
    const r = await teamsTest();
    console.log(r.lines.join("\n"));
    if (!r.ok) process.exitCode = 1;
    break;
  }
  case "terminals": {
    // The keeper holds the desk's terminals across restarts of the desk (keeper.ts).
    const { KeptTerminals } = await import("./keeper.ts");
    const k = await KeptTerminals.connect(deskHome(), { start: false }).catch(() => undefined);
    if (!k) {
      console.log("no terminals are being kept: none was opened on the desk, or the keeper ended");
      break;
    }
    const list = k.list();
    for (const t of list) console.log(`${t.name.padEnd(20)} ${t.exited ? "ended" : (t.progress ?? "open").padEnd(8)}  ${t.cwd}  since ${new Date(t.started).toLocaleString()}`);
    if (!list.length) console.log("the keeper holds no terminal");
    if (args[0] === "stop") {
      await k.stop();
      console.log(`ended ${list.filter((t) => !t.exited).length} terminal(s) and the keeper (pid ${k.pid})`);
    } else k.detach();
    break;
  }
  case "tail": {
    const n = Number(flag("n") ?? 20);
    for (const e of readLog().slice(-n)) console.log(`${new Date(e.at).toLocaleTimeString()}  ${path.basename(e.cwd).padEnd(20).slice(0, 20)}  ${e.event}${e.kind ? `:${e.kind}` : ""}${e.tool ? `  ${e.tool}` : ""}${e.detail ? `  ${e.detail}` : e.message ? `  ${e.message}` : ""}`);
    break;
  }
  default:
    console.log(`usage: npm run desk [-- --port 4710 --no-open --tab --demo] | -- app | stop | shortcut [--key Ctrl+Alt+D] | install | uninstall | learn [--session id] | knows [folder] | note <terminal|all|you> <text> --from <terminal> | threads | report [--days 7] | terminals [stop] | tail [--n 20] | away [on|off] | teams test | slack test\nstate: ${deskHome()}`);
    process.exit(1);
}
