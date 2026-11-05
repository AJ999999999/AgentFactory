// Writing back to Jira: a comment on a ticket and a change of its status, for a playbook
// run (playbook.ts). Only the loop does this, with a token of its own, after the partner
// said send. No turn can reach Jira.
//
// A comment that went out is never sent twice: once it's posted the job has succeeded,
// even if the status couldn't be changed. A status Jira doesn't offer (its workflow
// changed) is noted, with the ones it does offer, for the partner to fix the mapping.
import type { JobOutcome, JobProvider } from "./world.ts";
import type { TodoState } from "./project.ts";

export type JiraWriteSpec = { source: string; url: string; tokenEnv: string; cloud?: { email: string }; ticket: string; comment?: string; transition?: string };
type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

// Cloud's v3 API takes a comment as a document: one paragraph per block of text.
export function adf(text: string): unknown {
  return { type: "doc", version: 1, content: text.split(/\n\s*\n/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p.trim() }] })).filter((p) => p.content[0].text) };
}

export class JiraWriter implements JobProvider {
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  private done = new Map<string, JobOutcome>();
  constructor(o: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}) {
    this.env = o.env ?? process.env;
    this.fetch = o.fetch ?? ((u, i) => fetch(u, i) as ReturnType<Fetch>);
  }

  async start(todo: TodoState, now: number): Promise<string> {
    const spec = todo.job?.spec?.jira as JiraWriteSpec | undefined;
    const handle = `jira|${todo.id}|${now}`;
    this.done.set(handle, await this.write(spec).catch((e: Error) => ({ status: "failed" as const, metrics: {}, note: e.message.slice(0, 300) })));
    return handle;
  }

  async poll(handle: string): Promise<JobOutcome> {
    const r = this.done.get(handle);
    this.done.delete(handle);
    // Lost to a restart: whether it went out isn't known, so the partner looks rather than
    // a second comment going out.
    return r ?? { status: "succeeded", metrics: { unknown: 1 }, note: "the loop restarted before this was confirmed: check the ticket in Jira" };
  }

  private async write(spec?: JiraWriteSpec): Promise<JobOutcome> {
    if (!spec?.ticket || !spec.url) throw new Error("no ticket to write to");
    const token = this.env[spec.tokenEnv];
    if (!token) throw new Error(`set ${spec.tokenEnv} to a Jira token that can comment and change status`);
    const v = spec.cloud ? 3 : 2;
    const auth = spec.cloud ? `Basic ${Buffer.from(`${spec.cloud.email}:${token}`).toString("base64")}` : `Bearer ${token}`;
    const base = `${spec.url.replace(/\/+$/, "")}/rest/api/${v}/issue/${encodeURIComponent(spec.ticket)}`;
    const call = (p: string, method = "GET", body?: unknown) => this.fetch(`${base}${p}`, { method, headers: { Authorization: auth, Accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const metrics: Record<string, number> = { commented: 0, moved: 0 };
    const notes: string[] = [];
    if (spec.comment) {
      const res = await call("/comment", "POST", { body: spec.cloud ? adf(spec.comment) : spec.comment });
      if (!res.ok) throw new Error(`Jira refused the comment on ${spec.ticket}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      metrics.commented = 1;
      notes.push(`commented on ${spec.ticket}`);
    }
    if (spec.transition) {
      try {
        const res = await call("/transitions");
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
        const list = ((await res.json()) as { transitions?: Array<{ id: string; name?: string; to?: { name?: string } }> }).transitions ?? [];
        const want = spec.transition.toLowerCase();
        const tr = list.find((x) => x.name?.toLowerCase() === want || x.to?.name?.toLowerCase() === want);
        if (!tr) throw new Error(`no transition to "${spec.transition}" (Jira offers: ${list.map((x) => x.to?.name ?? x.name).join(", ") || "none"}): has the workflow changed? Fix statuses in the source's config`);
        const moved = await call("/transitions", "POST", { transition: { id: tr.id } });
        if (!moved.ok) throw new Error(`${moved.status} ${(await moved.text()).slice(0, 160)}`);
        metrics.moved = 1;
        notes.push(`moved ${spec.ticket} to "${spec.transition}"`);
      } catch (e) {
        // Nothing was posted yet: let the job fail, so it's tried again.
        if (!metrics.commented) throw new Error(`couldn't move ${spec.ticket}: ${(e as Error).message}`);
        notes.push(`couldn't move ${spec.ticket}: ${(e as Error).message}`);
      }
    }
    return { status: "succeeded", metrics, note: notes.join("; ").slice(0, 300) };
  }
}
