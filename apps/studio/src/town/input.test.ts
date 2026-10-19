import { describe, expect, it } from 'vitest';
import { DOUBLE_MS, DOUBLE_PX, isDoublePress } from './input';

describe('double click on the town', () => {
  const first = { cx: 720, cy: 450, t: 1000 };
  it('a second press close in time and space is a double click, wherever it lands (the card the first click opened)', () => {
    expect(isDoublePress(first, 724, 452, 1200)).toBe(true);
    expect(isDoublePress(first, 720, 450, 1000 + DOUBLE_MS)).toBe(false);
    expect(isDoublePress(first, 720 + DOUBLE_PX, 450, 1100)).toBe(false);
    expect(isDoublePress(null, 720, 450, 1100)).toBe(false);
  });
});
