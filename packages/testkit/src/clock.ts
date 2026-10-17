/** Manually advanced clock producing ISO timestamps. */
export class FakeClock {
  private ms: number;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.ms = Date.parse(startIso);
  }

  now(): number {
    return this.ms;
  }

  iso(): string {
    return new Date(this.ms).toISOString();
  }

  advance(ms: number): this {
    this.ms += ms;
    return this;
  }
}
