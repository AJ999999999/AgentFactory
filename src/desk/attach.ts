// A window on a session the desk drives: `npm run desk -- attach <name>` in a
// PowerShell window (copilot-here.ps1 runs it). It starts the session in this folder if
// there isn't one by that name, shows the conversation as it happens, and takes what
// you type: a prompt, an answer to an ask, or a command.
//
//   <text>          a prompt (waits in line while a turn runs)
//   1, 2, 3 …       an option of the open ask, or of the numbered list Copilot ended on
//   a               allow the open ask's command (or tool) in this session from now on
//   d <why>         deny the open ask and tell Copilot why
//   /stop           stop the turn (Esc in Copilot's own screen)
//   /mode, /model   show or change them; /set <setting> <value> for any other
//   /tui            hand the session to Copilot's own screen here; quit it to come back
//   /close          end the session (learning reads it)
//   /quit, Ctrl+C   leave this window; the session goes on on the desk
//
// The desk owns the session (as Herdr's server owns its panes), so this window can
// close and another can attach, and the page can answer what this window shows: the
// first answer wins.
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { resolveCommand } from "../proc.ts";
import type { DrivenAsk, DrivenView, Item } from "./driven.ts";
import { PAGE_FRESH_MS, pageFile, readJson } from "./hold.ts";
import { deskHome } from "./log.ts";

export type DeskLink = { url: string; token: string };

// The running desk, from the file it beats.
export function findDesk(home = deskHome(), now = Date.now()): DeskLink | undefined {
  const p = readJson<{ at?: number; url?: string; token?: string }>(pageFile(home), {});
  return p.url && p.token && typeof p.at === "number" && now - p.at < PAGE_FRESH_MS ? { url: p.url, token: p.token } : undefined;
}

class DeskError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T = Record<string, unknown>>(link: DeskLink, path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(new URL(path, link.url), body === undefined ? { headers: { "x-desk-token": link.token } } : { method: "POST", headers: { "x-desk-token": link.token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok) throw new DeskError(out.error ?? `HTTP ${res.status}`, res.status);
  return out;
}

export type AttachOptions = {
  home?: string;
  link?: DeskLink;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  copilot?: string;
  // Copilot's own screen for /tui; tests replace it.
  screen?: (args: string[], cwd: string, name: string) => Promise<number | null>;
  history?: number;
};

export type AttachEnd = "detached" | "closed" | "no-desk" | "failed";

// Copilot's own screen in this window, on the same session.
export function copilotScreen(copilot = "copilot") {
  return (args: string[], cwd: string, name: string) =>
    new Promise<number | null>((resolve) => {
      const r = resolveCommand(copilot);
      const env = { ...process.env, AF_DESK_TERMINAL: name };
      delete env.AF_DESK_DRIVEN;
      const child = spawn(r.file, [...r.prefix, ...args], { cwd, env, stdio: "inherit" });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
}

export async function attach(name: string, cwd: string, opts: AttachOptions = {}): Promise<AttachEnd> {
  const link = opts.link ?? findDesk(opts.home);
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const tty = !!(out as NodeJS.WriteStream).isTTY && !!(input as NodeJS.ReadStream).isTTY;
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
  const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const plain = (s: string) => out.write(s);
  if (!link) return "no-desk";
  const q = encodeURIComponent(name);

  let first: { view: DrivenView; items: Item[] };
  try {
    first = await call(link, `/api/drive/watch?name=${q}&rev=0&wait=0`);
  } catch (e) {
    if (!(e instanceof DeskError) || e.status !== 404) {
      plain(`can't reach the desk: ${(e as Error).message}\n`);
      return "no-desk";
    }
    plain(dim(`starting ${name} in ${cwd} …\n`));
    try {
      await call(link, "/api/drive/start", { name, cwd });
      first = await call(link, `/api/drive/watch?name=${q}&rev=0&wait=0`);
    } catch (e2) {
      plain(red(`couldn't start Copilot for the desk: ${(e2 as Error).message}\n`));
      return "failed";
    }
  }
  if (out === process.stdout) process.title = `copilot: ${name}`;

  let view = first.view;
  let rev = 0;
  let maxN = 0;
  const printed = new Map<number, number>(); // agent items: characters shown
  const shown = new Map<number, string>(); // other items: the status last shown
  const asksShown = new Set<string>();
  let rl: readline.Interface | undefined;
  let away = false;
  let ended: AttachEnd | undefined;
  let finish!: (e: AttachEnd) => void;
  const done = new Promise<AttachEnd>((r) => (finish = r));

  const write = (s: string) => {
    if (!s || away) return;
    if (tty && rl) {
      readline.clearLine(out, 0);
      readline.cursorTo(out, 0);
    }
    out.write(s);
    if (tty && rl) rl.prompt(true);
  };

  const askBlock = (a: DrivenAsk) => {
    if (a.kind === "permission") {
      const lines = [`${bold(`── ${name} asks:`)} ${a.command ?? a.title}`, ...(a.detail ? [dim(`   ${a.detail.slice(0, 400)}`)] : [])];
      a.options.forEach((o, i) => lines.push(`   ${i + 1}  ${o.name}`));
      if (a.always) lines.push(`   a  Allow ${a.always.prefix ? `"${a.always.prefix} …"` : `every ${a.tool}`} in ${name} from now on`);
      lines.push(`   d <why>  Deny and tell it why`);
      return lines.join("\n") + "\n";
    }
    const fields = Object.entries(a.fields);
    const lines = [`${bold(`── ${name} asks:`)} ${a.message}`];
    if (fields.length === 1) {
      const [key, f] = fields[0];
      const opts = f.enum ?? f.oneOf?.map((o) => o.const);
      lines.push(opts ? `   ${f.title ?? key}: ${opts.map((v, i) => `${i + 1} ${String(v)}`).join(" · ")}` : `   ${f.title ?? key}: type your answer`);
      lines.push(dim(`   or "decline"`));
    } else lines.push(dim("   a form with several fields: answer it on the desk"));
    return lines.join("\n") + "\n";
  };

  const show = (items: Item[], history = false) => {
    const later = (n: number) => n < maxN || !["working", "waiting on you", "starting"].includes(view.state);
    let s = "";
    for (const it of items) {
      maxN = Math.max(maxN, it.n);
      if (history) {
        if (it.type === "agent") printed.set(it.n, it.text.length);
        shown.set(it.n, it.status ?? "");
        continue;
      }
      switch (it.type) {
        case "agent": {
          const from = printed.get(it.n) ?? 0;
          const all = later(it.n) || items.some((x) => x.n > it.n);
          const upto = all ? it.text.length : it.text.lastIndexOf("\n") + 1;
          if (upto > from) {
            s += it.text.slice(from, upto);
            if (all && !it.text.endsWith("\n")) s += "\n";
            printed.set(it.n, upto);
          }
          break;
        }
        case "thought":
          break;
        default: {
          const st = `${it.status ?? ""}${it.queued ? "q" : ""}`;
          if (shown.get(it.n) === st) break;
          const firstTime = !shown.has(it.n);
          shown.set(it.n, st);
          if (it.type === "you") s += firstTime ? `${bold(`› ${it.text}`)}${it.queued ? dim(" (sent when this turn ends)") : ""}\n` : it.status ? dim(`  (${it.status})\n`) : "";
          else if (it.type === "tool") s += firstTime ? dim(`  ▸ ${it.text}\n`) : it.status === "failed" ? red(`  ✗ ${it.text}\n`) : "";
          else if (it.type === "plan") s += firstTime ? dim(it.text.split("\n").map((l) => `  ${l}`).join("\n") + "\n") : "";
          else if (it.type === "ask") s += !firstTime || it.status !== "waiting" ? dim(`  → ${it.status === "waiting" ? "" : it.status}\n`) : "";
          else if (it.type === "note") s += dim(`  ${/note/.test(it.text.slice(0, 16)) ? "✉" : "·"} ${it.text}\n`);
          else if (it.type === "end") s += dim(it.text === "end_turn" ? "── finished\n" : it.text === "cancelled" ? "── stopped\n" : `── ended: ${it.text}\n`);
          else if (it.type === "error") s += red(`!! ${it.text}\n`);
        }
      }
    }
    for (const a of view.asks) {
      if (asksShown.has(a.id)) continue;
      asksShown.add(a.id);
      s += askBlock(a);
    }
    if (!history && view.choices.length && items.some((i) => i.type === "end")) s += dim(`   reply with a number (1–${view.choices.length}) or in your words\n`);
    write(s);
  };

  const header = `${bold(name)} ${dim(`· ${view.cwd} · ${view.state}`)}\n${dim("a prompt, a number for an option, /help; Ctrl+C leaves it running on the desk")}\n`;
  plain(header);
  const keep = opts.history ?? 12;
  const old = first.items.slice(0, Math.max(0, first.items.length - keep));
  show(old, true);
  show(first.items.slice(old.length));
  rev = view.rev;

  // Following the session: whatever changed since the last look.
  const watch = async () => {
    while (!ended) {
      try {
        const r = await call<{ view: DrivenView; items: Item[] }>(link, `/api/drive/watch?name=${q}&rev=${rev}&wait=20000`);
        if (ended) break;
        view = r.view;
        rev = r.view.rev;
        if (!away) show(r.items);
        if (view.state === "closed") return end("closed");
      } catch (e) {
        if (ended) break;
        if (e instanceof DeskError && e.status === 404) return end("closed");
        write(red(`lost the desk (${(e as Error).message}); trying again …\n`));
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  const post = async (what: string, body: Record<string, unknown> = {}) => {
    try {
      return await call(link, `/api/drive/${what}`, { name, ...body });
    } catch (e) {
      write(red(`${(e as Error).message}\n`));
      return undefined;
    }
  };

  const settings = () => {
    const lines: string[] = [];
    for (const o of view.config ?? []) {
      if (o.type !== "select" || !o.options) continue;
      const vals = o.options.flatMap((x) => ("options" in x && x.options ? x.options : [x as { value: string; name: string }]));
      lines.push(`   ${o.id}: ${vals.map((v) => (v.value === o.currentValue ? bold(v.value) : v.value)).join(" · ")}`);
    }
    if (view.modes && !(view.config ?? []).some((o) => o.category === "mode")) lines.push(`   mode: ${view.modes.availableModes.map((m) => (m.id === view.modes!.currentModeId ? bold(m.id) : m.id)).join(" · ")}`);
    return lines.length ? lines.join("\n") + "\n" : "   Copilot offers no settings here\n";
  };
  const optionFor = (category: string) => view.config?.find((o) => o.category === category || o.id === category)?.id;

  const tui = async () => {
    const h = (await post("handoff")) as { session?: string; cwd?: string } | undefined;
    if (!h?.session) return;
    write(dim(`── Copilot's own screen on this session; quit it (/exit) to come back here\n`));
    away = true;
    rl?.close();
    rl = undefined;
    await (opts.screen ?? copilotScreen(opts.copilot))(["--resume", h.session], h.cwd ?? cwd, name);
    away = false;
    await post("back");
    write(dim(`── back on the desk\n`));
    if (!ended) open();
  };

  const line = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const ask = view.asks[0];
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "help":
          return write(dim("a prompt · 1,2,3 an option · a allow from now on · d <why> deny · /stop · /mode [id] · /model [id] · /set <setting> <value> · /tui Copilot's own screen · /close · /quit\n"));
        case "stop":
          return void (await post("stop"));
        case "quit":
        case "exit":
        case "detach":
          return end("detached");
        case "close":
          await post("close");
          return end("closed");
        case "tui":
          return tui();
        case "settings":
          return write(settings());
        case "mode":
        case "model": {
          const id = cmd === "mode" ? optionFor("mode") ?? (view.modes ? "mode" : undefined) : optionFor("model");
          if (!id) break; // not a setting here: Copilot's own command
          if (!arg) return write(settings());
          return void (await post("set", { option: id, value: arg }));
        }
        case "set":
          if (rest.length < 2) return write(settings());
          return void (await post("set", { option: rest[0], value: rest.slice(1).join(" ") }));
      }
      if (!(view.commands ?? []).includes(cmd)) return write(red(`no command /${cmd} here (/help)\n`));
      // One of Copilot's own commands it runs over ACP: sent as a prompt.
    }
    if (ask?.kind === "permission") {
      if (/^\d+$/.test(text)) {
        const o = ask.options[Number(text) - 1];
        if (!o) return write(red(`1 to ${ask.options.length}\n`));
        return void (await post("answer", { ask: ask.id, option: o.optionId }));
      }
      if (text === "a") return void (await post("answer", { ask: ask.id, always: true }));
      const deny = /^(d|deny)(\s+(.*))?$/s.exec(text);
      if (deny) return void (await post("answer", { ask: ask.id, deny: true, ...(deny[3] ? { note: deny[3] } : {}) }));
      return write(red(`answer the ask first: a number, a, or d <why> (or /stop)\n`));
    }
    if (ask?.kind === "question") {
      const fields = Object.entries(ask.fields);
      if (text === "decline") return void (await post("reply", { ask: ask.id, action: "decline" }));
      if (fields.length !== 1) return write(red("answer this form on the desk\n"));
      const [key, f] = fields[0];
      const opts = f.enum ?? f.oneOf?.map((o) => o.const);
      const value = opts && /^\d+$/.test(text) ? opts[Number(text) - 1] : f.type === "number" || f.type === "integer" ? Number(text) : f.type === "boolean" ? /^(y|yes|true|1)$/i.test(text) : text;
      if (value === undefined) return write(red(`1 to ${opts!.length}\n`));
      return void (await post("reply", { ask: ask.id, action: "accept", content: { [key]: value } }));
    }
    if (/^\d$/.test(text) && view.choices.length && Number(text) <= view.choices.length) {
      const n = Number(text);
      return void (await post("prompt", { text: `${n}. ${view.choices[n - 1]}` }));
    }
    await post("prompt", { text });
  };

  // Lines run one at a time, in the order typed.
  let queue = Promise.resolve();
  const open = () => {
    rl = readline.createInterface({ input, output: out, terminal: tty, prompt: `${name}› ` });
    rl.on("line", (l) => (queue = queue.then(() => line(l)).catch((e) => write(red(`${(e as Error).message}\n`)))));
    rl.on("SIGINT", () => end("detached"));
    rl.on("close", () => {
      if (!away) void queue.then(() => end("detached"));
    });
    if (tty) rl.prompt();
  };
  const end = (why: AttachEnd) => {
    if (ended) return;
    ended = why;
    rl?.close();
    if (why === "detached") plain(dim(`\nleft ${name} running on the desk; npm run desk -- attach ${name} to come back\n`));
    if (why === "closed") plain(dim(`\n${name} is closed\n`));
    finish(why);
  };

  open();
  void watch();
  return done;
}
