// The partner's tools, for your own Copilot CLI or Claude Code session: what the firm is
// doing, what's waiting on you, your answers, new work, pause, stop. It's another front
// end on the panel's workspace, so it reads the same log and writes through the same
// code as the panel and `answer`.
//
// It is never an agent's tool. An agent that could answer the partner's questions would
// grade its own work. So inside a harness turn (AF_TURN is set in every turn's
// environment) it serves nothing, and Copilot turns also switch it off by name
// (--disable-mcp-server agentfactory), in case you registered it in your user config.
//
//   claude mcp add agentfactory --scope user -- node --no-warnings <repo>/src/harness/mcp.ts --dir <folder with .af>
//   or in ~/.copilot/mcp-config.json: "agentfactory": { "type": "local", "command": "node", "args": [same] }
import * as path from "node:path";
import { serveMcp } from "../mcp-rpc.ts";
import type { McpResult, McpTool } from "../mcp-rpc.ts";
import { Workspace, answerFromBody } from "../panel/server.ts";
import type { AskView, EngagementView } from "../panel/view.ts";
import { PARTNER_SERVER } from "./agents.ts";
import { loadPolicy } from "./project.ts";

export { PARTNER_SERVER } from "./agents.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const str = (description: string) => ({ type: "string", description });
const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))}m`;
const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function pick<T extends { id: string }>(all: T[], id: unknown): T[] {
  if (id === undefined || id === "") return all;
  const hit = all.filter((e) => e.id === id);
  if (!hit.length) throw new Error(`no engagement ${String(id)} (there are: ${all.map((e) => e.id).join(", ") || "none"})`);
  return hit;
}

export function statusText(engs: EngagementView[], now: number): string {
  if (!engs.length) return "No engagements in this folder.";
  const out: string[] = [];
  for (const e of engs) {
    out.push(`## ${e.id}: ${e.title}${e.paused ? ` (paused by ${e.paused.by}${e.paused.reason ? `: ${e.paused.reason}` : ""})` : ""}`);
    if (e.error) out.push(`can't read it now: ${e.error}`);
    const r = e.runners[0];
    out.push(r ? `loop ${r.id} woke ${minutes(now - r.at)} ago${r.next ? `; next ${when(r.next.at)} (${r.next.why})` : ""}` : "no loop has run for it on this PC");
    for (const c of e.capacity) out.push(`${c.vendor} usage limit: its turns wait until ${when(c.until)} (${c.reason})`);
    for (const t of e.running ?? []) out.push(`running ${t.turn}: ${t.text} (${t.role ?? t.runner}, ${minutes(now - t.startedAt)}${t.stopping ? ", stopping" : ""}); last: ${t.tail.at(-1)?.replace(/^\d\d:\d\d:\d\d /, "") ?? "-"}`);
    for (const g of e.goals) {
      if (g.status !== "active") {
        out.push(`goal ${g.id} (${g.status}): ${g.title}`);
        continue;
      }
      const b = g.beliefs.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {} as Record<string, number>);
      out.push(`goal ${g.id} v${g.version}: ${g.title} · ${g.turns.spent}/${g.turns.budget ?? "∞"} turns · beliefs ${Object.entries(b).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
      for (const w of g.work) out.push(`  ${w.state.padEnd(7)} ${w.id} (${w.lane}): ${w.text}${w.why ? ` [${w.why}]` : ""}`);
      if (g.workMore) out.push(`  … ${g.workMore} more`);
      const last = g.turnLog.at(-1);
      if (last) out.push(`  last turn: ${last.todo} ${last.result}${last.granularity !== "none" ? ` (${last.granularity})` : ""}, ${minutes(now - last.at)} ago${last.reasons.length ? `: ${last.reasons.join("; ").slice(0, 200)}` : ""}`);
    }
    out.push(e.asks.length ? `waiting on you: ${e.asks.length} question${e.asks.length > 1 ? "s" : ""} (open_questions)` : "nothing waiting on you");
    out.push("");
  }
  return out.join("\n").trim();
}

export function questionsText(asks: AskView[]): string {
  if (!asks.length) return "Nothing is waiting on you.";
  return asks.map((a) => [
    `[${a.engagement} ${a.id}]${a.urgent ? " URGENT" : ""} for ${a.to}, ${a.kind}: ${a.question}`,
    ...(a.about ? [`  about: ${a.about}`] : []),
    ...(a.tests ? [`  counts toward ${a.tests.id}: ${a.tests.text}`] : []),
    ...a.evidence.map((f) => `  evidence (${f.grade}, ${f.direction}): ${f.text}`),
    ...(a.holds.length ? [`  holds up: ${a.holds.slice(0, 6).join("; ")}${a.holds.length > 6 ? ` and ${a.holds.length - 6} more` : ""}`] : []),
    `  options: ${a.options.map((o) => `${o.id} = ${o.label}${o.needs === "budget" ? ` (give turns; now ${a.budget?.turns ?? "?"})` : o.needs === "observation" ? " (give observation: direction, metrics, runs)" : o.needs === "revision" ? " (give the revised goal)" : ""}${o.hint ? ` (note: ${o.hint})` : ""}${o.confirm ? " [can't be undone]" : ""}`).join("; ")}`,
    ...(a.revision ? [`  the goal now: ${JSON.stringify(a.revision)}`] : []),
  ].join("\n")).join("\n\n");
}

export function partnerTools(ws: Workspace): McpTool[] {
  const one = (args: Record<string, unknown>) => String(args.engagement ?? "");
  return [
    {
      name: "status",
      description: "What the firm is doing: each engagement's goals, budgets, open work and why it waits, turns running now, usage limits, the loop's heartbeat, and how many questions wait on the partner.",
      inputSchema: { type: "object", properties: { engagement: str("one engagement id; all when left out") } },
      call: async (args): Promise<McpResult> => {
        const snap = await ws.snapshot();
        const engs = pick(snap.engagements, args.engagement);
        return { text: statusText(engs, snap.now), data: engs };
      },
    },
    {
      name: "open_questions",
      description: "The questions waiting on the partner (or on someone the partner answers for), most urgent first, with their options, the evidence and the work each holds up.",
      inputSchema: { type: "object", properties: { engagement: str("one engagement id; all when left out") } },
      call: async (args): Promise<McpResult> => {
        const snap = await ws.snapshot();
        const asks = pick(snap.engagements, args.engagement).flatMap((e) => e.asks).sort((x, y) => Number(y.urgent) - Number(x.urgent) || y.holds.length - x.holds.length || x.openedAt - y.openedAt);
        return { text: questionsText(asks), data: asks };
      },
    },
    {
      name: "answer",
      description: "Record the partner's answer to one question. Pass on only what the partner actually decided or saw; never choose for them. It counts as the partner's own evidence unless relayed is true, which says the partner is passing on what the person the question is for (the parent, the lawyer) told them.",
      inputSchema: {
        type: "object",
        properties: {
          engagement: str("engagement id"),
          ask: str("question id, from open_questions"),
          choice: str("option id"),
          note: str("their reason or what they said"),
          relayed: { type: "boolean", description: "true only when the partner says this is what the person the question is for told them" },
          turns: { type: "number", description: "for an option that raises the budget: the new number of turns" },
          observation: { type: "object", description: "for an option that reports what was seen", properties: { direction: { type: "string", enum: ["supports", "refutes", "neutral"] }, metrics: { type: "object", additionalProperties: { type: "number" } }, runs: { type: "number" } }, required: ["direction"] },
          revision: { type: "object", description: "for a change of direction: the revised goal" },
        },
        required: ["engagement", "ask", "choice"],
      },
      call: async (args): Promise<McpResult> => {
        await answerFromBody(ws, {
          engagement: one(args), ask: String(args.ask ?? ""), choice: String(args.choice ?? ""),
          ...(args.relayed === true ? { relayed: true } : {}),
          ...(args.note ? { note: String(args.note) } : {}),
          ...(args.turns !== undefined ? { budget: { turns: Number(args.turns) } } : {}),
          ...(args.observation ? { observation: args.observation as never } : {}),
          ...(args.revision ? { revision: args.revision as never } : {}),
        });
        return { text: `answered ${args.ask}: ${args.choice}` };
      },
    },
    {
      name: "add_work",
      description: "Add a piece of work to a goal, as the partner. It stays inside the goal's scope. Lanes are kinds of work such as build, research, data, market-test, replan; a lane the team doesn't have gets a generated role, on probation.",
      inputSchema: {
        type: "object",
        properties: {
          engagement: str("engagement id"), goal: str("goal id"), text: str("what to do, plainly"), lane: str("kind of work, e.g. build or research"),
          write_scope: { type: "array", items: { type: "string" }, description: "folders it may change, inside the goal's scope; none for work that only reads" },
          tests: str("the assumption id this produces evidence for, if any"),
          priority: { type: "number", description: "0 urgent to 3 low; 2 when left out" },
        },
        required: ["engagement", "goal", "text", "lane"],
      },
      call: async (args): Promise<McpResult> => {
        const id = await ws.harness(one(args)).addWork(String(args.goal ?? ""), {
          text: String(args.text ?? ""), lane: String(args.lane ?? ""),
          ...(Array.isArray(args.write_scope) ? { writeScope: args.write_scope.map(String) } : {}),
          ...(args.tests ? { tests: String(args.tests) } : {}),
          ...(args.priority !== undefined ? { priority: Number(args.priority) } : {}),
        });
        return { text: `added ${id} to ${args.goal}`, data: { id } };
      },
    },
    {
      name: "pause",
      description: "Pause an engagement (nothing new starts; a running turn finishes) or resume it.",
      inputSchema: { type: "object", properties: { engagement: str("engagement id"), paused: { type: "boolean" }, reason: str("why, for the record") }, required: ["engagement", "paused"] },
      call: async (args): Promise<McpResult> => {
        const changed = await ws.harness(one(args)).pause(args.paused === true, "partner", args.reason ? String(args.reason) : undefined);
        return { text: `${one(args)} ${args.paused === true ? "paused" : "resumed"}${changed ? "" : " (it already was)"}` };
      },
    },
    {
      name: "stop_turn",
      description: "Stop a turn running on this PC (ids from status). The agent is killed, its changes are thrown away, and the work then waits for the partner to say try again or drop it.",
      inputSchema: { type: "object", properties: { engagement: str("engagement id"), turn: str("turn id") }, required: ["engagement", "turn"] },
      call: async (args): Promise<McpResult> => {
        ws.harness(one(args));
        if (!ws.live(one(args)).requestStop(String(args.turn ?? ""), "partner", Date.now())) throw new Error("that turn isn't running any more");
        return { text: `asked ${args.turn} to stop; it stops within a few seconds` };
      },
    },
  ];
}

// import.meta.main is newer than some Node 22 releases.
if (import.meta.main ?? path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--dir");
  const dir = path.resolve(at >= 0 ? args[at + 1] : process.env.AF_DIR ?? process.cwd());
  const inTurn = !!process.env.AF_TURN;
  const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
  serveMcp({
    name: PARTNER_SERVER,
    version: "0.1.0",
    instructions: inTurn
      ? "This server is the partner's and offers nothing inside a harness turn."
      : `The partner's view of the AgentFactory engagements in ${dir}: status, open_questions, then answer, add_work, pause or stop_turn when the partner says so.`,
  }, inTurn ? [] : partnerTools(new Workspace(dir, policy)));
}
