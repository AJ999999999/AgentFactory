// node:test reporter for GitHub Actions: one error annotation per failed test, and a
// notice with the totals, so results can be read from the checks API without the logs.
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export default async function* annotations(source) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failed = [];
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    if (ev.data.details?.type === "suite") continue;
    if (ev.data.skip || ev.data.todo) {
      skip++;
      continue;
    }
    if (ev.type === "test:pass") {
      pass++;
      continue;
    }
    fail++;
    const err = ev.data.details?.error;
    const cause = err?.cause ?? err;
    const msg = [cause?.message ?? String(cause), ...String(cause?.stack ?? "").split("\n").slice(1, 6)].join("\n").slice(0, 3000);
    failed.push(ev.data.name);
    const file = ev.data.file ? ev.data.file.replace(process.cwd(), "").replace(/^[\\/]/, "").replace(/\\/g, "/") : "";
    yield `::error ${file ? `file=${prop(file)},line=${ev.data.line ?? 1},` : ""}title=${prop(`${process.platform}: ${ev.data.name}`)}::${esc(msg)}\n`;
  }
  const names = failed.length ? ` failed: ${failed.join(" | ")}` : "";
  yield `::notice title=${prop(`tests on ${process.platform}`)}::${esc(`pass ${pass}, fail ${fail}, skip ${skip}.${names}`.slice(0, 4000))}\n`;
}
