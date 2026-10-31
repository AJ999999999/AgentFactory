// A throwaway desk with three simulated terminals, for `npm run desk -- --demo`: a
// permission ask waiting, a question, an idle session, a finished one already learned
// from, and a canned analyst in place of Copilot. Nothing here touches your real
// Copilot folder or knowledge repo.
import * as fs from "node:fs";
import * as path from "node:path";
import { hold, writeJson } from "./hold.ts";
import { recordProposals, commit, ensureRepo } from "./knowledge.ts";
import type { Analyst } from "./learn.ts";
import { append, type DeskEvent } from "./log.ts";

const line = (type: string, data: Record<string, unknown>, at: number) => JSON.stringify({ type, data, id: `${type}-${at}`, timestamp: new Date(at).toISOString() });

export const demoAnalyst: Analyst = async () =>
  JSON.stringify({ items: [
    { scope: "repo", kind: "fact", subject: "test.command", value: "npm test -w api", text: "Run the API tests with `npm test -w api`; plain `npm test` also runs the slow e2e suite.", evidence: "npm test -w api passed after npm test timed out" },
    { scope: "you", kind: "preference", subject: "git.push", value: "never", text: "Don't push; I push after reviewing the diff myself.", evidence: "you refused git push: I push myself" },
  ] });

export async function makeDemo(home: string): Promise<void> {
  const copilot = path.join(home, "copilot");
  process.env.COPILOT_HOME = copilot;
  const now = Date.now();
  const repos = path.join(home, "work");
  for (const r of ["billing", "web", "etl"]) fs.mkdirSync(path.join(repos, r, ".git"), { recursive: true });
  const at = (minAgo: number) => now - minAgo * 60_000;
  const session = (id: string, lines: string[]) => {
    fs.mkdirSync(path.join(copilot, "session-state", id), { recursive: true });
    fs.writeFileSync(path.join(copilot, "session-state", id, "events.jsonl"), lines.join("\n") + "\n");
  };
  const ev = (e: Partial<DeskEvent> & Pick<DeskEvent, "event" | "session" | "cwd">, minAgo: number) => append({ at: at(minAgo), ...e } as DeskEvent, home);

  const billing = path.join(repos, "billing");
  session("b1111111-demo", [
    line("session.start", { context: { cwd: billing, branch: "invoice-rounding" } }, at(40)),
    line("user.message", { content: "Invoices round each line, so totals are off by a cent. Round only the total." }, at(40)),
    line("tool.execution_start", { toolCallId: "1", toolName: "grep", arguments: { pattern: "round(" } }, at(39)),
    line("tool.execution_complete", { toolCallId: "1", toolName: "grep", success: true }, at(39)),
    line("tool.execution_start", { toolCallId: "2", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/invoice/total.ts\n*** End Patch" }, at(30)),
    line("tool.execution_complete", { toolCallId: "2", toolName: "apply_patch", success: true }, at(30)),
    line("tool.execution_start", { toolCallId: "3", toolName: "powershell", arguments: { command: "npm test" } }, at(25)),
    line("tool.execution_complete", { toolCallId: "3", toolName: "powershell", success: false, error: { message: "e2e: timed out after 600s" } }, at(15)),
    line("tool.execution_start", { toolCallId: "4", toolName: "powershell", arguments: { command: "npm test -w api" } }, at(3)),
    line("assistant.message", { content: "The API tests pass. Next I'd run the migration on staging to backfill corrected totals." }, at(1)),
  ]);
  ev({ event: "sessionStart", session: "b1111111-demo", cwd: billing, terminal: "billing" }, 40);

  const web = path.join(repos, "web");
  session("w2222222-demo", [
    line("session.start", { context: { cwd: web } }, at(60)),
    line("user.message", { content: "Validate the email field on the sign-up form." }, at(60)),
    line("tool.execution_start", { toolCallId: "1", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/signup/Form.tsx\n*** End Patch" }, at(20)),
    line("tool.execution_complete", { toolCallId: "1", toolName: "apply_patch", success: true }, at(20)),
    line("assistant.message", { content: "Done: the sign-up form now checks the email before submitting. Want tests for it too?" }, at(8)),
  ]);
  ev({ event: "sessionStart", session: "w2222222-demo", cwd: web, terminal: "web" }, 60);
  ev({ event: "agentStop", session: "w2222222-demo", cwd: web, terminal: "web" }, 8);
  ev({ event: "notification", session: "w2222222-demo", cwd: web, terminal: "web", kind: "agent_idle", message: "Done: the sign-up form now checks the email before submitting. Want tests for it too?" }, 8);

  const etl = path.join(repos, "etl");
  session("e3333333-demo", [line("session.start", { context: { cwd: etl } }, at(30)), line("user.message", { content: "Add a table for refunds." }, at(30))]);
  ev({ event: "sessionStart", session: "e3333333-demo", cwd: etl, terminal: "etl" }, 30);
  ev({ event: "notification", session: "e3333333-demo", cwd: etl, terminal: "etl", kind: "elicitation_dialog", message: "Which schema should the refunds table go in: billing or finance?" }, 2);

  // What earlier sessions taught: one fact you confirmed, two guesses to check.
  const dir = path.join(home, "knowledge");
  writeJson(path.join(home, "config.json"), { knowledgeDir: dir, learn: "off" });
  await ensureRepo(dir);
  const { kept } = recordProposals(dir, "billing", [
    { scope: "repo", kind: "constraint", subject: "money.rounding", text: "Round money only at the invoice total, never per line.", evidence: "Round only the total." },
    { scope: "repo", kind: "fact", subject: "test.command", value: "npm test -w api", text: "Run the API tests with `npm test -w api`; plain `npm test` also runs the slow e2e suite.", evidence: "npm test timed out; npm test -w api passed" },
  ], { session: "b0000000-earlier", now: at(300) });
  const { confirm } = await import("./knowledge.ts");
  confirm(dir, "repo.billing", kept[0].id, at(200));
  recordProposals(dir, "web", [{ scope: "you", kind: "preference", subject: "git.push", value: "never", text: "Don't push; I push after reviewing the diff myself.", evidence: "you refused git push: I push myself" }], { session: "w0000000-earlier", now: at(90) });
  await commit(dir, "demo knowledge");

  // Notes: web told billing about a change, and billing told you something.
  const { send } = await import("./notes.ts");
  send("web", "billing", "I renamed the API field invoice.totalCents to invoice.total_cents in the web client; the billing endpoint should send the new name.", { home, now: at(12) });
  send("billing", "you", "The staging migration needs the finance team's sign-off before it runs; I've stopped at that step.", { home, now: at(4) });

  // The ask billing is waiting on, held the way the real hook holds it.
  writeJson(path.join(home, "page.json"), { at: Date.now() });
  const ask: DeskEvent = { at: Date.now(), event: "permissionRequest", session: "b1111111-demo", cwd: billing, terminal: "billing", tool: "powershell", detail: JSON.stringify({ command: "npm run migrate -- --env staging" }) };
  append(ask, home);
  void hold(ask, { home }, "npm run migrate -- --env staging");
}
