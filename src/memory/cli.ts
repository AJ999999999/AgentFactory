// Memory about a principal, from the command line.
//
//   npm run memory -- add --as principal --kind preference --subject travel.flight-time --value red-eye --text "I like red-eye flights" [--condition ..] [--because ..]
//   npm run memory -- add --as principal --kind intention --subject travel.trip --value tokyo --text "Maybe Tokyo this weekend" --until 2026-11-01
//   npm run memory -- forget <id> --reason "wrong"          remove it from what we believe (the record stays)
//   npm run memory -- resolve <id> --done | --dropped       an intention that happened, or won't
//   npm run memory -- view [--subjects travel.*] [--all]    what we currently believe, and how we know
//   npm run memory -- history <subject>                     every entry on a subject, retracted ones too
//   npm run memory -- render [--subjects work.*] [--out profile.md]   a profile for your coding agents
//
// Options: --principal (default partner), --dir (default $AF_MEMORY or ~/.agentfactory/memory),
// --at / --until (YYYY-MM-DD or ISO), --source stated|chosen, --supersedes id,id.
// Without --as, an entry is recorded as an agent's (inferred): only an explicit
// --as principal states or chooses for the person, so an agent that leaves the flag
// out can't speak for them. Agents add --by <seat> --source inferred|accepted [--suggestion ..].
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendMemory, find, loadMemoryPolicy, readMemory, record, renderProfile, resolve, retract, understand } from "./memory.ts";
import type { MemoryKind, MemorySource } from "./memory.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const policy = loadMemoryPolicy(path.join(ROOT, "policy", "memory.json"));
const [, , cmd, ...rest] = process.argv;
const flag = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith("--") ? rest[i + 1] : fallback;
};
const has = (name: string) => rest.includes(`--${name}`);
const dir = flag("dir") ?? process.env.AF_MEMORY ?? path.join(os.homedir(), ".agentfactory", "memory");
const principal = flag("principal", "partner")!;
const now = Date.now();

// A bare date means the end of that day where you are; "this weekend" ends Sunday night.
function when(s: string | undefined, endOfDay: boolean): number | undefined {
  if (!s) return undefined;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T${endOfDay ? "23:59:59" : "12:00:00"}`).getTime() : Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`can't read the date "${s}" (use YYYY-MM-DD)`);
  return t;
}

const fmt = (t: number) => new Date(t).toLocaleDateString("sv-SE");

function main(): void {
  const events = readMemory(dir, principal);
  switch (cmd) {
    case "add": {
      const as = flag("as", "agent") as "principal" | "agent";
      if (as !== "principal" && as !== "agent") throw new Error(`--as is principal or agent, not "${as}"`);
      const { event, warnings } = record(principal, {
        kind: flag("kind") as MemoryKind, subject: flag("subject")!, value: flag("value"), text: flag("text")!,
        condition: flag("condition"), because: flag("because"), source: (flag("source") ?? (as === "agent" ? "inferred" : "stated")) as MemorySource,
        at: when(flag("at"), false), until: when(flag("until"), true), supersedes: flag("supersedes")?.split(","), suggestion: flag("suggestion"),
      }, { by: flag("by", as === "agent" ? "agent" : principal)!, as, now, policy });
      for (const s of event.type === "remembered" ? event.entry.supersedes ?? [] : []) if (!find(events, s)) throw new Error(`no memory ${s} to supersede`);
      appendMemory(dir, principal, [event]);
      console.log(`remembered ${event.id}`);
      for (const w of warnings) console.log(`note: ${w}`);
      return;
    }
    case "forget": {
      appendMemory(dir, principal, [retract(events, rest[0], { by: flag("by", principal)!, reason: flag("reason", "asked to forget")!, now })]);
      console.log(`forgot ${rest[0]} (the record of it stays; it no longer counts)`);
      return;
    }
    case "resolve": {
      if (has("done") === has("dropped")) throw new Error("say --done or --dropped");
      appendMemory(dir, principal, [resolve(events, rest[0], { by: flag("by", principal)!, outcome: has("done") ? "done" : "dropped", now })]);
      console.log(`resolved ${rest[0]}`);
      return;
    }
    case "view": {
      const items = understand(events, now, policy, { subjects: flag("subjects")?.split(",") });
      for (const i of items) {
        if (!has("all") && (i.status === "expired" || i.status === "resolved")) continue;
        const src = Object.entries(i.basis).filter(([, n]) => n).map(([s, n]) => `${s}${n > 1 ? `x${n}` : ""}`).join(",");
        console.log(`${i.use.padEnd(7)} ${i.status.padEnd(9)} ${i.subject}${i.condition ? ` [${i.condition}]` : ""}: ${i.text}  (${i.kind}; ${src}; weight ${i.weight}${i.until ? `; until ${fmt(i.until)}` : ""})${i.alternatives ? `\n          vs ${i.alternatives.map((a) => `"${a.text}" (${a.weight})`).join(", ")}` : ""}${i.note ? `\n          note: ${i.note}` : ""}`);
      }
      return;
    }
    case "history": {
      const subject = rest[0];
      const gone = new Map(events.filter((e) => e.type === "retracted").map((e) => [e.type === "retracted" ? e.entry : "", e]));
      for (const e of events) {
        if (e.type !== "remembered" || (subject && e.entry.subject !== subject)) continue;
        const x = e.entry;
        console.log(`${fmt(x.at)} ${x.id} ${x.kind}/${x.source} by ${x.by}: ${x.text}${x.condition ? ` [${x.condition}]` : ""}${gone.has(x.id) ? "  (forgotten)" : ""}${x.supersedes?.length ? `  (replaces ${x.supersedes.join(", ")})` : ""}`);
      }
      return;
    }
    case "render": {
      const items = understand(events, now, policy, { subjects: flag("subjects")?.split(",") });
      const md = renderProfile(items, principal, now, { title: flag("title"), count: events.filter((e) => e.type === "remembered").length });
      if (flag("out")) {
        fs.writeFileSync(flag("out")!, md + "\n");
        console.log(`wrote ${flag("out")}`);
      } else console.log(md);
      return;
    }
    default:
      console.log("usage: npm run memory -- add | forget <id> | resolve <id> | view | history <subject> | render [--out file]");
  }
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
