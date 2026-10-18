/**
 * The sound board (`node apps/studio/src/audio/check/render-check.mjs --serve`,
 * port 3074): every sound live through the real engine, an ambient bed driven
 * by a made-up listener, the debug hook, and the offline render check
 * (`?check=1` runs it on load and publishes `window.__renderCheck`).
 */
import { getAudioEngine } from '../engine';
import { SCENES, renderLayers, runRenderCheck, type CheckRow, type Measure } from '../render';
import { EVENT_CUES, UI_SOUNDS, type AudioListener, type AudioSettings } from '../types';

declare global {
  interface Window {
    __renderCheck?: { ok: boolean; rows: CheckRow[] } | { error: string };
    __renderLayers?: Measure[];
  }
}

const engine = getAudioEngine()!;
const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
const button = (text: string, onClick: () => void) => el('button', { type: 'button', onclick: onClick }, text);
const section = (title: string, ...children: Node[]) => el('section', {}, el('h2', {}, title), el('div', { className: 'panel' }, ...children));

function slider(label: string, value: number, onInput: (v: number) => void): HTMLLabelElement {
  const out = el('output', {}, `${Math.round(value * 100)}%`);
  const input = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(value * 100)) });
  input.oninput = () => {
    out.textContent = `${input.value}%`;
    onInput(Number(input.value) / 100);
  };
  return el('label', {}, label, input, out);
}

// ── Volumes ──
const s = engine.getSettings();
const vol = (k: keyof Pick<AudioSettings, 'master' | 'ambient' | 'ui' | 'events'>, label: string) => slider(label, s[k], (v) => engine.update({ [k]: v }));
const flag = (k: 'enabled' | 'reduce', label: string) => {
  const box = el('input', { type: 'checkbox', checked: s[k] });
  box.onchange = () => {
    engine.update({ [k]: box.checked });
    engine.unlock();
  };
  return el('label', {}, label, box, '');
};

// ── Ambient bed: a made-up listener, as the town would report it (~4 Hz) ──
let scene = Object.keys(SCENES)[1]!;
const bedState = { on: false, zoom01: 1, night: 0, paused: false };
const sceneSelect = el('select', {}, ...Object.keys(SCENES).map((name) => el('option', { value: name, selected: name === scene }, name)));
sceneSelect.onchange = () => {
  scene = sceneSelect.value;
  const l = SCENES[scene]!;
  bedState.zoom01 = l.zoom01;
  bedState.night = l.night;
};
const bedButton = button('Start the bed', () => {
  bedState.on = !bedState.on;
  bedButton.textContent = bedState.on ? 'Stop the bed' : 'Start the bed';
  engine.unlock();
});
setInterval(() => {
  if (!bedState.on) return;
  const l: AudioListener = { ...SCENES[scene]!, zoom01: bedState.zoom01, night: bedState.night, paused: bedState.paused };
  engine.setListener(l);
}, 250);
const pausedBox = el('input', { type: 'checkbox' });
pausedBox.onchange = () => (bedState.paused = pausedBox.checked);

// ── Check results ──
const results = el('div');
function showResults(r: { ok: boolean; rows: CheckRow[] }) {
  const f = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '−∞' : v.toFixed(1));
  results.replaceChildren(
    el('p', { className: r.ok ? 'ok' : 'bad' }, r.ok ? `All ${r.rows.length} checks pass.` : `${r.rows.filter((x) => !x.ok).length} of ${r.rows.length} checks fail.`),
    el(
      'table',
      {},
      el('tr', {}, el('th', {}, ''), el('th', {}, 'Sound'), el('th', {}, 'Peak dBFS'), el('th', {}, 'RMS dBFS'), el('th', {}, 'Expect')),
      ...r.rows.map((row) =>
        el(
          'tr',
          {},
          el('td', { className: row.ok ? 'ok' : 'bad' }, row.ok ? '✓ pass' : '✗ fail'),
          el('td', {}, `${row.group} · ${row.name}`),
          el('td', {}, f(row.measure?.peakDb)),
          el('td', {}, f(row.measure?.rmsDb)),
          el('td', {}, row.expect),
        ),
      ),
    ),
  );
}
async function check() {
  results.replaceChildren(el('p', {}, 'Rendering offline…'));
  try {
    const r = await runRenderCheck();
    window.__renderCheck = r;
    showResults(r);
  } catch (e) {
    window.__renderCheck = { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
    results.replaceChildren(el('p', { className: 'bad' }, `Render check failed to run: ${String(e)}`));
  }
}

const debug = el('pre');
setInterval(() => {
  debug.textContent = JSON.stringify((window as unknown as { __runloopAudio: unknown }).__runloopAudio, null, 1);
}, 500);

app.append(
  section('Volumes', flag('enabled', 'Sound on'), vol('master', 'Master'), vol('ambient', 'Ambient'), vol('ui', 'Interface'), vol('events', 'Agent events'), flag('reduce', 'Reduce sound')),
  section(
    'Ambient bed',
    el('div', { className: 'row' }, bedButton, sceneSelect),
    slider('Zoom (town → street)', bedState.zoom01, (v) => (bedState.zoom01 = v)),
    slider('Night', bedState.night, (v) => (bedState.night = v)),
    el('label', {}, 'World paused', pausedBox, ''),
  ),
  section(
    'Interface sounds',
    el('div', { className: 'row' }, ...UI_SOUNDS.map((u) => button(u, () => engine.ui(u))), button('whoosh (fly, pan →)', () => engine.whoosh(700, 0.6))),
  ),
  section('Event cue previews (real agent events only, in the town)', el('div', { className: 'row' }, ...EVENT_CUES.map((c) => button(c, () => engine.previewCue(c))))),
  section('Offline render check', el('div', { className: 'row' }, button('Run the render check', () => void check())), results),
  section('window.__runloopAudio', debug),
);

const q = new URLSearchParams(location.search);
if (q.has('check')) void check();
if (q.has('ui')) {
  const host = el('div', { id: 'ui-preview' });
  app.before(host);
  void import('./ui').then((m) => m.mountUiPreview(host));
}
if (q.has('layers')) {
  void (async () => {
    const all: Measure[] = [];
    for (const name of Object.keys(SCENES)) all.push(...(await renderLayers(name)));
    window.__renderLayers = all;
  })();
}
