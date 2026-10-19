/**
 * Source scan behind the purity tests of packages/town and packages/sim
 * (plan §9 Determinism): no clock, randomness, timers, locale, I/O or
 * transcendental Math in the pure packages. Comments are ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TRANSCENDENTAL = 'sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot';

export const BANNED: readonly { rule: string; re: RegExp }[] = [
  { rule: 'Date', re: /\bDate\b/ },
  { rule: 'Math.random', re: /\bMath\.random\b/ },
  { rule: 'performance', re: /\bperformance\b/ },
  { rule: 'transcendental Math', re: new RegExp(`\\bMath\\.(${TRANSCENDENTAL})\\b`) },
  { rule: 'timers', re: /\b(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|queueMicrotask|requestAnimationFrame)\b/ },
  { rule: 'process', re: /\bprocess\./ },
  { rule: 'crypto', re: /\bcrypto\b/ },
  { rule: 'locale', re: /\b(Intl|toLocale\w*|localeCompare)\b/ },
  { rule: 'fetch', re: /\bfetch\s*\(/ },
  { rule: 'dynamic import or require', re: /\b(import|require)\s*\(/ },
];

/** Source without comments (string contents are kept; the pure packages hold no URLs). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Module specifiers imported or re-exported by a file. */
export function importsOf(src: string): string[] {
  return [...stripComments(src).matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

export function violations(src: string): string[] {
  const code = stripComments(src);
  return BANNED.filter(({ re }) => re.test(code)).map(({ rule }) => rule);
}

/** Every non-test .ts file under `dir`. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

export function scan(dir: string): { file: string; problems: string[]; imports: string[] }[] {
  return sourceFiles(dir).map((file) => {
    const src = readFileSync(file, 'utf8');
    return { file: path.relative(dir, file), problems: violations(src), imports: importsOf(src) };
  });
}
