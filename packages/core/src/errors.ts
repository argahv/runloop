/** Thrown by reducers when an event does not directly follow the last folded sequence. */
export class SequenceGapError extends Error {
  readonly expected: number;
  readonly got: number;

  constructor(expected: number, got: number) {
    super(`Sequence gap: expected ${expected}, got ${got}`);
    this.name = 'SequenceGapError';
    this.expected = expected;
    this.got = got;
  }
}
