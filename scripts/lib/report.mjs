// @ts-check
const color = process.stdout.isTTY && !process.env.NO_COLOR;

/** @param {string} code @param {string} text */
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);

export const dim = (/** @type {string} */ text) => paint('2', text);
export const bold = (/** @type {string} */ text) => paint('1', text);

const LABELS = {
  ok: paint('32', '[ ok ]'),
  warn: paint('33', '[warn]'),
  fail: paint('31', '[FAIL]'),
};

/**
 * @param {'ok' | 'warn' | 'fail'} state
 * @param {string} title
 * @param {string} [detail]
 */
export function printCheck(state, title, detail = '') {
  console.log(`${LABELS[state]} ${title}${detail ? dim(`  ${detail}`) : ''}`);
}

/** @param {readonly string[]} lines */
export function printFix(lines) {
  for (const line of lines) console.log(`       ${line}`);
}
