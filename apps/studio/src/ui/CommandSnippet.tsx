'use client';
import { useState } from 'react';
import { Button } from './Button';
import styles from './CommandSnippet.module.css';

/**
 * A command in mono with a copy button. `prompt` is the glyph before it: `$`
 * for a shell (default), `>` for something typed inside Claude Code.
 */
export function CommandSnippet({ command, label, prompt = '$' }: { command: string; label?: string; prompt?: '$' | '>' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1800);
  };
  return (
    <div className={styles.snippet}>
      {label && <span className={styles.label}>{label}</span>}
      <code className={styles.code}>
        <span className={styles.prompt} aria-hidden="true">
          {prompt}
        </span>
        {command}
      </code>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon={state === 'copied' ? 'check' : state === 'failed' ? 'x' : 'copy'}
        aria-label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : `Copy command: ${command}`}
        onClick={() => void copy()}
      />
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied to the clipboard' : state === 'failed' ? 'Could not copy' : ''}
      </span>
    </div>
  );
}
