/** Clock-of-day helpers for the town file ("HH:MM" times, opening hours, schedules). */

export const DAY_MINUTES = 1440;

/** "08:30" → 510 */
export function minuteOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/** Minute of day (0–1439) of a tick or any minute count, negatives included. */
export function minuteOfDay(minutes: number): number {
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/** Whether `[open, close)` (minutes of day; close < open wraps past midnight) contains `minute`. */
export function inSpan(open: number, close: number, minute: number): boolean {
  if (open === close) return true;
  return open < close ? minute >= open && minute < close : minute >= open || minute < close;
}

/** Opening hours as minutes of day; null = always open. */
export interface Span {
  open: number;
  close: number;
}

export function spanOf(hours: { open: string; close: string } | null | undefined): Span | null {
  return hours ? { open: minuteOf(hours.open), close: minuteOf(hours.close) } : null;
}

export function isOpenAt(span: Span | null, minute: number): boolean {
  return span === null || inSpan(span.open, span.close, minuteOfDay(minute));
}
