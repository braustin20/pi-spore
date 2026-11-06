/** A short, lowercase, path- and branch-safe form of a name. Never empty. */
export function slugify(name: string, maxLength = 40): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
  return slug || "work";
}
