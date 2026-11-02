import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const VISUALIZERS = [
  ['regex-to-nfa', 'Regex to NFA'],
  ['subset-construction', 'Subset construction'],
  ['dfa-minimization', 'DFA minimization'],
  ['followpos', 'Regex to DFA directly'],
  ['automaton-run', 'Automaton simulator'],
  ['token-stream', 'Token stream player'],
  ['input-buffer', 'Input buffering'],
  ['automata-builder', 'Automata builder'],
] as const;

const player = (page: Page) => page.getByLabel('Scrub through the steps');
const stepOf = async (page: Page) => Number(await player(page).inputValue());

let problems: string[] = [];

test.beforeEach(async ({ request, baseURL, page }) => {
  await request.post(`${baseURL}/api/settings/reset`);
  problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
});

for (const [id, title] of VISUALIZERS) {
  test(`${title} runs in a worker, plays, and has no console errors`, async ({ page }) => {
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));

    await page.goto(`/visualize/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(player(page)).toBeVisible({ timeout: 15000 });

    expect(workers.join()).toContain('engine.worker');

    await page.getByRole('button', { name: 'Step forward' }).click();
    expect(await stepOf(page)).toBe(1);
    await page.getByRole('button', { name: 'Step back' }).click();
    expect(await stepOf(page)).toBe(0);

    expect(problems).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${title} has no axe violations in the ${theme} theme`, async ({
      page,
      request,
      baseURL,
    }) => {
      await request.patch(`${baseURL}/api/settings`, { data: { theme } });
      await page.goto(`/visualize/${id}`);
      await expect(player(page)).toBeVisible({ timeout: 15000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // Mid-trace, so highlighted states and active table cells get checked too.
      await page.getByRole('button', { name: 'Step forward' }).click();
      await page.getByRole('button', { name: 'Step forward' }).click();
      // Let the caption's fade finish, because contrast is only meaningful at full opacity.
      await page.waitForTimeout(400);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target.join(' ')),
        })),
      ).toEqual([]);
    });
  }
}

test('the visualize page lists every visualizer', async ({ page }) => {
  await page.goto('/visualize');
  for (const [, title] of VISUALIZERS) {
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  }
});

test('an unknown visualizer explains itself', async ({ page }) => {
  await page.goto('/visualize/nope');
  await expect(page.getByText('There is no visualizer with that name')).toBeVisible();
});

test.describe('the player', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/visualize/regex-to-nfa');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
  });

  test('plays on its own and pauses', async ({ page }) => {
    await page.getByLabel('Speed').fill('4');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => stepOf(page), { timeout: 5000 }).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await stepOf(page);
    await page.waitForTimeout(800);
    expect(await stepOf(page)).toBe(paused);
  });

  test('scrubs, jumps to the ends, and explains each step', async ({ page }) => {
    await player(page).fill('3');
    await expect(page.getByText('Kleene star', { exact: true })).toBeVisible();
    await expect(page.getByText(/zero or more repeats/)).toBeVisible();
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText('Finished', { exact: true })).toBeVisible();
    await expect(page.getByText(/with 11 states/)).toBeVisible();
    await page.getByRole('button', { name: 'Go to the first step' }).click();
    expect(await stepOf(page)).toBe(0);
  });

  test('works from the keyboard', async ({ page }) => {
    await page.getByRole('button', { name: 'Step forward' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await stepOf(page)).toBe(2);
    await page.keyboard.press('ArrowLeft');
    expect(await stepOf(page)).toBe(1);
    await page.keyboard.press('End');
    await expect(page.getByText('Finished', { exact: true })).toBeVisible();
    await page.keyboard.press('Home');
    expect(await stepOf(page)).toBe(0);
    await page.keyboard.press('+');
    await expect(page.getByText('1.25x')).toBeVisible();
  });

  test('draws the finished NFA with the textbook state count', async ({ page }) => {
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByRole('img', { name: /11 states/ })).toBeVisible();
  });

  async function downloadFrom(
    page: Page,
    name: string,
  ): Promise<{ file: Download; bytes: Buffer }> {
    const started = page.waitForEvent('download');
    await page.getByRole('group', { name: 'Export' }).getByRole('button', { name }).click();
    const file = await started;
    return { file, bytes: readFileSync(await file.path()) };
  }

  test('exports a step as SVG with the theme colors written in', async ({ page }) => {
    await player(page).fill('2');
    const { file, bytes } = await downloadFrom(page, 'SVG');
    expect(file.suggestedFilename()).toBe('regex-to-nfa-step-3.svg');
    const text = bytes.toString();
    expect(text).toMatch(/^<svg/);
    expect(text).not.toContain('var(--');
    expect(text).toContain('Union');
  });

  test('exports a step as PNG', async ({ page }) => {
    const { file, bytes } = await downloadFrom(page, 'PNG');
    expect(file.suggestedFilename()).toBe('regex-to-nfa-step-1.png');
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.length).toBeGreaterThan(2000);
  });

  test('exports the whole run as an animated GIF', async ({ page }) => {
    const { file, bytes } = await downloadFrom(page, 'GIF');
    expect(file.suggestedFilename()).toBe('regex-to-nfa.gif');
    expect(bytes.subarray(0, 3).toString()).toBe('GIF');
    // One image block per frame. The trace for this expression has 11 steps.
    let frames = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) frames++;
    }
    // A byte pair can also occur by chance inside image data, so this is a lower bound.
    expect(frames).toBeGreaterThanOrEqual(11);
  });
});

test.describe('the playground', () => {
  test('shows a bad regex with its position, a hint and Ask AI, then recovers', async ({
    page,
  }) => {
    await page.goto('/visualize/regex-to-nfa');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Regular expression').fill('(a|b');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('never closed');
    await expect(alert).toContainText('^');
    await expect(alert).toContainText('Add a ")"');

    await page.getByLabel('Regular expression').fill('a|b');
    await expect(alert).toBeHidden();
    await expect(player(page)).toBeVisible();

    await page.getByLabel('Regular expression').fill('*');
    await page.getByRole('alert').getByRole('button', { name: 'Ask AI' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'AI tutor' })).toBeVisible();
    await expect(page.getByText(/has nothing before it to repeat/)).toBeVisible();
  });

  test('stays usable when subset construction would explode', async ({ page }) => {
    await page.goto('/visualize/subset-construction');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Regular expression').fill(`(a|b)*a${'(a|b)'.repeat(10)}`);
    await expect(page.getByRole('alert')).toContainText('more than 300 states', { timeout: 15000 });
    await page.getByLabel('Regular expression').fill('a');
    await expect(player(page)).toBeVisible();
  });

  test('finds the textbook results for subset construction and minimization', async ({ page }) => {
    await page.goto('/visualize/subset-construction');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText(/the DFA has 5 states/)).toBeVisible();

    await page.goto('/visualize/dfa-minimization');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText(/gives 4 states/)).toBeVisible();
    await expect(page.getByText('The minimal DFA', { exact: true })).toBeVisible();
  });

  test('simulates a string and tells accepted from rejected', async ({ page }) => {
    await page.goto('/visualize/automaton-run');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
    await page.getByLabel('Input string').fill('abba');
    await expect(page.getByRole('img', { name: /Input: abba/ })).toBeVisible();
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  });

  test('the token stream applies longest match and reports errors', async ({ page }) => {
    await page.goto('/visualize/token-stream');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Source code').fill('iffy >= 1 @');
    // Typing settles after a moment, and then the player restarts on the new input.
    await expect(page.locator('main pre').first()).toContainText('iffy', { timeout: 5000 });
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    const tokens = page.getByRole('list', { name: 'Tokens so far' });
    await expect(tokens).toContainText('ID iffy');
    await expect(tokens).toContainText('RELOP >=');
    await expect(page.getByRole('list', { name: 'Lexical errors' })).toContainText(
      'Line 1, column 11: No rule matches "@".',
    );
  });

  test('warns about a rule that can never match', async ({ page }) => {
    await page.goto('/visualize/token-stream');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Lexer rules').fill('ID [a-z]+\nIF if\nWS [ ]+ %skip');
    await expect(page.getByText(/Rule IF can never match/)).toBeVisible();
    await expect(page.getByText(/the earlier rule ID/)).toBeVisible();
  });
});

test.describe('the automata builder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/visualize/automata-builder');
    await expect(player(page)).toBeVisible({ timeout: 15000 });
  });

  test('starts with a DFA and runs a string on it', async ({ page }) => {
    await expect(page.getByText('a DFA', { exact: true })).toBeVisible();
    await page.getByLabel('Test a string').fill('abb');
    await expect(page.getByRole('img', { name: /Input: abb\./ })).toBeVisible();
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  });

  test('builds an automaton from nothing using only the form', async ({ page }) => {
    await page.getByRole('button', { name: 'Empty' }).click();
    await expect(page.getByText('Add a state to get started.')).toBeVisible();

    await page.getByRole('button', { name: 'Add state' }).click();
    await expect(page.getByText('Mark at least one state as accepting.')).toBeVisible();
    await page.getByLabel('Accepting').check();
    await page.getByRole('button', { name: 'Add transition' }).click();
    await page.getByLabel('Test a string').fill('aaa');
    await expect(page.getByRole('img', { name: /Input: aaa/ })).toBeVisible();
    await page.getByRole('button', { name: 'Go to the last step' }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

    await page.getByLabel('Check against a regular expression').fill('a*');
    await expect(page.getByText('Your automaton accepts exactly this language.')).toBeVisible();
    await page.getByLabel('Check against a regular expression').fill('a+');
    await expect(page.getByText(/Your automaton accepts\s+the empty string/)).toBeVisible();
  });

  test('tells a DFA from an NFA and an ε-NFA', async ({ page }) => {
    await page.getByRole('button', { name: 'ε-NFA' }).click();
    await expect(page.getByText('an ε-NFA', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Ends in abb' }).click();
    const form = page.getByRole('form', { name: 'Add a transition' });
    await form.getByRole('combobox').nth(0).selectOption({ label: 'q0' });
    await form.getByRole('combobox').nth(1).selectOption({ label: 'q3' });
    await page.getByRole('button', { name: 'Add transition' }).click();
    await expect(page.getByText('an NFA', { exact: true })).toBeVisible();
  });

  test('moves a state by dragging and draws an edge by dragging from its ring', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Empty' }).click();
    await page.getByRole('button', { name: 'Add state' }).click();
    await page.getByRole('button', { name: 'Add state' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    const first = page.locator('.react-flow__node').first();
    const second = page.locator('.react-flow__node').nth(1);
    const before = (await first.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 40, before.y + 120, { steps: 8 });
    await page.mouse.up();
    const after = (await first.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(20);

    const from = (await first.boundingBox())!;
    const to = (await second.boundingBox())!;
    // Within the ring, outside the middle that drags the state.
    await page.mouse.move(from.x + 3, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('explains a bad edge label', async ({ page }) => {
    await page.getByLabel('On', { exact: true }).fill('xy');
    await page.getByRole('button', { name: 'Add transition' }).click();
    await expect(page.getByText(/"xy" is more than one symbol/)).toBeVisible();
  });

  test('keeps a draft across a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'ε-NFA' }).click();
    await expect(page.getByText('an ε-NFA', { exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByText('an ε-NFA', { exact: true })).toBeVisible({ timeout: 15000 });
  });
});
