const MAX_WIDTH = 4096;

function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) return text;
  if (left) return text.padEnd(width, ' ');
  if (!zero) return text.padStart(width, ' ');
  const sign = /^[-+ ]/.test(text) ? (text[0] as string) : '';
  return sign + text.slice(sign.length).padStart(width - sign.length, '0');
}

/** Extra digits to look at when checking for an exact tie. JavaScript allows 100 in total. */
const TIE_DIGITS = 30;

/**
 * JavaScript rounds an exact tie up, while C rounds it to the even digit: printf("%.0f", 2.5)
 * prints 2. So when the digits after the cut are exactly 5000..., and the last digit kept is
 * even, this drops them. Everything else rounds the same way in both languages.
 */
function evenTie(precise: string, keptLength: number): string | null {
  if (!/^50*$/.test(precise.slice(keptLength))) return null;
  const kept = precise.slice(0, keptLength).replace(/\.$/, '');
  return Number(kept.at(-1)) % 2 === 0 ? kept : null;
}

function fixed(value: number, digits: number): string {
  if (value >= 1e21) return `${BigInt(value)}${digits > 0 ? `.${'0'.repeat(digits)}` : ''}`;
  const extra = Math.min(TIE_DIGITS, 100 - digits);
  const precise = value.toFixed(digits + extra);
  return evenTie(precise, precise.length - extra) ?? value.toFixed(digits);
}

/** JavaScript writes 1.5e+0. C writes 1.500000e+00. */
function exponential(value: number, precision: number, upper: boolean): string {
  const extra = Math.min(TIE_DIGITS, 100 - precision);
  const [digits = '', power = ''] = value.toExponential(precision + extra).split('e');
  const tie = evenTie(digits, digits.length - extra);
  const rounded = tie ? `${tie}e${power}` : value.toExponential(precision);
  const text = rounded.replace(/e([-+])(\d)$/, 'e$10$2');
  return upper ? text.toUpperCase() : text;
}

function general(value: number, precisionIn: number, upper: boolean): string {
  const precision = precisionIn === 0 ? 1 : precisionIn;
  if (value === 0) return '0';
  const exponent = Number(value.toExponential(precision - 1).split('e')[1]);
  const fixedForm = exponent >= -4 && exponent < precision;
  const text = fixedForm
    ? fixed(value, precision - 1 - exponent)
    : exponential(value, precision - 1, upper);
  if (!text.includes('.')) return text;
  // %g drops trailing zeros.
  return fixedForm ? text.replace(/\.?0+$/, '') : text.replace(/\.?0+(?=[eE])/, '');
}

function notFinite(value: number, upper: boolean): string {
  const text = Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf';
  return upper ? text.toUpperCase() : text;
}

export interface PrintfArgs {
  /** The next argument as a number, truncated for an integer conversion. */
  int(): number;
  float(): number;
  /** The next argument as the bytes of a C string. */
  text(): number[];
  pointer(): string;
}

/** Formats like C's printf. Text is bytes, so %5s pads by bytes as it does in C. */
export function formatPrintf(format: readonly number[], args: PrintfArgs): number[] {
  const out: number[] = [];
  const pushText = (text: string) => {
    for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
  };
  let at = 0;
  while (at < format.length) {
    const code = format[at] as number;
    if (code !== 0x25) {
      out.push(code);
      at++;
      continue;
    }
    at++;
    let left = false;
    let plus = false;
    let space = false;
    let zero = false;
    let alternate = false;
    for (; at < format.length; at++) {
      const flag = String.fromCharCode(format[at] as number);
      if (flag === '-') left = true;
      else if (flag === '+') plus = true;
      else if (flag === ' ') space = true;
      else if (flag === '0') zero = true;
      else if (flag === '#') alternate = true;
      else break;
    }
    const readCount = (): number | null => {
      if (format[at] === 0x2a) {
        at++;
        return args.int();
      }
      let digits = '';
      while (
        at < format.length &&
        (format[at] as number) >= 0x30 &&
        (format[at] as number) <= 0x39
      ) {
        digits += String.fromCharCode(format[at] as number);
        at++;
      }
      return digits ? Number(digits) : null;
    };
    let width = readCount() ?? 0;
    if (width < 0) {
      left = true;
      width = -width;
    }
    width = Math.min(width, MAX_WIDTH);
    let precision: number | null = null;
    if (format[at] === 0x2e) {
      at++;
      precision = Math.min(readCount() ?? 0, MAX_WIDTH);
    }
    while (at < format.length && 'hlLzjt'.includes(String.fromCharCode(format[at] as number))) at++;
    if (at >= format.length) {
      pushText('%');
      break;
    }
    const conversion = String.fromCharCode(format[at] as number);
    at++;

    const signed = (text: string, negative: boolean) =>
      (negative ? '-' : plus ? '+' : space ? ' ' : '') + text;
    switch (conversion) {
      case '%':
        pushText('%');
        break;
      case 'd':
      case 'i': {
        const value = Math.trunc(args.int());
        let digits = Math.abs(value).toFixed(0);
        if (precision !== null) digits = digits.padStart(precision, '0');
        pushText(pad(signed(digits, value < 0), width, left, zero && precision === null));
        break;
      }
      case 'u':
      case 'x':
      case 'X':
      case 'o': {
        const raw = Math.trunc(args.int());
        // A negative int prints as its 32-bit unsigned form, as on common C compilers.
        const value = raw < 0 ? raw >>> 0 : raw;
        const radix = conversion === 'u' ? 10 : conversion === 'o' ? 8 : 16;
        let digits = value.toString(radix);
        if (conversion === 'X') digits = digits.toUpperCase();
        if (precision !== null) digits = digits.padStart(precision, '0');
        if (alternate && value !== 0 && radix !== 10) {
          digits = (radix === 8 ? '0' : conversion === 'X' ? '0X' : '0x') + digits;
        }
        pushText(pad(digits, width, left, zero && precision === null));
        break;
      }
      case 'c': {
        const byte = Math.trunc(args.int()) & 0xff;
        const padding = Math.max(0, width - 1);
        if (!left) pushText(' '.repeat(padding));
        out.push(byte);
        if (left) pushText(' '.repeat(padding));
        break;
      }
      case 's': {
        let bytes = args.text();
        if (precision !== null) bytes = bytes.slice(0, precision);
        const padding = Math.max(0, width - bytes.length);
        if (!left) pushText(' '.repeat(padding));
        for (const byte of bytes) out.push(byte & 0xff);
        if (left) pushText(' '.repeat(padding));
        break;
      }
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G': {
        const value = args.float();
        const upper = conversion === 'E' || conversion === 'G' || conversion === 'F';
        if (!Number.isFinite(value)) {
          pushText(pad(notFinite(value, upper), width, left, false));
          break;
        }
        const digits = precision ?? 6;
        const magnitude = Math.abs(value);
        const text =
          conversion === 'f' || conversion === 'F'
            ? fixed(magnitude, Math.min(digits, 100))
            : conversion === 'e' || conversion === 'E'
              ? exponential(magnitude, Math.min(digits, 100), upper)
              : general(magnitude, Math.min(digits, 100), upper);
        pushText(pad(signed(text, value < 0 || Object.is(value, -0)), width, left, zero));
        break;
      }
      case 'p':
        pushText(pad(args.pointer(), width, left, false));
        break;
      default:
        // An unknown conversion prints as written, which is what most C libraries do.
        pushText(`%${conversion}`);
    }
  }
  return out;
}
