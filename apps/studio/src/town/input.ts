'use client';
/**
 * DOM input for the town (contract §2.2): pointer, touch, wheel and keys go to
 * the camera controller; a press that never became a drag is a click (select),
 * a double click or double tap enters a building (or flies to open ground),
 * even when its second press lands on the card the first one opened,
 * and a 500 ms press without moving is a long press (select and expand).
 */
import type { EntityRef } from '@runloop-world/events';
import { useEffect, useRef } from 'react';
import type { CameraController } from './cameraController';
import { wheelPixels } from './cameraMath';

export interface TownInputHandlers {
  /** What is under a canvas pixel (residents, robots, buildings, lots while picking). */
  pick: (x: number, y: number) => EntityRef | null;
  click: (x: number, y: number) => void;
  doubleClick: (x: number, y: number) => void;
  longPress: (ref: EntityRef) => void;
}

const OWN_KEYS = '[role=dialog],[role=tree],[role=radiogroup],[role=tablist],[role=listbox],[data-keys=own]';

/** Two presses this close in time and space make a double click (or double tap). */
export const DOUBLE_MS = 320;
export const DOUBLE_PX = 24;

/**
 * Is this press the second half of a double click on the town? `last` is the
 * previous click on the canvas (client px). The second press counts wherever
 * it lands: the card that the first click opened may be under the pointer.
 */
export function isDoublePress(last: { cx: number; cy: number; t: number } | null, cx: number, cy: number, t: number): boolean {
  return last !== null && t - last.t >= 0 && t - last.t < DOUBLE_MS && Math.hypot(cx - last.cx, cy - last.cy) < DOUBLE_PX;
}

/** Keys belong to the camera only outside text fields and widgets that own their arrows. */
export function keyIsForCamera(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target;
  if (t instanceof Element) {
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t as HTMLElement).isContentEditable) return false;
    if (t.closest(OWN_KEYS)) return false;
  }
  return true;
}

export function useTownInput(wrap: React.RefObject<HTMLDivElement | null>, ctl: CameraController, handlers: { current: TownInputHandlers }, enabled: { keyboard: boolean }): void {
  const kb = useRef(enabled.keyboard);
  kb.current = enabled.keyboard;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let press: { id: number; x: number; y: number; t: number; button: number; onCanvas: boolean } | null = null;
    let longTimer = 0;
    /** When the last double click was handled (the browser's own dblclick after it is a duplicate). */
    let lastDouble = Number.NEGATIVE_INFINITY;
    /** The last click on the canvas (canvas px and client px): the first half of a double click, wherever the second lands. */
    let lastClick: { x: number; y: number; cx: number; cy: number; t: number } | null = null;
    let swallowClickUntil = 0;
    let captured: number | null = null;

    const onDown = (e: PointerEvent) => {
      // Labels are buttons: they take their own clicks, but a drag that starts on one still moves the camera.
      const { x, y } = local(e);
      const touch = e.pointerType === 'touch';
      if (e.button === 1) e.preventDefault();
      ctl.pointerDown(e.pointerId, x, y, e.button, touch, performance.now());
      if (press && touch) {
        // A second finger: no click, no long press.
        window.clearTimeout(longTimer);
        press = null;
        return;
      }
      press = { id: e.pointerId, x, y, t: performance.now(), button: e.button, onCanvas: e.target instanceof HTMLCanvasElement };
      window.clearTimeout(longTimer);
      if (e.button === 0 && press.onCanvas) {
        const p = press;
        longTimer = window.setTimeout(() => {
          if (press !== p || ctl.consumed) return;
          const ref = handlers.current.pick(p.x, p.y);
          if (ref) {
            ctl.consumed = true;
            handlers.current.longPress(ref);
          }
        }, 500);
      }
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = local(e);
      ctl.pointerMove(e.pointerId, x, y, performance.now());
      if (press && Math.hypot(x - press.x, y - press.y) > 6) window.clearTimeout(longTimer);
      if (ctl.consumed && captured === null && e.buttons) {
        try {
          el.setPointerCapture(e.pointerId);
          captured = e.pointerId;
        } catch {
          /* the pointer is already gone */
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const now = performance.now();
      const { x, y } = local(e);
      const wasConsumed = ctl.consumed;
      ctl.pointerUp(e.pointerId, now);
      window.clearTimeout(longTimer);
      if (captured === e.pointerId) {
        captured = null;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }
      const p = press;
      if (p?.id === e.pointerId) press = null;
      if (!p || p.id !== e.pointerId || wasConsumed || !p.onCanvas || p.button !== 0) return;
      if (Math.hypot(x - p.x, y - p.y) > 5 || now - p.t > 600) return;
      handlers.current.click(x, y);
      // A second click or tap close by is a double click, by our own timing (the same for mouse, pen and touch;
      // the browser's dblclick, which follows the OS setting, is then ignored).
      if (isDoublePress(lastClick, e.clientX, e.clientY, now)) {
        lastClick = null;
        lastDouble = now;
        handlers.current.doubleClick(x, y);
      } else lastClick = { x, y, cx: e.clientX, cy: e.clientY, t: now };
    };
    // The first click opens a card next to what it hit; a second press on that card (or any HUD
    // control under the pointer) is still the double click on the town, and does not press the card.
    // (A second press on the canvas itself is handled in onUp.)
    const onWindowDown = (e: PointerEvent) => {
      if (e.button !== 0 || !lastClick) return;
      if (e.target instanceof HTMLCanvasElement && el.contains(e.target)) return; // the canvas has dblclick and double tap
      const now = performance.now();
      if (!isDoublePress(lastClick, e.clientX, e.clientY, now)) return;
      const first = lastClick;
      lastClick = null;
      lastDouble = now;
      e.preventDefault();
      e.stopPropagation();
      swallowClickUntil = now + 700;
      handlers.current.doubleClick(first.x, first.y);
    };
    // Two fingers that land on the HUD (the hotbar, the top bar, a card) still pinch, twist and tilt the town:
    // the HUD takes no browser gestures (touch-action), so without this a pinch there would do nothing.
    const hudTouches = new Map<number, { x: number; y: number }>();
    let forwarding = false;
    const onHud = (t: EventTarget | null) =>
      t instanceof Element && !el.contains(t) && t.closest('[data-town-gestures]') !== null && t.closest('[role=region],[role=dialog]') === null;
    const onHudDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !onHud(e.target)) return;
      hudTouches.set(e.pointerId, local(e));
      if (forwarding || hudTouches.size !== 2) return;
      forwarding = true;
      const now = performance.now();
      for (const [id, p] of hudTouches) ctl.pointerDown(id, p.x, p.y, 0, true, now);
    };
    const onHudMove = (e: PointerEvent) => {
      if (!hudTouches.has(e.pointerId)) return;
      const p = local(e);
      hudTouches.set(e.pointerId, p);
      if (forwarding) ctl.pointerMove(e.pointerId, p.x, p.y, performance.now());
    };
    const onHudEnd = (e: PointerEvent) => {
      if (!hudTouches.delete(e.pointerId) || !forwarding) return;
      const now = performance.now();
      if (e.type === 'pointerup') ctl.pointerUp(e.pointerId, now);
      else ctl.pointerCancel(e.pointerId, now);
      // The fingers were on buttons: the gesture must not also press one.
      swallowClickUntil = now + 400;
      if (hudTouches.size === 0) forwarding = false;
    };
    const onWindowClick = (e: MouseEvent) => {
      if (performance.now() > swallowClickUntil) return;
      swallowClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    };
    const onCancel = (e: PointerEvent) => {
      ctl.pointerCancel(e.pointerId, performance.now());
      window.clearTimeout(longTimer);
      if (press?.id === e.pointerId) press = null;
      if (captured === e.pointerId) captured = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      const px = wheelPixels(e.shiftKey && !e.ctrlKey && e.deltaY === 0 ? e.deltaX : e.deltaY, e.deltaMode, el.clientHeight);
      ctl.wheelInput(px, x, y, { ctrl: e.ctrlKey, shift: e.shiftKey }, performance.now());
    };
    const onDbl = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLCanvasElement) || performance.now() - lastDouble < 600) return;
      lastClick = null;
      const { x, y } = local(e);
      handlers.current.doubleClick(x, y);
    };
    const onContext = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!kb.current || !keyIsForCamera(e)) return;
      if (ctl.keyDown(e.code, e.shiftKey, e.repeat, performance.now())) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => ctl.keyUp(e.code, e.shiftKey);
    const onBlur = () => ctl.releaseKeys();

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onCancel);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onWindowDown, true);
    window.addEventListener('click', onWindowClick, true);
    window.addEventListener('pointerdown', onHudDown, true);
    window.addEventListener('pointermove', onHudMove, true);
    window.addEventListener('pointerup', onHudEnd, true);
    window.addEventListener('pointercancel', onHudEnd, true);
    return () => {
      window.removeEventListener('pointerdown', onWindowDown, true);
      window.removeEventListener('click', onWindowClick, true);
      window.removeEventListener('pointerdown', onHudDown, true);
      window.removeEventListener('pointermove', onHudMove, true);
      window.removeEventListener('pointerup', onHudEnd, true);
      window.removeEventListener('pointercancel', onHudEnd, true);
      window.clearTimeout(longTimer);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [wrap, ctl, handlers]);
}
