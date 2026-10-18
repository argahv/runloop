/**
 * `?ui=1` on the sound board: the HUD speaker toggle and the Esc menu's Sound
 * tab, mounted alone over a daytime-sky backdrop (to review them before the
 * HUD wires them in). `&theme=light` for the light theme.
 */
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '../../app/tokens.css';
import '../../app/globals.css';
import { SoundSettings, SoundToggle } from '../react';

const glass: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px 6px 12px',
  borderRadius: 12,
  background: 'var(--rl-glass)',
  border: '1px solid var(--rl-glass-line)',
  backdropFilter: 'blur(14px) saturate(1.2)',
  color: 'var(--rl-text-muted)',
  boxShadow: 'var(--rl-shadow-pop)',
};

function Preview() {
  return (
    <div style={{ display: 'grid', gap: 20, justifyItems: 'start', padding: 24, borderRadius: 16, background: 'linear-gradient(#86aeda, #c9d9e4 45%, #a7bf86 60%, #6f8c55)' }}>
      <div style={glass} role="group" aria-label="World clock (mock)">
        <span style={{ color: 'var(--rl-text)', fontWeight: 600 }}>Day 2 · 14:20</span>
        <span style={{ fontSize: 12 }}>⏸ 1× 4× 16×</span>
        <span aria-hidden="true" style={{ width: 1, height: 20, background: 'var(--rl-line-strong)' }} />
        <SoundToggle compact />
      </div>
      <div style={glass}>
        <SoundToggle />
      </div>
      <section style={{ width: 'min(560px, 100%)', padding: '20px 24px', borderRadius: 12, background: 'var(--rl-surface)', color: 'var(--rl-text)', boxShadow: '0 12px 32px rgb(0 0 0 / .35)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 600 }}>Sound</h3>
        <SoundSettings />
      </section>
    </div>
  );
}

export function mountUiPreview(into: HTMLElement): void {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.dataset.theme = theme;
  // Next sets the Geist variables; here, the system font stands in.
  document.documentElement.style.setProperty('--font-geist-sans', 'Geist, ui-sans-serif, system-ui, sans-serif');
  createRoot(into).render(<Preview />);
}
