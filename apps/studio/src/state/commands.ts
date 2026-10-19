/** A command palette entry. Commands are built in components (they need the router and the store). */
export interface Command {
  id: string;
  group: string;
  label: string;
  /** Extra words that should find this command. */
  keywords?: string;
  /** Short right-aligned note (e.g. "current", a status). */
  hint?: string;
  /** Keys shown as a shortcut hint, e.g. ['⌘', 'K']. */
  shortcut?: readonly string[];
  disabled?: boolean;
  /** Only listed for a query (e.g. the town's many entities), at most SEARCH_ONLY_LIMIT of them. */
  searchOnly?: boolean;
  run: () => void;
}

/** How many search-only matches a query shows (UX: ⌘K finds at most 20 entities). */
export const SEARCH_ONLY_LIMIT = 20;

/**
 * Commands matching `query`: every term must appear in the label, group or
 * keywords. Label-prefix matches rank first, then word-start matches, then the
 * rest, keeping the original order within a rank. An empty query keeps all.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands.filter((c) => !c.searchOnly);
  const scored: { c: Command; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.group.toLowerCase()} ${(c.keywords ?? '').toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) return;
    const first = terms[0]!;
    const score = label.startsWith(first) ? 0 : new RegExp(`(^|[\\s·#/-])${escapeRe(first)}`).test(label) ? 1 : 2;
    scored.push({ c, score, i });
  });
  let searchOnly = 0;
  return scored
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.c)
    .filter((c) => !c.searchOnly || ++searchOnly <= SEARCH_ONLY_LIMIT);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
