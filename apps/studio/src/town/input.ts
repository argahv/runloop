'use client';
/**
 * DOM input for the town (contract §2.2): pointer, touch, wheel and keys go to
 * the camera controller; a press that never became a drag is a click (select),
 * a double click or double tap enters a building (or flies to open ground),
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
    let lastTap: { x: number; y: number; t: number } | null = null;
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
      // Touch: a second tap close by is a double tap (mouse double clicks arrive as dblclick).
      if (e.pointerType === 'touch') {
        if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 24) {
          lastTap = null;
          handlers.current.doubleClick(x, y);
        } else lastTap = { x, y, t: now };
      }
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
      if (!(e.target instanceof HTMLCanvasElement)) return;
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
    return () => {
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
