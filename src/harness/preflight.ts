// Preflight: the setup problems that would otherwise surface one failed turn at a time.
// The first real eval lost turns to each of these before anyone noticed:
//   - an installed agent profile Copilot couldn't read (every turn of that role failed)
//   - an installed profile older than the repo's (fixed in the repo, still broken in use)
//   - the local model gateway Codex goes through had stopped (an hour of reconnecting per turn)
// It's cheap (file reads and one TCP connect per gateway), so the loop and the eval run it
// before starting work and again every so often.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { vendorOfModel } from "./agents.ts";
import type { AgentsConfig } from "./setup.ts";
import { codexUserProvider } from "./vendors.ts";

export type Problem = {
  vendor: string; // whose turns it holds up
  kind: "setup" | "unreachable";
  what: string;
  fix: string;
};

// Copilot refuses a profile whose front matter doesn't parse: an unquoted value with ": "
// in it was enough. The same rule the repo's own profiles are tested against.
export function lintProfile(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return "no front matter";
  for (const line of m[1].split(/\r?\n/).filter((l) => l.trim())) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) return `not a key: value line: ${line.slice(0, 80)}`;
    const v = kv[2];
    const quoted = /^".*"$/.test(v) || /^'.*'$/.test(v);
    if (!quoted && /: |#/.test(v)) return `${kv[1]} needs quotes: ${v.slice(0, 80)}`;
  }
  return null;
}

const hash = (t: string) => crypto.createHash("sha256").update(t.replace(/\r\n/g, "\n")).digest("hex");

// The af-* profiles Copilot will load from your user folder: readable, and the same as the
// repo's copy of each.
export function profileProblems(installedDir: string, repoDir: string, prefix = "af-"): Problem[] {
  if (!fs.existsSync(installedDir)) return [];
  const out: Problem[] = [];
  for (const f of fs.readdirSync(installedDir).filter((x) => x.startsWith(prefix) && x.endsWith(".agent.md")).sort()) {
    const text = fs.readFileSync(path.join(installedDir, f), "utf8");
    const bad = lintProfile(text);
    const repo = path.join(repoDir, f);
    if (bad) out.push({ vendor: "copilot", kind: "setup", what: `agent profile ${f} can't be loaded: ${bad}`, fix: "npm run harness -- agents install" });
    else if (fs.existsSync(repo) && hash(fs.readFileSync(repo, "utf8")) !== hash(text)) {
      out.push({ vendor: "copilot", kind: "setup", what: `agent profile ${f} is older or newer than the repo's copy`, fix: "npm run harness -- agents install" });
    }
  }
  return out;
}

// A stale profile still loads, so it's worth knowing but no reason to hold turns.
export const holds = (p: Problem) => !/older or newer/.test(p.what);

// Can a TCP connection be opened to this URL's host and port? null when it can.
export function reachable(url: string, timeoutMs = 3_000): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(`not a URL: ${url}`);
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (err: string | null) => {
      sock.destroy();
      resolve(err);
    };
    sock.setTimeout(timeoutMs, () => done(`no answer from ${host}:${port} in ${timeoutMs / 1000}s`));
    sock.once("connect", () => done(null));
    sock.once("error", (e) => done(`${host}:${port}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
  });
}

// The base URL of the provider your Codex config routes turns through, if it names one.
export function codexGateway(home?: string): { name: string; url: string } | null {
  const p = codexUserProvider(home);
  const s = p?.settings.find((x) => /\.base_url=/.test(x));
  if (!p || !s) return null;
  return { name: p.name, url: s.slice(s.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") };
}

export type PreflightOptions = {
  agents: AgentsConfig;
  installedDir: string; // where Copilot loads your profiles from
  repoDir: string; // integrations/copilot/harness-agents
  codexHome?: string;
  timeoutMs?: number;
};

export async function preflight(o: PreflightOptions): Promise<Problem[]> {
  const vendors = new Set(Object.values(o.agents.models ?? {}).map(vendorOfModel));
  if (!Object.keys(o.agents.models ?? {}).length) vendors.add("copilot");
  const out: Problem[] = [];
  if (vendors.has("copilot")) out.push(...profileProblems(o.installedDir, o.repoDir, o.agents.profilePrefix ?? "af-"));
  if (vendors.has("codex") && o.agents.cli?.codex?.userProvider !== false) {
    const gw = codexGateway(o.codexHome);
    if (gw) {
      const err = await reachable(gw.url, o.timeoutMs);
      if (err) out.push({ vendor: "codex", kind: "unreachable", what: `Codex's provider ${gw.name} (${gw.url}) isn't answering: ${err}`, fix: `start the ${gw.name} gateway; Codex turns wait until it answers` });
    }
  }
  return out;
}

// The model placeholders whose turns a vendor's problem holds up.
export function modelsOf(agents: AgentsConfig, vendor: string): string[] {
  return Object.keys(agents.models ?? {}).filter((m) => vendorOfModel(agents.models![m]) === vendor);
}
