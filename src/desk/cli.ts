// The desk on the command line.
//
//   npm run desk -- install          record every Copilot CLI session on this PC (one file in ~/.copilot/hooks)
//   npm run desk -- uninstall        stop recording
//   npm run desk -- report [--days 7]  how often each repo's session stopped for you, and for what
//   npm run desk -- tail [--n 20]    the last events, to check the hook is firing
import * as path from "node:path";
import { copilotHooksDir, install, uninstall } from "./install.ts";
import { deskHome, logFile, readLog } from "./log.ts";
import { renderReport, report } from "./report.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

switch (cmd) {
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
    console.log(`usage: npm run desk -- install | uninstall | report [--days 7] | tail [--n 20]\nlog: ${deskHome()}`);
    process.exit(cmd ? 1 : 0);
}
