// Hidden checks for usage-docs: every `tally ...` line inside a code block is run.
export default (h) => {
  const examples = () => {
    if (!h.exists("docs/USAGE.md")) return [];
    const text = h.read("docs/USAGE.md");
    const out = [];
    for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const line of block[1].split(/\r?\n/)) {
        const m = line.trim().match(/^(?:\$\s*)?tally\s+(.+)$/);
        if (m) out.push(m[1].trim().split(/\s+/));
      }
    }
    return out;
  };
  const works = (args) => {
    const r = h.cli(...args);
    return r.code === 0 && r.out.trim().length > 0;
  };
  const covered = (pred) => {
    const ex = examples().filter(pred);
    h.ok(ex.length > 0, "no example");
    h.ok(ex.some(works), `no working example among: ${ex.map((a) => a.join(" ")).join(" | ")}`);
  };
  return [
    ["docs/USAGE.md has runnable examples", async () => h.ok(examples().length >= 3, `${examples().length} examples`)],
    ["every example works as written", async () => {
      const bad = examples().filter((a) => !works(a));
      h.ok(examples().length > 0 && bad.length === 0, `failing: ${bad.map((a) => a.join(" ")).join(" | ")}`);
    }],
    ["total", async () => covered((a) => a[0] === "total")],
    ["report", async () => covered((a) => a[0] === "report")],
    ["list with --page and --size", async () => covered((a) => a[0] === "list" && a.includes("--page") && a.includes("--size"))],
    ["shows real output", async () => h.ok(h.exists("docs/USAGE.md") && h.read("docs/USAGE.md").includes("1657.42"), "the total's output isn't shown")],
  ];
};
