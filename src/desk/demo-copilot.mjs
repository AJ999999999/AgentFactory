// A stand-in for Copilot CLI, for the desk's demo and tests. With --acp it speaks ACP
// over stdio the way `copilot --acp --stdio` does; what a prompt says picks what it does:
//   run <command>   asks permission to run it, then runs it or doesn't (also at a
//                   prompt's end: "…, then run npm test")
//   edit <path>     asks permission to edit a file
//   slow            works until it's cancelled (FAKE_STUCK=1: never stops)
//   ask             sends a form (elicitation) and says what came back
//   options         ends its turn with a numbered list of options (also any prompt
//                   ending in "?")
//   crash           exits with an error
//   anything else   answers "Hello from fake", with a plan
// Without --acp it's Copilot's own screen: it notes how it was started and exits.
// Every message it gets is appended to $FAKE_LOG, one JSON line each.
import * as fs from "node:fs";

const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");

if (!process.argv.includes("--acp")) {
  log({ screen: process.argv.slice(2), terminal: process.env.AF_DESK_TERMINAL, cwd: process.cwd() });
  process.exit(0);
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let next = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
let sessions = 0;
let cancelled = null;
const modes = (current = "agent") => ({ currentModeId: current, availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] });
let model = "m1";
const config = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "m1", name: "Model One" }, { value: "m2", name: "Model Two" }] }];

async function prompt(sessionId, blocks) {
  const text = blocks.filter((b) => b.type === "text").at(-1)?.text ?? "";
  const stop = new Promise((r) => (cancelled = r));
  const until = (p) => Promise.race([p, stop.then(() => "cancelled")]);
  const run = /(?:^|then )run (.+)$/.exec(text);
  if (run || text.startsWith("edit ")) {
    const edit = !run;
    const arg = run ? run[1] : text.slice(5);
    if (run && run.index > 0) {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: "Edit db/migrations/0042_backfill_totals.sql", kind: "edit", status: "completed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The backfill migration is written. Running it now." } });
    }
    const toolCall = { toolCallId: "t1", title: edit ? `Edit ${arg}` : `Run ${arg}`, kind: edit ? "edit" : "execute", status: "pending", rawInput: edit ? { path: arg } : { command: arg } };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const res = await until(ask("session/request_permission", { sessionId, toolCall, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }] }));
    if (res === "cancelled" || res.outcome?.outcome === "cancelled") return "cancelled";
    const ok = res.outcome.optionId !== "no";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? `ran ${arg}` : "not allowed" } });
    return "end_turn";
  }
  if (text === "slow") {
    if (process.env.FAKE_STUCK) await new Promise(() => {});
    return stop.then(() => "cancelled");
  }
  if (text === "ask") {
    const res = await until(ask("elicitation/create", { sessionId, mode: "form", message: "Which schema?", requestedSchema: { type: "object", properties: { schema: { type: "string", enum: ["billing", "finance"] } }, required: ["schema"] } }));
    if (res === "cancelled") return "cancelled";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: res.action === "accept" ? `schema=${res.content.schema}` : res.action } });
    return "end_turn";
  }
  if (text === "options" || text.endsWith("?")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Which schema should the table go in?\n\n1. Billing\n2. **Finance**\n" } });
    return "end_turn";
  }
  if (text === "crash") {
    process.stderr.write("boom\n");
    process.exit(3);
  }
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "say hello", status: "in_progress", priority: "high" }] });
  update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "from fake" } });
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "say hello", status: "completed", priority: "high" }] });
  return "end_turn";
}

async function handle(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: !process.env.FAKE_NO_LOAD, promptCapabilities: { embeddedContext: true }, sessionCapabilities: { close: {} } }, authMethods: [] };
    case "session/new": {
      const sessionId = `fake-${process.pid}-${++sessions}`;
      setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "model" }, { name: "compact" }] }), 5);
      return { sessionId, modes: modes(), configOptions: config() };
    }
    case "session/load":
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "REPLAYED" } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" } });
      return { modes: modes(), configOptions: config() };
    case "session/prompt":
      return { stopReason: await prompt(p.sessionId, p.prompt ?? []) };
    case "session/set_mode":
      update(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.modeId });
      return {};
    case "session/set_config_option":
      model = p.value;
      return { configOptions: config() };
    case "session/close":
      return {};
    default:
      throw Object.assign(new Error(`no ${m.method}`), { code: -32601 });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (s) => {
  buf += s;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log(m);
    if (m.method === "session/cancel") {
      cancelled?.();
      continue;
    }
    if (!m.method) {
      waiting.get(m.id)?.(m.result ?? { error: m.error });
      waiting.delete(m.id);
      continue;
    }
    handle(m).then((result) => send({ id: m.id, result }), (e) => send({ id: m.id, error: { code: e.code ?? -32603, message: e.message } }));
  }
});
process.stdin.on("end", () => process.exit(0));
