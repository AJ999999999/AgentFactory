// Trust ledger: per-agent track record computed only from git history.
//   commits       commits carrying an Agent: trailer
//   reverts       of those, how many were later reverted
//   survival      share of the agent's added lines still present at HEAD (git blame)
//   replay→revert changes that passed replay but were reverted anyway (criteria gaps)
import type { Git } from "./git.ts";
import { log } from "./git.ts";
import type { Policy } from "./policy.ts";

export type AgentRecord = { agent: string; commits: number; reverted: number; revertRate: number; linesAdded: number; linesSurviving: number; survival: number; replayPassedThenReverted: number; demoted: boolean };

export function computeLedger(git: Git, policy: Policy, rev = "HEAD"): AgentRecord[] {
  const commits = log(git, rev);
  const reverted = new Set<string>();
  for (const c of commits) {
    const m = c.body.match(/This reverts commit ([0-9a-f]{40})/);
    if (m) reverted.add(m[1]);
  }

  // Lines surviving at HEAD, attributed to the commit that last touched them.
  const surviving = new Map<string, number>();
  for (const file of git.listFiles(rev)) {
    if (file.startsWith(".agents/")) continue;
    const blame = git.run(["blame", "--line-porcelain", rev, "--", file]);
    for (const line of blame.split("\n")) {
      const m = line.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (m) surviving.set(m[1], (surviving.get(m[1]) ?? 0) + 1);
    }
  }

  const byAgent = new Map<string, AgentRecord>();
  for (const c of commits) {
    const agent = c.trailers["Agent"]?.[0];
    if (!agent || /^Revert /.test(c.subject)) continue;
    const rec = byAgent.get(agent) ?? { agent, commits: 0, reverted: 0, revertRate: 0, linesAdded: 0, linesSurviving: 0, survival: 0, replayPassedThenReverted: 0, demoted: false };
    rec.commits++;
    if (reverted.has(c.sha)) {
      rec.reverted++;
      if (c.trailers["Replay"]?.some((r) => r.startsWith("passed"))) rec.replayPassedThenReverted++;
    }
    const numstat = git.run(["show", "--numstat", "--format=", c.sha]);
    for (const l of numstat.split("\n")) {
      const [added, , file] = l.split("\t");
      if (file && !file.startsWith(".agents/") && added !== "-") rec.linesAdded += Number(added);
    }
    rec.linesSurviving += surviving.get(c.sha) ?? 0;
    byAgent.set(agent, rec);
  }

  for (const r of byAgent.values()) {
    r.revertRate = r.commits ? r.reverted / r.commits : 0;
    r.survival = r.linesAdded ? r.linesSurviving / r.linesAdded : 1;
    r.demoted = r.revertRate > policy.trust.demote_when.revert_rate_30d;
  }
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}
