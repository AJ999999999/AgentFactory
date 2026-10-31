// Reads CSV text with a header row into one object per row.
export function parseCsv(text) {
  const [head, ...body] = text.trim().split(/\r?\n/).map((line) => line.split(","));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").replace(/^"|"$/g, "")])));
}
