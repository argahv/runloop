# /// script
# requires-python = ">=3.10"
# dependencies = ["librosa>=0.10", "numpy", "scipy", "soundfile"]
# ///
"""A World That Keeps Running: the bespoke score for Runloop's 75 s film (and its 30 s teaser and 10 s loop).

    MOTION_REEL_SKILL=<skill> uv run keeps-running/audio/score.py        (from film/)

96 BPM, 4/4, 30 bars = 75.0 s exactly (a bar is 2.5 s = 75 frames at 30 fps; a beat 0.625 s = 18.75 frames).
The teaser is 12 bars (30.0 s) and the loop 4 bars (10.0 s) of the same grid, so all three cut on bar lines.
Key of D (Dmaj9, Bm11, Gmaj9(#11), Em9, Asus4/A), restrained, no voice-over. The six acts:

  A1 bars  0-3   0.0- 7.5  The world wakes up       near silence: a sub drone, air, lamp bells, the theme alone
  A2 bars  3-8   7.5-20.0  Life inside the town     a pulse starts (half-time kick, the clock's tick), walking arpeggio;
                                                     bars 6-7 the day time-lapse: ticks double, the filter opens
  A3 bars  8-12 20.0-30.0  A real agent arrives     drums out, dusk pad; swell and riser into bar 10 = the HQ goes live
                                                     (sub drop + the lime bell motif), push-through on bar 11
  A4 bars 12-17 30.0-42.5  Every session leaves...  the rhythmic lift; the recorded events of the session play as notes
                                                     at their recorded spacing (failure on bar 14's downbeat: cluster +
                                                     filter dip; the passing rerun resolves)
  A5 bars 17-22 42.5-55.0  Rewind, inspect, compare tape stop, then suspension: the same event notes reversed and in
                                                     reverse order (replay scrubbing back) while the world's clock tick
                                                     keeps going forward; two timelines as two voices (L/R)
  A6 bars 22-30 55.0-75.0  The world is bigger...   broad resolve on Dadd9; bars 26-29 loop (D pedal: D, Bm/D, G/D, D)

Writes audio/music.wav (hero), audio/music_teaser.wav, audio/music_loop.wav, audio/stems/*.wav, and
<film>/beats.json (grid measured from the rendered percussion + the grid guide, acts, cues, bar energy,
per-section loudness). Event times come from data/session-events.json, so the score follows the recorded
session; re-run after the live capture replaces that file.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal


def _skill_dir():
    if os.environ.get("MOTION_REEL_SKILL"):
        return Path(os.environ["MOTION_REEL_SKILL"])
    found = sorted((Path.home() / ".claude/plugins").glob("**/skills/motion-reel/scripts/dsp.py"))
    if found:
        return found[-1].parent.parent
    sys.exit("can't find the motion-reel skill: set MOTION_REEL_SKILL to the folder that holds its SKILL.md")


SKILL = _skill_dir()
sys.path.insert(0, str(SKILL / "scripts"))
from dsp import *  # noqa: E402,F403
import dsp  # noqa: E402

HERE = Path(__file__).resolve().parent
FILM = HERE.parent
BPM = 96
BEAT = 60 / BPM            # 0.625 s
BAR = 4 * BEAT             # 2.5 s
BARS = 30
DUR = BARS * BAR           # 75.0 s
N = int(SR * DUR)
FPS = 30
seed(20261018)


def T(b):
    return b * BEAT


def q16(t):
    """Snap a time (s) to the nearest 16th note: the score plays recorded events on the grid (<= 78 ms shift)."""
    s = BEAT / 4
    return round(t / s) * s


ACTS = [  # name, first bar, last bar (exclusive)
    ("A1 The world wakes up", 0, 3),
    ("A2 Life inside the town", 3, 8),
    ("A3 A real agent arrives", 8, 12),
    ("A4 Every session leaves a trail", 12, 17),
    ("A5 Rewind, inspect, compare", 17, 22),
    ("A6 The world is bigger than the session", 22, 30),
]

# ---------------------------------------------------------------- the recorded session (B layer)
SES = json.loads((FILM / "data" / "session-events.json").read_text())
PRI, SEC = SES["primary"], SES["secondary"]


def first(events, pred):
    return next(e for e in events if pred(e))


FAIL = first(PRI["events"], lambda e: e["type"] == "tool.call_completed" and e.get("exitCode") == 1)
# A4: the session plays at its recorded speed, placed so the failing test lands on bar 14's downbeat.
A4_OFFSET = T(14 * 4) - FAIL["tMs"] / 1000
GO_LIVE = T(10 * 4)                      # A3: the first recorded event (the prompt) turns the HQ live
REWIND = (T(17 * 4) + 0.3, T(18 * 4 + 2))  # A5: scrub from the end of the session back to its start
TIMELINES = (T(19 * 4), T(20 * 4))        # A5: both sessions on one time axis, side by side


def a4_time(tms):
    return tms / 1000 + A4_OFFSET


def rewind_time(tms):
    a, b = REWIND
    return a + (PRI["durationMs"] - tms) / PRI["durationMs"] * (b - a)


def timeline_time(tms):
    a, b = TIMELINES
    span = max(PRI["durationMs"], SEC["durationMs"])
    return a + tms / span * (b - a) * 0.92


# ---------------------------------------------------------------- instruments (dsp.py has the rest)

def fm_bell(note, length=2.4, index=2.2, ratio=3.5, bright=1.0):
    """Glassy FM bell: the lamps of A1 and the lime motif of the agent."""
    n = int(length * SR)
    t = tvec(n)
    f = hz(note)
    mod = index * bright * np.exp(-t / 0.35) * np.sin(2 * np.pi * f * ratio * t)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / (length * 0.33))
    x += 0.25 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / 0.4)
    return x * (1 - np.exp(-t / 0.002))


def soft_pluck(note, length=0.5, cutoff=2400):
    return pluck([note], length, cutoff) * 0.9


def drone(note, length, air=0.0):
    """Sub drone: two sines a fifth apart with a slow breath, plus filtered air."""
    n = int(length * SR)
    t = tvec(n)
    f = hz(note)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 1.5 * t) + 0.12 * np.sin(2 * np.pi * f * 2 * t)
    x *= 0.85 + 0.15 * np.sin(2 * np.pi * 0.11 * t)
    if air:
        nz = dsp.rng.standard_normal(n)
        nz = filt(filt(nz, "highpass", 1800), "lowpass", 6500)
        nz *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.07 * t + 1.0)
        x = x + air * nz
    fade = np.minimum(1, np.minimum(t / 1.5, (length - t) / 1.5))
    return x * np.clip(fade, 0, 1)


def tick(bright=1.0):
    """The world clock: a dry high tick (escapement), not a hi-hat."""
    n = int(0.05 * SR)
    t = tvec(n)
    x = filt(dsp.rng.standard_normal(n), "bandpass", [3500, 9000]) * np.exp(-t / 0.004)
    x += 0.4 * np.sin(2 * np.pi * 2900 * bright * t) * np.exp(-t / 0.008)
    return x


def click():
    """Grid guide (never mixed): measure_beats reads the grid from it where the score has no drums."""
    n = int(0.03 * SR)
    t = tvec(n)
    return np.sin(2 * np.pi * 1000 * t) * np.exp(-t / 0.004) + filt(dsp.rng.standard_normal(n), "highpass", 2000) * np.exp(-t / 0.002)


def rim():
    n = int(0.12 * SR)
    t = tvec(n)
    x = filt(dsp.rng.standard_normal(n), "bandpass", [1500, 5000]) * np.exp(-t / 0.012)
    x += 0.6 * np.sin(2 * np.pi * 820 * t) * np.exp(-t / 0.02)
    return x


def cluster(length=1.6):
    """The failure: a minor-second cluster under a dull thud (a focused disturbance, not an explosion)."""
    out = np.zeros(int(length * SR))
    for nt, g in (("C#5", 0.5), ("D5", 0.5), ("G#4", 0.35)):
        b = fm_bell(nt, length, index=3.0, ratio=1.41, bright=1.2) * g
        out[: len(b)] += b
    thud = kick(soft=True)[: len(out)]
    out[: len(thud)] += thud * 0.9
    return out


def stretch_stop(x, a, b, sr=SR):
    """Tape stop on x[:, a:b]: the playback rate falls from 1 to 0 across the span."""
    n = b - a
    rate = (1 - np.linspace(0, 1, n)) ** 1.6
    pos = a + np.cumsum(rate)
    idx = np.arange(x.shape[1])
    y = np.stack([np.interp(pos, idx, x[c]) for c in range(x.shape[0])])
    y *= np.linspace(1, 0, n) ** 0.5
    x[:, a:b] = y


def lowpass_dip(x, a, b, f0=260, f1=9000):
    """A dip: the bed's lowpass opens back up from f0 to f1 over [a, b) (stereo, in place)."""
    n = b - a
    fc = f0 * (f1 / f0) ** (np.linspace(0, 1, n) ** 1.5)
    for c in range(x.shape[0]):
        x[c, a:b] = sweep_filter(x[c, a:b], fc, "lowpass", 0.9)


# ---------------------------------------------------------------- harmony

CH = {
    "D": ["D3", "A3", "C#4", "E4", "F#4"],          # Dmaj9
    "Dadd9": ["D3", "A3", "E4", "F#4", "A4"],
    "Bm": ["B2", "F#3", "A3", "D4", "E4"],          # Bm11
    "G": ["G2", "D3", "F#3", "A3", "C#4"],          # Gmaj9(#11) colour
    "Em": ["E3", "B3", "D4", "F#4", "G4"],          # Em9
    "Asus": ["A2", "E3", "A3", "D4", "E4"],
    "A": ["A2", "E3", "A3", "C#4", "E4"],
    "D/F#": ["F#2", "D3", "A3", "E4"],
    "Bm/D": ["D3", "F#3", "A3", "B3", "E4"],
    "G/D": ["D3", "G3", "B3", "D4", "F#4"],
}
ROOT = {"D": "D2", "Dadd9": "D2", "Bm": "B1", "G": "G1", "Em": "E2", "Asus": "A1", "A": "A1", "D/F#": "F#1",
        "Bm/D": "D2", "G/D": "D2"}
# chord per bar (None = drone only)
PROG = [None, None, "D",                      # A1
        "D", "Bm", "G", "Em", "Asus",          # A2
        "G", "Em", "Dadd9", "A",               # A3
        "Bm", "G", "Em", "D/F#", "Asus",       # A4
        "G", "Em", "Bm", "G", "Asus",          # A5
        "Dadd9", "Bm", "G", "Asus",            # A6
        "D", "Bm/D", "G/D", "Dadd9"]           # A6 loop bars 26-29 (D pedal)
assert len(PROG) == BARS
ARP = {k: v for k, v in CH.items()}


def a6_bars(drums, drone_b, keysb, plucks, fx, bars, shift):
    """The steady texture of A6 (bars 22-29); bars 26-29 are the loop. `shift` moves it in beats."""
    for bar in bars:
        ch = PROG[bar]
        b0 = bar * 4 + shift
        drone_b.add(bass_note(ROOT[ch], BAR * 0.98, 380), b0, 0.24)
        drone_b.add(drone(ROOT[ch][:-1] + "1", BAR + 1.0), b0, 0.10)
        for beat in (0, 2):
            drums.add(kick(soft=True), b0 + beat, 0.34)
        for k, b in enumerate(np.arange(b0, b0 + 4, 0.5)):
            fx.add(tick(), b, 0.03, pan=0.3 * (1 if k % 2 else -1))
        notes = ARP[ch]
        for k in range(8):
            nt = notes[[0, 2, 1, 3, 2, 4, 3, 1][k] % len(notes)]
            nt = nt[:-1] + str(int(nt[-1]) + 1)
            plucks.add(soft_pluck(nt, 0.7, 2200), b0 + k * 0.5, 0.09, pan=0.25 * np.sin(k))
    theme = {27: ((0.0, "F#4"), (1.5, "E4"), (2.0, "D4"), (3.0, "A3")),
             28: ((0.0, "F#4"), (1.5, "A4"), (2.0, "D5")),
             29: ((0.0, "F#4"), (1.5, "E4"), (2.0, "D4"))}
    for bar in bars:
        for off, nt in theme.get(bar, ()):
            keysb.add(keys([nt], 1.8), bar * 4 + shift + off, 0.12)


def a6_pads(pads, bars, shift):
    for bar in bars:
        ch = PROG[bar]
        g = 0.15 if bar < 26 else 0.12
        pads.add(pad_chord(CH[ch], BAR + 0.9, (1200, 3600), attack=0.5, release=0.8), bar * 4 + shift, g)


def mixdown(drums, drone_b, pads, keysb, plucks, fx, events, rev, pump_beats):
    music = pads.x + keysb.x * 0.9 + plucks.x * 0.8 + fx.x * 0.85 + events.x + rev.x * 0.9
    ir = reverb_ir(2.6, 0.9, seed_=11)
    wet = np.stack([signal.fftconvolve(music[c], ir[c])[: music.shape[1]] for c in range(2)])
    pump = sidechain([T(b) for b in pump_beats], drone_b.x.shape[1], 0.25, 0.12)
    bed = drums.x * 0.9 + drone_b.x * pump * 0.9 + music * pump + wet * 0.38
    return np.stack([filt(ch, "highpass", 26) for ch in bed])


def main():
    drone_b, pads, keysb, plucks, drums, fx, events, rev, guide = (Bus(DUR, BPM) for _ in range(9))

    # ---- A1 (bars 0-3): near silence, a sub drone and air; lamp bells as the lamps reveal; the theme alone
    drone_b.add(drone("D1", T(12) + 1.5, air=0.02), 0, 0.09)
    drone_b.add(drone("A1", T(8) + 1.5, air=0.0), 4, 0.05)
    for b, nt, g in ((1.5, "A5", 0.10), (3.0, "F#5", 0.08), (4.0, "D6", 0.07), (5.0, "E5", 0.08),
                     (5.5, "A5", 0.06), (6.25, "F#5", 0.06), (7.0, "D6", 0.06)):
        fx.add(fm_bell(nt, 2.6, index=1.4), b, g * 0.6, pan=((b * 37) % 7 - 3) / 6)
    pads.add(pad_chord(["A4", "E5"], T(4) + 1.0, (900, 2400), attack=1.2, release=1.0), 4, 0.025)
    # the theme (the world's motif): F#4 E4 D4 A3, answered later by the agent's lime bell
    for b, nt in ((8.0, "F#4"), (9.5, "E4"), (10.0, "D4"), (11.0, "A3")):
        keysb.add(keys([nt], 1.6), b, 0.10, pan=-0.1)
    drums.add(kick(soft=True), 10, 0.12)                      # a first heartbeat: residents begin

    # ---- pads, every bar with a chord (A1 bar 2 onwards)
    for bar, ch in enumerate(PROG):
        if ch is None:
            continue
        act5 = 17 <= bar < 22
        dark = bar in (2, 8, 9) or act5
        cut = (500, 1100) if dark else (900, 2600) if bar < 22 else (1200, 3600)
        if bar >= 22:
            continue
        g = 0.035 if bar < 3 else 0.11 if bar < 12 else 0.10 if act5 else 0.13
        p = pad_chord(CH[ch], BAR + 0.9, cut, attack=0.5 if not act5 else 1.0, release=0.8)
        if act5 and bar in (17, 18):
            # suspension: the pad plays backwards (a swell into each downbeat)
            p = p[:, ::-1].copy()
            rev.add(p, bar * 4 - 0.4, g * 1.2)
        else:
            pads.add(p, bar * 4, g)
    a6_pads(pads, range(22, 30), 0)

    # ---- A2 (bars 3-8): the pulse; the clock's tick; a walking arpeggio; the day time-lapse in bars 6-7
    for bar in range(3, 8):
        ch = PROG[bar]
        for beat in (0, 2):
            drums.add(kick(soft=True), bar * 4 + beat, 0.42 if bar > 3 else 0.30)
        step = 0.5 if bar < 6 else 0.25 if bar == 6 else 0.125
        for k, b in enumerate(np.arange(bar * 4, bar * 4 + 4, step)):
            fx.add(tick(1.0 + 0.1 * (k % 2)), b, 0.05 if bar < 6 else 0.04 + 0.02 * ((b - 24) / 8), pan=0.35 * (1 if k % 2 else -1))
        notes = ARP[ch]
        for k in range(8):
            nt = notes[[0, 2, 1, 3, 2, 4, 3, 1][k] % len(notes)]
            nt = nt[:-1] + str(int(nt[-1]) + 1)
            plucks.add(soft_pluck(nt, 0.6, 1600 + 300 * (bar - 3) + (1800 if bar >= 6 else 0)), bar * 4 + k * 0.5, 0.10 if bar < 6 else 0.12, pan=0.25 * np.sin(k))
        drone_b.add(bass_note(ROOT[ch], BAR * 0.95, 400), bar * 4, 0.20)
    fx.add(riser(T(8)), 24, 0.10)                              # the day passes: bars 6-7
    keysb.add(keys(["F#4"], 1.4), 20.0, 0.12)                    # the theme returns under the resident card
    keysb.add(keys(["E4"], 1.4), 21.5, 0.10)
    keysb.add(keys(["D4"], 2.0), 22.0, 0.11)

    # ---- A3 (bars 8-12): dusk, drums out; swell into bar 10 (go live); push-through in bar 11
    drone_b.add(drone("G1", T(8) + 1.5, air=0.03), 32, 0.22)
    for b, nt in ((33.0, "F#4"), (34.5, "E4"), (35.0, "D4"), (36.0, "B3")):
        keysb.add(keys([nt], 1.8), b, 0.14)
    for k, b in enumerate(np.arange(32, 40, 0.5)):
        fx.add(tick(), b, 0.035, pan=0.3 * (1 if k % 2 else -1))       # the town's clock never stops
    for b in (36, 37, 38, 39):
        drums.add(kick(soft=True), b, 0.18 + 0.06 * (b - 36))           # the heart builds into the arrival
    fx.add(riser(T(4)), 36, 0.16)
    fx.add(whoosh(T(2), 300, 2600, peak=0.92), 38, 0.10)
    # GO LIVE: the first recorded event
    drums.add(sub_drop(1.4, 70, 32), 40, 0.55)
    drums.add(crash(2.2), 40, 0.06)
    for b, nt, g in ((40.0, "A5", 0.20), (40.0, "D6", 0.16), (40.5, "F#5", 0.10), (41.0, "E6", 0.07)):
        fx.add(fm_bell(nt, 3.2, index=1.8, ratio=2.0), b, g, pan=0.1)   # the lime motif (agent)
    drone_b.add(drone("D1", T(8) + 1.5, air=0.04), 40, 0.30)
    for bar in (10, 11):
        for beat in (0, 2):
            drums.add(kick(soft=True), bar * 4 + beat, 0.40)
        drone_b.add(bass_note(ROOT[PROG[bar]], BAR * 0.95, 500), bar * 4, 0.22)
    fx.add(whoosh(T(1.5), 500, 4200, peak=0.85), 42.5, 0.12)          # push through the glass (bar 11)

    # ---- A4 (bars 12-17): work becomes visible
    fail_t = a4_time(FAIL["tMs"])
    for bar in range(12, 17):
        ch = PROG[bar]
        for beat in range(4):
            b = bar * 4 + beat
            if beat in (0, 2):
                drums.add(kick(), b, 0.78 if bar != 14 or beat else 0.0)
            else:
                drums.add(rim(), b, 0.26, pan=0.12)
            for s16 in (0.25, 0.5, 0.75):
                drums.add(hat(), b + s16, 0.08 if s16 != 0.5 else 0.14, pan=0.3)
        for k in range(8):
            nt = ROOT[ch]
            note = nt[:-1] + str(int(nt[-1]) + (1 if k % 2 else 0))
            drone_b.add(bass_note(note, BEAT / 2 * 0.8, 900), bar * 4 + k * 0.5, 0.40 if k % 2 == 0 else 0.30)
        notes = ARP[ch]
        for k in range(16):
            nt = notes[[0, 2, 4, 3, 1, 3, 2, 4][k % 8] % len(notes)]
            nt = nt[:-1] + str(int(nt[-1]) + 1)
            plucks.add(soft_pluck(nt, 0.35, 2600), bar * 4 + k * 0.25, 0.07 if k % 4 else 0.10, pan=0.3 * np.sin(k * 0.7))
    # the recorded events as notes, by category (at their recorded spacing, snapped to 16ths)
    CAT_NOTE = {"test": "A4", "read": "F#5", "edit": "D5", "execute": "E5", "delegate": "B4", "search": "F#5", "web": "F#5"}
    a4_notes = []
    for e in PRI["events"]:
        t = q16(a4_time(e["tMs"]))
        if not (T(48) <= t < T(68)):
            continue
        if e["type"] == "tool.call_started":
            nt = CAT_NOTE.get(e.get("category"), "E5")
            events.add(fm_bell(nt, 1.2, index=1.2, ratio=2.0), 0, 0.10, at=t)
            a4_notes.append((t, nt, e["seq"]))
        elif e["type"] == "tool.permission_requested":
            events.add(fm_bell("E5", 1.6, index=0.8, ratio=1.0), 0, 0.07, at=t)
            a4_notes.append((t, "E5", e["seq"]))
        elif e["type"] == "tool.call_completed" and e.get("status") == "success":
            passed = (e.get("metrics") or {}).get("failed") == 0
            if passed:
                for nt, g in (("D6", 0.16), ("A5", 0.12), ("F#6", 0.06)):
                    events.add(fm_bell(nt, 2.6, index=1.6, ratio=2.0), 0, g, at=t)
            else:
                events.add(fm_bell("A6", 0.5, index=0.6), 0, 0.04, at=t)
        elif e["type"] == "tool.call_completed" and e.get("exitCode") == 1:
            events.add(cluster(1.8), 0, 0.30, at=t)
        elif e["type"] == "tool.call_completed" and e.get("status") == "error":
            events.add(fm_bell("C5", 0.8, index=2.4, ratio=1.41), 0, 0.06, at=t)   # the NOTES.md read error
    fx.add(whoosh(T(1), 4000, 600, peak=0.2), 66.0, 0.08)

    # ---- A5 (bars 17-22): rewind, inspect, compare
    for (t, nt, seq) in a4_notes:
        orig = next(e for e in PRI["events"] if e["seq"] == seq)
        rt = q16(rewind_time(orig["tMs"]))
        bell = fm_bell(nt, 1.0, index=1.0, ratio=2.0)[::-1].copy()        # the event, heard backwards
        rev.add(bell, 0, 0.09, at=max(0.0, rt - len(bell) / SR))
    for k, b in enumerate(np.arange(68.5, 88, 0.5)):                      # ...while the clock ticks forward
        fx.add(tick(0.9), b, 0.03, pan=0.3 * (1 if k % 2 else -1))
    drone_b.add(drone("G1", T(12) + 1.5, air=0.06), 68, 0.20)
    drone_b.add(drone("A1", T(8) + 1.5, air=0.04), 80, 0.18)
    for ses, pan in ((PRI, -0.6), (SEC, 0.6)):                           # two sessions, side by side
        for e in ses["events"]:
            if e["type"] != "tool.call_started":
                continue
            t = q16(timeline_time(e["tMs"]))
            nt = CAT_NOTE.get(e.get("category"), "E5")
            keysb.add(keys([nt], 0.9), 0, 0.09, pan=pan, at=t)
    for b, nt in ((80.0, "F#4"), (81.5, "E4"), (82.0, "D4"), (84.0, "A3")):   # the theme under the replay
        keysb.add(keys([nt], 1.8), b, 0.12)
    fx.add(riser(T(4)), 84, 0.12)

    # ---- A6 (bars 22-30): broad resolve; bars 26-29 loop
    drums.add(sub_drop(1.6, 64, 30), 88, 0.45)
    drums.add(crash(3.0), 88, 0.07)
    for b, nt in ((88.0, "F#4"), (89.5, "E4"), (90.0, "D4"), (91.0, "A3"),
                  (96.0, "F#4"), (97.5, "A4"), (98.0, "D5")):
        keysb.add(keys([nt], 2.0), b, 0.15)
    for b, nt, g in ((104.0, "A5", 0.14), (104.0, "D6", 0.11), (104.5, "F#5", 0.08)):   # the logo forms (bar 26)
        fx.add(fm_bell(nt, 3.0, index=1.6, ratio=2.0), b, g)
    a6_bars(drums, drone_b, keysb, plucks, fx, range(22, 30), 0)

    # ---- guide clicks (measurement only; never mixed)
    for b in range(BARS * 4):
        guide.add(click(), b, 1.0)

    # ---- mix
    pump_beats = list(range(48, 68, 2)) + list(range(88, 120, 2))
    bed = mixdown(drums, drone_b, pads, keysb, plucks, fx, events, rev, pump_beats)
    bed = bed[:, :N].copy()
    # failure: the bed's filter dips for a beat at the recorded failure
    a = int(fail_t * SR)
    lowpass_dip(bed, a, a + int(BEAT * 1.2 * SR))
    # tape stop into A5 (the playback slows to a halt on bar 17's downbeat)
    stop_a, stop_b = int((T(68) - 0.55) * SR), int(T(68) * SR)
    stretch_stop(bed, stop_a, stop_b)
    peak = np.abs(bed).max() + 1e-9
    gain = 10 ** (-3 / 20) / peak
    bed *= gain
    hero = bed.copy()
    fo = int(0.25 * SR)
    hero[:, -fo:] *= np.linspace(1, 0, fo) ** 2
    sf.write(HERE / "music.wav", hero.T, SR, subtype="PCM_24")

    # ---- loop: bars 26-29 rendered on their own, the tails past the end wrapped onto the start (seamless)
    seed(20261018)
    L = [Bus(DUR, BPM) for _ in range(8)]
    a6_pads(L[2], range(26, 30), -104)
    a6_bars(L[0], L[1], L[3], L[4], L[5], range(26, 30), -104)
    lbed = mixdown(*L, list(range(0, 16, 2))) * gain
    ln = int(4 * BAR * SR)
    loop = lbed[:, :ln].copy()
    spill = lbed[:, ln:2 * ln]
    loop[:, : spill.shape[1]] += spill
    sf.write(HERE / "music_loop.wav", loop.T, SR, subtype="PCM_24")

    # ---- teaser: 12 hero bars, cut on bar lines with 12 ms crossfades
    TEASER = [0, 2, 6, 10, 11, 14, 16, 17, 20, 21, 26, 27]   # docs/shotlist.md, "30 s teaser"
    seg = int(BAR * SR)
    xf = int(0.012 * SR)
    teaser = np.zeros((2, seg * len(TEASER) + xf))
    for i, bar in enumerate(TEASER):
        s = bed[:, bar * seg: bar * seg + seg + xf].copy()
        ramp = np.ones(s.shape[1])
        ramp[:xf] = np.linspace(0, 1, xf)
        ramp[-xf:] = np.linspace(1, 0, xf)
        teaser[:, i * seg: i * seg + s.shape[1]] += s * ramp
    teaser = teaser[:, : seg * len(TEASER)]
    teaser[:, -fo:] *= np.linspace(1, 0, fo) ** 2
    sf.write(HERE / "music_teaser.wav", teaser.T, SR, subtype="PCM_24")

    stems = HERE / "stems"
    stems.mkdir(exist_ok=True)
    for name, bus in (("drums", drums), ("drone_bass", drone_b), ("pads", pads), ("keys", keysb), ("plucks", plucks), ("fx", fx), ("events", events), ("reverse", rev)):
        sf.write(stems / f"{name}.wav", (bus.x[:, :N] * gain).T, SR, subtype="PCM_24")

    # ---- the grid, measured on the rendered percussion + the guide
    grid_src = (guide.x * 0.6 + drums.x)[:, :N].mean(axis=0)
    grid = measure_beats(grid_src.astype(np.float32), SR, BPM, n_beats=BARS * 4 + 1)
    grid["beats"] = [b for b in grid["beats"] if b < DUR + 0.01]
    grid["downbeats"] = grid["beats"][::4]
    mono = bed.mean(axis=0)
    grid["bar_energy"] = [round(float(np.sqrt(np.mean(mono[int(i * BAR * SR):int((i + 1) * BAR * SR)] ** 2) + 1e-12)), 4) for i in range(BARS)]
    loud = section_loudness(hero)
    cues = {
        "go_live": {"t": GO_LIVE, "beat": 40, "what": "the first recorded event (the prompt): the HQ turns live"},
        "a4_offset_s": round(A4_OFFSET, 4),
        "a4_rule": "film t = event tMs/1000 + a4_offset_s (recorded spacing); score notes snapped to 16ths",
        "failure": {"t": round(fail_t, 4), "beat": round(fail_t / BEAT, 3), "seq": FAIL["seq"], "what": FAIL.get("outputSummary")},
        "a4_notes": [{"t": round(t, 4), "beat": round(t / BEAT, 3), "note": nt, "seq": s} for t, nt, s in a4_notes],
        "rewind": {"from": round(REWIND[0], 4), "to": round(REWIND[1], 4), "rule": "film t = from + (durationMs - tMs)/durationMs * (to - from)"},
        "timelines": {"from": TIMELINES[0], "to": TIMELINES[1], "rule": "film t = from + tMs / max(duration) * (to - from) * 0.92, both sessions on one axis"},
        "tape_stop": {"t": T(68)},
        "logo": {"t": T(104), "beat": 104},
        "loop": {"bars": [26, 30], "from": T(104), "to": DUR, "file": "audio/music_loop.wav"},
        "teaser": {"bars": TEASER, "file": "audio/music_teaser.wav", "duration": BAR * len(TEASER)},
    }
    grid.update({
        "designed_bpm": BPM,
        "fps": FPS,
        "beat_frames": BEAT * FPS,
        "bar_frames": BAR * FPS,
        "duration": DUR,
        "sections": [{"name": n, "beat": a * 4, "bar": a, "t": a * BAR, "frame": int(round(a * BAR * FPS)), "end_t": b * BAR, "end_frame": int(round(b * BAR * FPS))} for n, a, b in ACTS],
        "chords": PROG,
        "cues": cues,
        "loudness": loud,
        "source": "keeps-running/audio/score.py (96 BPM, D); grid measured on the rendered drum stem + the beat guide (not mixed)",
    })
    (FILM / "beats.json").write_text(json.dumps(grid, indent=1))
    print(f"grid: {grid['bpm']} bpm, offset {grid['offset'] * 1000:.2f} ms, {len(grid['beats'])} beats, fit {grid['fit_inliers']} inliers, rms {grid['fit_residual_ms']} ms")
    print(f"A4 offset {A4_OFFSET:.3f} s: failure (seq {FAIL['seq']}) at {fail_t:.3f} s = beat {fail_t / BEAT:.2f}")
    for k, v in loud.items():
        print(f"  {k:44s} {v}")


def lufs(path):
    try:
        return dsp.ebur128(path)
    except Exception:  # silence or too short
        return (float("-inf"), float("-inf"))


def section_loudness(x):
    """Integrated loudness (ebur128 via ffmpeg, the skill's dsp.ebur128) per act and for the whole bed."""
    out = {}
    with tempfile.TemporaryDirectory(prefix="film-score-") as d:
        def measure(name, a, b):
            p = Path(d) / f"{len(out)}.wav"
            sf.write(p, x[:, int(a * SR):int(b * SR)].T, SR, subtype="PCM_24")
            i, pk = lufs(p)
            out[name] = {"from": a, "to": b, "lufs": i, "peak_dbfs": pk}
        measure("whole (before mastering)", 0, DUR)
        for name, a, b in ACTS:
            measure(name, a * BAR, b * BAR)
        measure("A1 first bar (0-2.5 s)", 0, BAR)
        measure("A3 swell bar 9", 9 * BAR, 10 * BAR)
        measure("A3 go-live bar 10", 10 * BAR, 11 * BAR)
        measure("A6 loop bars 26-29", 26 * BAR, 30 * BAR)
    return out


if __name__ == "__main__":
    main()
