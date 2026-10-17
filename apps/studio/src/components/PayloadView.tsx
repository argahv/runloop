import type { ReactNode } from 'react';
import { formatDuration } from '../state/timeline';
import styles from './PayloadView.module.css';

const MAX_DEPTH = 4;

/** "outputSummary" → "Output summary". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const looksLikeId = (s: string) => s.length <= 80 && !/\s/.test(s) && /[-_.:/#]|\d/.test(s);

function Value({ k, v, depth }: { k: string; v: unknown; depth: number }): ReactNode {
  if (v === null || v === undefined) return <span className={styles.none}>not reported</span>;
  if (typeof v === 'boolean') return <span>{v ? 'yes' : 'no'}</span>;
  if (typeof v === 'number') {
    if (/ms$/i.test(k) && Number.isFinite(v)) {
      return (
        <span>
          {formatDuration(v)} <span className={styles.raw}>({v} ms)</span>
        </span>
      );
    }
    if (/bytes$/i.test(k)) return <span>{v.toLocaleString()} bytes</span>;
    return <span>{v}</span>;
  }
  if (typeof v === 'string') {
    if (v === '') return <span className={styles.none}>empty</span>;
    if (v.length > 140 || v.includes('\n')) return <pre className={styles.block}>{v}</pre>;
    return looksLikeId(v) ? <code className={styles.code}>{v}</code> : <span>{v}</span>;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className={styles.none}>none</span>;
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      return (
        <span className={styles.list}>
          {v.map((x, i) => (
            <code key={i} className={styles.item}>
              {String(x)}
            </code>
          ))}
        </span>
      );
    }
    if (depth >= MAX_DEPTH) return <code className={styles.code}>{JSON.stringify(v)}</code>;
    return (
      <ol className={styles.nested}>
        {v.map((x, i) => (
          <li key={i}>
            <Value k={k} v={x} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof v === 'object') {
    if (depth >= MAX_DEPTH) return <code className={styles.code}>{JSON.stringify(v)}</code>;
    return <Fields value={v as Record<string, unknown>} depth={depth + 1} />;
  }
  return <span>{String(v)}</span>;
}

function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className={styles.none}>no fields</span>;
  return (
    <dl className={styles.fields} data-depth={depth}>
      {entries.map(([k, v]) => (
        <div key={k} className={styles.field}>
          <dt>{humanizeKey(k)}</dt>
          <dd>
            <Value k={k} v={v} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An event payload as labelled fields: exactly what was recorded, with missing values said in words. */
export default function PayloadView({ payload }: { payload: unknown }) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return <Fields value={payload as Record<string, unknown>} depth={0} />;
  return <Value k="" v={payload} depth={0} />;
}
