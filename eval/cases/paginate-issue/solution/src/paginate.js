// Page `page` (counting from 1) of `size` items.
export function paginate(items, page, size) {
  if (!(page >= 1) || !(size >= 1)) throw new Error("page and size start at 1");
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages: Math.max(1, Math.ceil(items.length / size)) };
}
