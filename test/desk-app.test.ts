// The desk as an app of its own: its own window, one desk at a time, a Start menu entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appBrowsers, findAppBrowser, runningDesk, shortcutScript } from "../src/desk/app.ts";
import { startDesk } from "../src/desk/server.ts";

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-app-${n}-`));

test("on Windows the desk's window is Edge's app mode first, then Chrome's, from where Windows installs them", () => {
  const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\jack\\AppData\\Local" };
  const list = appBrowsers(env, "win32");
  assert.equal(list[0], "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.ok(list.indexOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") > list.indexOf("C:\\Users\\jack\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe"));
  const dir = tmp("browsers");
  const chrome = path.join(dir, "chrome");
  fs.writeFileSync(chrome, "");
  assert.equal(findAppBrowser([path.join(dir, "msedge"), chrome]), chrome, "the first one that exists");
  assert.equal(findAppBrowser([path.join(dir, "nothing")]), undefined, "none: the desk opens a tab instead");
});

test("a second start finds the desk already running from its beat, and ignores a stale beat or a dead process", () => {
  const home = tmp("running");
  const now = Date.now();
  fs.writeFileSync(path.join(home, "page.json"), JSON.stringify({ at: now - 2_000, pid: process.pid, url: "http://127.0.0.1:4710/" }));
  assert.deepEqual(runningDesk(home, now), { url: "http://127.0.0.1:4710/", pid: process.pid });
  assert.equal(runningDesk(home, now + 60_000), undefined, "a beat older than 15 seconds is a desk that stopped");
  fs.writeFileSync(path.join(home, "page.json"), JSON.stringify({ at: now, pid: 2 ** 22 + 12345, url: "http://127.0.0.1:4710/" }));
  assert.equal(runningDesk(home, now), undefined, "its process is gone");
});

test("the Start menu shortcut runs the desk's app command with its key, and quotes paths with apostrophes", () => {
  const s = shortcutScript({ node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\Users\\o'neil\\AgentFactory\\src\\desk\\cli.ts", key: "Ctrl+Alt+D", folder: "C:\\Users\\o'neil\\Start Menu\\Programs" });
  assert.match(s, /CreateShortcut\('C:\\Users\\o''neil\\Start Menu\\Programs\\AgentFactory desk\.lnk'\)/);
  assert.match(s, /\$s\.Arguments = '--no-warnings "C:\\Users\\o''neil\\AgentFactory\\src\\desk\\cli\.ts" app'/);
  assert.match(s, /\$s\.Hotkey = 'Ctrl\+Alt\+D'/);
  assert.match(s, /\$s\.WindowStyle = 7/, "the console it starts from stays minimized");
});

test("the desk serves a manifest and an icon, so the browser can install it as an app", async (t) => {
  const desk = await startDesk({ home: tmp("manifest"), port: 0, learnEveryMs: 3_600_000 });
  t.after(() => desk.close());
  const page = await (await fetch(desk.url)).text();
  assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  const res = await fetch(new URL("/manifest.webmanifest", desk.url));
  assert.equal(res.headers.get("content-type"), "application/manifest+json");
  assert.match(res.headers.get("content-security-policy") ?? "", /manifest-src 'self'/);
  const m = await res.json();
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal((await fetch(new URL("/icon.svg", desk.url))).headers.get("content-type"), "image/svg+xml");
});
