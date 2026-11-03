// C programs see bytes, so the simulated scanner does too. That keeps yyleng and character
// classes the same as with real flex when the input has non-ASCII text.

export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) as number;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

const REPLACEMENT = '�';

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** Turns bytes into text, holding back a character that is split across two writes. */
export class Utf8Decoder {
  private pending: number[] = [];

  write(bytes: readonly number[]): string {
    const all = this.pending.length > 0 ? [...this.pending, ...bytes] : bytes;
    this.pending = [];
    let text = '';
    let at = 0;
    while (at < all.length) {
      const lead = (all[at] as number) & 0xff;
      const length = sequenceLength(lead);
      if (length === 0) {
        text += REPLACEMENT;
        at++;
        continue;
      }
      if (at + length > all.length) {
        this.pending = all.slice(at).map((byte) => byte & 0xff);
        break;
      }
      let point = length === 1 ? lead : lead & (0xff >> (length + 1));
      let valid = true;
      for (let i = 1; i < length; i++) {
        const next = (all[at + i] as number) & 0xff;
        if ((next & 0xc0) !== 0x80) valid = false;
        point = (point << 6) | (next & 0x3f);
      }
      text += valid ? String.fromCodePoint(point) : REPLACEMENT;
      at += valid ? length : 1;
    }
    return text;
  }

  /** Whatever is still held back at the end of the output can never be completed. */
  flush(): string {
    const text = this.pending.length > 0 ? REPLACEMENT : '';
    this.pending = [];
    return text;
  }
}
