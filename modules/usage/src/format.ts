import type { TokenUseRow } from "@pi-spore/shared";

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

/** "in 45 min", "in 3 h 10 min", "in 2 d 4 h"; "passed" for a time before `now`. */
export function formatUntil(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "passed";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `in ${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** "950", "12.3k", "4.56M". */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Window names as people say them. */
export function windowTitle(name: string): string {
  if (name === "5h") return "5-hour";
  if (name === "7d") return "Weekly";
  return name;
}

/** "23 of 30 (77%)": the sample size sits next to the share. */
export function formatShare(count: number, total: number): string {
  return `${count} of ${total}${total > 0 ? ` (${Math.round((count / total) * 100)}%)` : ""}`;
}

/** The role a token row shows: its agent's role, "outside pi-spore" for a plain Pi session, else "unknown" (R18.3). */
export function roleLabel(row: TokenUseRow): string {
  return row.external ? "outside pi-spore" : (row.role ?? "unknown");
}

export type RoleSum = Pick<
  TokenUseRow,
  "provider" | "model" | "local" | "requests" | "input" | "output" | "cacheRead" | "cost"
> & { label: string };

/** Sums token rows per role and model, for the "by role" view. */
export function sumByRole(rows: readonly TokenUseRow[]): RoleSum[] {
  const sums = new Map<string, RoleSum>();
  for (const row of rows) {
    const label = roleLabel(row);
    const key = `${label}\u0000${row.provider}/${row.model}`;
    const sum = sums.get(key) ?? {
      label,
      provider: row.provider,
      model: row.model,
      local: row.local,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cost: 0,
    };
    sum.requests += row.requests;
    sum.input += row.input;
    sum.output += row.output;
    sum.cacheRead += row.cacheRead;
    sum.cost += row.cost;
    sums.set(key, sum);
  }
  return [...sums.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || b.input + b.output - (a.input + a.output),
  );
}
