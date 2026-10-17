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
  run: () => void;
}

/**
 * Commands matching `query`: every term must appear in the label, group or
 * keywords. Label-prefix matches rank first, then word-start matches, then the
 * rest, keeping the original order within a rank. An empty query keeps all.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];
  const scored: { c: Command; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.group.toLowerCase()} ${(c.keywords ?? '').toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) return;
    const first = terms[0]!;
    const score = label.startsWith(first) ? 0 : new RegExp(`(^|[\\s·#/-])${escapeRe(first)}`).test(label) ? 1 : 2;
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.c);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
