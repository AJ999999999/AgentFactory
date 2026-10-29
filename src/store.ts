// Disposable query index. Rebuilt from committed git objects (never the working tree),
// so it can be deleted and recreated at any time: git is the truth, this is a cache.
import { DatabaseSync } from "node:sqlite";
import type { Git } from "./git.ts";
import { log } from "./git.ts";
import { LOCKFILE, parseBasisRef } from "./context.ts";
import type { BasisRecord, Lockfile } from "./context.ts";
import type { DecisionRecord } from "./decisions.ts";

export type Breakpoint = {
  artifact: string;
  builtBy: string;
  config: string;
  pinned: string;
  current: string;
};

export class Index {
  db: DatabaseSync;
  rev: string;

  constructor(file = ":memory:") {
    this.db = new DatabaseSync(file);
    this.rev = "";
    this.db.exec(`
      create table if not exists basis(task text, name text, version int, decision text, primary key(task, name, version));
      create table if not exists lockfiles(artifact text primary key, task text, built_by text, config text, built_at text);
      create table if not exists pins(artifact text, task text, name text, version int);
      create table if not exists decisions(id text primary key, kind text, subject text, status text, bound_commit text);
      create table if not exists commits(sha text primary key, author text, agent text, subject text, reverts text, replay text);
      create table if not exists commit_basis(sha text, ref text);
    `);
  }

  rebuild(git: Git, rev = "HEAD"): this {
    this.db.exec("delete from basis; delete from lockfiles; delete from pins; delete from decisions; delete from commits; delete from commit_basis;");
    this.rev = git.run(["rev-parse", rev]);
    const files = git.listFiles(rev);

    const insBasis = this.db.prepare("insert into basis values (?, ?, ?, ?)");
    const insLock = this.db.prepare("insert into lockfiles values (?, ?, ?, ?, ?)");
    const insPin = this.db.prepare("insert into pins values (?, ?, ?, ?)");
    const insDec = this.db.prepare("insert into decisions values (?, ?, ?, ?, ?)");

    for (const f of files) {
      if (f.startsWith(".agents/context/basis/") && f.endsWith(".json")) {
        const b = JSON.parse(git.show(rev, f)) as BasisRecord;
        insBasis.run(b.task, b.name, b.version, b.decision);
      } else if (f.endsWith(`/${LOCKFILE}`)) {
        const l = JSON.parse(git.show(rev, f)) as Lockfile;
        insLock.run(l.artifact, l.task, l.builtBy, l.config, l.builtAt);
        for (const ref of l.basis) {
          const p = parseBasisRef(ref);
          insPin.run(l.artifact, p.task, p.name, p.version);
        }
      } else if (f.startsWith(".agents/decisions/") && f.endsWith(".json")) {
        const d = JSON.parse(git.show(rev, f)) as DecisionRecord;
        insDec.run(d.id, d.kind, d.subject, d.status, d.boundCommit);
      }
    }

    const insCommit = this.db.prepare("insert or ignore into commits values (?, ?, ?, ?, ?, ?)");
    const insCB = this.db.prepare("insert into commit_basis values (?, ?)");
    for (const c of log(git, rev)) {
      const reverts = c.body.match(/This reverts commit ([0-9a-f]{40})/)?.[1] ?? null;
      insCommit.run(c.sha, c.author, c.trailers["Agent"]?.[0] ?? null, c.subject, reverts, c.trailers["Replay"]?.[0] ?? null);
      for (const ref of c.trailers["Basis"] ?? []) insCB.run(c.sha, ref);
    }
    return this;
  }

  // Observator's core query: artifacts pinned to a basis version older than current.
  breakpoints(): Breakpoint[] {
    const rows = this.db
      .prepare(`
        with cur as (select task, name, max(version) v from basis group by task, name)
        select l.artifact, l.built_by, l.config, p.task, p.name, p.version pinned, cur.v current
        from pins p
        join cur on cur.task = p.task and cur.name = p.name
        join lockfiles l on l.artifact = p.artifact
        where p.version < cur.v
        order by l.artifact`)
      .all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      artifact: String(r.artifact),
      builtBy: String(r.built_by),
      config: String(r.config),
      pinned: `${r.task}/${r.name}@v${r.pinned}`,
      current: `${r.task}/${r.name}@v${r.current}`,
    }));
  }

  // Commits whose trailer pins a superseded basis (history view of the same problem).
  commitsOnStaleBasis(): Array<{ sha: string; ref: string }> {
    const rows = this.db.prepare("select sha, ref from commit_basis").all() as Array<{ sha: string; ref: string }>;
    const cur = new Map<string, number>();
    for (const r of this.db.prepare("select task, name, max(version) v from basis group by task, name").all() as Array<{ task: string; name: string; v: number }>) {
      cur.set(`${r.task}/${r.name}`, r.v);
    }
    return rows.filter((r) => {
      const p = parseBasisRef(r.ref);
      return (cur.get(`${p.task}/${p.name}`) ?? 0) > p.version;
    });
  }

  close(): void {
    this.db.close();
  }
}
