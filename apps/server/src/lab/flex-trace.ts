import { LAB_LIMITS, type LabTokenMatch } from '@compilerlab/shared';

const ACCEPTING = /^--accepting (?:rule at line (\d+)|default rule) \("/;
const CHATTER =
  /^--(?:\(end of buffer or a NUL\)|EOF \(start condition \d+\)|scanner backing up)\r?\n/;
const MARKER = '--';
/** A lexeme bigger than this is not worth holding back the rest of stderr for. */
const MAX_HELD = 64 * 1024;

/**
 * `flex -d` makes the scanner report every rule it accepts on stderr. That is the true token
 * stream of the real scanner, so this class collects it and passes everything else through.
 *
 * A report looks like: --accepting rule at line 7 ("abc")
 * The lexeme is printed raw, so it can contain newlines.
 */
export class FlexTraceFilter {
  readonly matches: LabTokenMatch[] = [];
  truncated = false;
  private held = '';

  write(text: string): string {
    this.held += text;
    let passed = '';
    while (this.held) {
      if (!this.held.startsWith(MARKER)) {
        if (MARKER.startsWith(this.held)) break;
        const newline = this.held.indexOf('\n');
        const end = newline === -1 ? this.held.length : newline + 1;
        passed += this.held.slice(0, end);
        this.held = this.held.slice(end);
        continue;
      }
      const accepting = ACCEPTING.exec(this.held);
      if (accepting) {
        const close = /"\)\r?\n/.exec(this.held.slice(accepting[0].length));
        if (!close) {
          if (this.held.length <= MAX_HELD) break;
          passed += this.takeLine();
          continue;
        }
        this.record(
          accepting[1] ? Number(accepting[1]) : null,
          this.held.slice(accepting[0].length, accepting[0].length + close.index),
        );
        this.held = this.held.slice(accepting[0].length + close.index + close[0].length);
        continue;
      }
      const chatter = CHATTER.exec(this.held);
      if (chatter) {
        this.held = this.held.slice(chatter[0].length);
        continue;
      }
      // Could still be a report that has only partly arrived.
      if (!this.held.includes('\n') && this.held.length <= MAX_HELD) break;
      passed += this.takeLine();
    }
    return passed;
  }

  private takeLine(): string {
    const newline = this.held.indexOf('\n');
    const end = newline === -1 ? this.held.length : newline + 1;
    const line = this.held.slice(0, end);
    this.held = this.held.slice(end);
    return line;
  }

  private record(ruleLine: number | null, text: string): void {
    if (this.matches.length >= LAB_LIMITS.tokens) {
      this.truncated = true;
      return;
    }
    this.matches.push({ ruleLine, text });
  }

  /** The stream has ended, so anything held back was not a report after all. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}
