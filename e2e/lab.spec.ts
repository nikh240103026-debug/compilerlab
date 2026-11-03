import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** The real tools are not on every machine, so most tests pick the engine that always exists. */
async function chooseSimulated(page: Page) {
  await page.getByLabel('Engine').selectOption('simulated');
}

async function openExercise(page: Page, id: string) {
  await page.goto(`/lab/${id}`);
  await expect(page.locator('[data-testid=code-editor] .view-lines')).toBeVisible({
    timeout: 20_000,
  });
  // A terminal that is not ready yet would miss the first output.
  await expect(page.locator('[data-testid=terminal] .xterm-rows')).toBeVisible();
  await chooseSimulated(page);
}

/** Types into Monaco as a student would, replacing what is there. */
async function replaceCode(page: Page, code: string) {
  await page.locator('[data-testid=code-editor] .view-lines').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // insertText skips auto-indent, which would otherwise change what was typed.
  await page.keyboard.insertText(code);
}

const run = (page: Page) => page.getByRole('button', { name: 'Run', exact: true }).click();
const terminalText = (page: Page) => page.locator('[data-testid=terminal] .xterm-rows');
const tab = (page: Page, name: string) => page.getByRole('tab', { name });

async function resetWork(page: Page, id: string) {
  await page.request.delete(`/api/lab/workspaces/${id}`);
}

test.describe('the lab page', () => {
  test('lists at least 8 Module 1 exercises and links to them', async ({ page }) => {
    await page.goto('/lab');
    await expect(page.getByRole('heading', { level: 1, name: 'Lab' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lexical analysis' })).toBeVisible();
    expect(await page.locator('a[href^="/lab/"]').count()).toBeGreaterThanOrEqual(9);
    await page.getByRole('link', { name: /Word counter/ }).click();
    await expect(page).toHaveURL(/\/lab\/word-counter$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Word counter' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: /breadcrumb/i }).getByText('Word counter'),
    ).toBeVisible();
  });

  test('has no accessibility problems', async ({ page }) => {
    await page.goto('/lab');
    await expect(page.getByRole('link', { name: /Word counter/ })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('explains a link to an exercise that does not exist', async ({ page }) => {
    await page.goto('/lab/no-such-exercise');
    await expect(page.getByText('There is no exercise with that name')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the lab' })).toBeVisible();
  });

  test('does not load the editor until it is needed', async ({ page }) => {
    const heavy: string[] = [];
    page.on('request', (request) => {
      if (/code-editor|terminal-pane|editor\.worker/.test(request.url())) heavy.push(request.url());
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Long enough for the idle preloading of the other pages to finish.
    await page.waitForTimeout(1500);
    expect(heavy).toEqual([]);
    await page.goto('/lab');
    await expect(page.getByRole('heading', { level: 1, name: 'Lab' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(heavy).toEqual([]);
  });
});

test.describe('a workspace', () => {
  test.beforeEach(({ page }) => resetWork(page, 'word-counter'));

  test('runs a Lex program, labels it Simulated and streams the result', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await openExercise(page, 'word-counter');
    await page.getByLabel('Input (stdin)').fill('one two\nthree\n');
    await run(page);
    await expect(terminalText(page)).toContainText('Finished.');
    await expect(terminalText(page)).toContainText('[Simulated]');
    // The starter does not count words yet: 2 lines, 0 words, 14 characters.
    await expect(terminalText(page)).toContainText('2 0 14');

    await tab(page, 'Output').click();
    await expect(page.getByTestId('program-output')).toHaveText('2 0 14\n');
    await expect(
      page.getByRole('tabpanel', { name: 'Output' }).getByText('Simulated', { exact: true }),
    ).toBeVisible();

    await tab(page, 'Build log').click();
    await expect(page.getByRole('list', { name: 'Build steps' }).getByRole('listitem')).toHaveCount(
      2,
    );
    expect(problems).toEqual([]);
  });

  test('passes an exercise with its solution and remembers that', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Tests' }).getByRole('status')).toContainText(
      'of 5 tests passed',
    );
    // A visible failure shows why, and a hidden one does not give the test away.
    const results = page.getByRole('list', { name: 'Test results' });
    await expect(results.getByText('Expected').first()).toBeVisible();
    await expect(results.getByText('Hidden').first()).toBeVisible();

    await page.getByRole('button', { name: 'Show a hint' }).click();
    await expect(page.getByText('Hint 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Show the solution' }).click();
    await expect(page.getByRole('heading', { name: 'Solution' })).toBeVisible();
    await page.getByRole('button', { name: 'Use this solution' }).click();
    await page.getByRole('button', { name: 'Yes, replace' }).click();
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText('words++');

    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Tests' }).getByRole('status')).toHaveText(
      'All 5 tests passed.',
    );

    await page.goto('/lab');
    await expect(
      page.getByRole('link', { name: /Word counter/ }).getByText('Passed'),
    ).toBeVisible();
    await page.goto('/learn/lexical-analysis/lex-and-flex');
    const listed = page.getByRole('list', { name: 'Lab exercises for this topic' });
    await expect(listed.getByRole('link', { name: /Word counter/ })).toContainText('Passed');
    await listed.getByRole('link', { name: /Word counter/ }).click();
    await expect(page).toHaveURL(/\/lab\/word-counter$/);
  });

  test('marks a mistake in the code and explains it', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await replaceCode(page, '%%\n[a-z ;\n');
    await run(page);

    const log = page.getByRole('tabpanel', { name: 'Build log' });
    await expect(tab(page, 'Build log')).toHaveAttribute('aria-selected', 'true');
    await expect(log.getByText('This character class is never closed.')).toBeVisible();
    await expect(log.getByText(/Add a "\]"/)).toBeVisible();
    await expect(page.locator('[data-testid=code-editor] .squiggly-error')).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('[role=tabpanel]:not([hidden])').analyze();
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);

    await log.getByRole('button', { name: 'word_count.l, line 2' }).click();
    await expect(page.locator('[data-testid=code-editor] .active-line-number')).toHaveText('2');

    await log.getByRole('button', { name: 'Ask AI' }).click();
    await expect(page).toHaveURL(/\/tutor$/);
  });

  test('stops a runaway program, by button and by time limit', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await replaceCode(page, '%%\na ;\n%%\nint main(void) {\n  for (;;) { }\n  return 0;\n}\n');
    await run(page);
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(terminalText(page)).toContainText('Stopped.');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

    await run(page);
    await expect(terminalText(page)).toContainText('infinite loop', { timeout: 10_000 });
  });

  test('keeps output bounded when a program prints forever', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await replaceCode(
      page,
      '%%\na ;\n%%\nint main(void) {\n  for (;;) printf("spam spam spam\\n");\n  return 0;\n}\n',
    );
    await run(page);
    await expect(terminalText(page)).toContainText('so it was stopped', { timeout: 15_000 });
    await tab(page, 'Output').click();
    const size = await page
      .getByTestId('program-output')
      .evaluate((node) => node.textContent?.length ?? 0);
    expect(size).toBeLessThanOrEqual(1024 * 1024);
    expect(size).toBeGreaterThan(1000 * 1000);
  });

  test('saves work between visits, and can start over', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await replaceCode(page, '%%\nmy_saved_rule ;\n');
    await page.getByLabel('Input (stdin)').fill('my saved input');
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/lab/workspaces/') && response.request().method() === 'PUT',
    );
    await saved;
    await page.waitForTimeout(800);
    await page.reload();
    const editor = page.locator('[data-testid=code-editor] .view-lines');
    await expect(editor).toContainText('my_saved_rule');
    await expect(page.getByLabel('Input (stdin)')).toHaveValue('my saved input');

    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('button', { name: 'Keep my work' }).click();
    await expect(editor).toContainText('my_saved_rule');
    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('button', { name: 'Yes, replace' }).click();
    await expect(editor).toContainText('TODO');
  });

  test('saves the last change even when leaving right after it', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await replaceCode(page, '%%\nleaving_quickly ;\n');
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/lab/workspaces/') && response.request().method() === 'PUT',
    );
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await saved;
    await page.goto('/lab/word-counter');
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText(
      'leaving_quickly',
    );
  });

  test('shows the token stream and replays it in the visual trace', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await expect(page.getByRole('button', { name: 'Visualize' })).toBeDisabled();
    await replaceCode(
      page,
      '%%\n[a-z]+ { return 1; }\n" " ;\n%%\nint main(void) { while (yylex()); return 0; }\n',
    );
    await page.getByLabel('Input (stdin)').fill('ab cd');
    await run(page);
    await expect(terminalText(page)).toContainText('Finished.');

    await tab(page, 'Token stream').click();
    const table = page.getByTestId('token-table');
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table.getByRole('row').nth(1)).toContainText('[a-z]+');
    await expect(table.getByRole('row').nth(1)).toContainText('ab');

    await page.getByRole('button', { name: 'Visualize' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Visual trace' });
    await expect(panel.getByLabel('Lexer rules')).toHaveValue(/\[a-z\]\+/);
    await expect(panel.getByLabel('Source code')).toHaveValue('ab cd');
    await expect(panel.getByRole('button', { name: /next|step forward/i }).first()).toBeVisible();
    await expect(panel.getByText('not output from the real tools')).toBeVisible();
  });

  test('says what Simulated mode cannot do', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await run(page);
    await expect(terminalText(page)).toContainText('Finished.');
    await tab(page, 'Generated files').click();
    await expect(page.getByText('does not write a lex.yy.c file')).toBeVisible();

    await page.getByLabel('Pipeline').selectOption('c');
    await run(page);
    await expect(
      page
        .getByRole('tabpanel', { name: 'Build log' })
        .getByText('Simulated mode only runs Lex programs'),
    ).toBeVisible();
  });

  test('has no accessibility problems with results showing, in both themes', async ({ page }) => {
    await openExercise(page, 'word-counter');
    await run(page);
    await expect(terminalText(page)).toContainText('Finished.');
    for (const name of ['Build log', 'Output', 'Token stream', 'Generated files', 'Tests']) {
      await tab(page, name).click();
      const results = await new AxeBuilder({ page })
        // Monaco and xterm draw their own widgets, and are tested by their own projects.
        .exclude('[data-testid=code-editor]')
        .exclude('[data-testid=terminal]')
        .analyze();
      expect(
        results.violations.map(
          (violation) => `${violation.id}: ${violation.nodes[0]?.html.slice(0, 200)}`,
        ),
        name,
      ).toEqual([]);
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await tab(page, 'Build log').click();
    await page.waitForTimeout(300);
    const dark = await new AxeBuilder({ page })
      .exclude('[data-testid=code-editor]')
      .exclude('[data-testid=terminal]')
      .analyze();
    expect(dark.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('can be used from the keyboard', async ({ page }) => {
    await openExercise(page, 'word-counter');
    const terminal = tab(page, 'Terminal');
    await terminal.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Build log')).toBeFocused();
    await expect(tab(page, 'Build log')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab(page, 'Tests')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(terminal).toBeFocused();

    await page.locator('[data-testid=code-editor] .view-lines').click();
    await page.keyboard.press('Control+Enter');
    await expect(terminalText(page)).toContainText('Finished.');
  });

  test('fits a 1280 by 720 screen and a tablet', async ({ page }) => {
    await openExercise(page, 'word-counter');
    const noPageScroll = () =>
      page.evaluate(() => {
        const main = document.querySelector('#main') as HTMLElement;
        return main.scrollWidth <= main.clientWidth;
      });
    expect(await noPageScroll()).toBe(true);
    await page.setViewportSize({ width: 820, height: 1100 });
    await page.waitForTimeout(200);
    expect(await noPageScroll()).toBe(true);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  });
});

test.describe('free practice', () => {
  test.beforeEach(({ page }) => resetWork(page, 'scratch'));

  test('manages files and refuses unsafe names', async ({ page }) => {
    await openExercise(page, 'practice');
    await expect(page.getByRole('heading', { level: 1, name: 'Free practice' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check' })).toHaveCount(0);

    await page.getByRole('button', { name: 'New file' }).click();
    const name = page.getByLabel('New file name');
    await name.fill('../evil.c');
    await expect(page.getByText(/no folders/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await name.fill('scanner.l');
    await expect(page.getByText('A file with that name already exists.')).toBeVisible();
    await name.fill('lex.yy.c');
    await expect(page.getByText(/tools write a file/)).toBeVisible();
    await name.fill('notes.txt');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const files = page.getByRole('region', { name: 'Files' });
    await expect(files.getByRole('button', { name: 'notes.txt', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await page.locator('[data-testid=code-editor] .view-lines').click();
    await page.keyboard.insertText('some notes');

    await files.getByRole('button', { name: 'Rename notes.txt' }).click();
    await page.getByLabel('Rename notes.txt').fill('renamed.txt');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(files.getByRole('button', { name: 'renamed.txt', exact: true })).toBeVisible();

    await files.getByRole('button', { name: 'scanner.l', exact: true }).click();
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText('NUMBER');
    await files.getByRole('button', { name: 'renamed.txt', exact: true }).click();
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText('some notes');

    await files.getByRole('button', { name: 'Delete renamed.txt' }).click();
    await expect(files.getByRole('button', { name: 'renamed.txt', exact: true })).toHaveCount(0);
  });

  test('runs the starting template and offers others', async ({ page }) => {
    await openExercise(page, 'practice');
    await run(page);
    await expect(terminalText(page)).toContainText('NUMBER 42');

    await page.getByLabel('Template').selectOption({ label: 'C program' });
    await page.getByRole('button', { name: 'Use this template' }).click();
    await page.getByRole('button', { name: 'Yes, replace' }).click();
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText('fgets');
    await expect(page.getByLabel('Pipeline')).toHaveValue('c');
    await expect(page.getByLabel('Language standard')).toContainText('c17');
    await expect(
      page
        .getByRole('region', { name: 'Files' })
        .getByRole('button', { name: 'main.c', exact: true }),
    ).toBeVisible();
  });

  test('offers the vim key bindings chosen in Settings', async ({ page }) => {
    await page.request.patch('/api/settings', { data: { editorKeymap: 'vim' } });
    try {
      await openExercise(page, 'practice');
      await page.locator('[data-testid=code-editor] .view-lines').click();
      // The status line shows up only if the vim mode really attached.
      await expect(page.getByText('--NORMAL--')).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('i');
      await expect(page.getByText('--INSERT--')).toBeVisible();
    } finally {
      await page.request.patch('/api/settings', { data: { editorKeymap: 'default' } });
    }
  });

  test('offers the emacs key bindings chosen in Settings', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    await page.request.patch('/api/settings', { data: { editorKeymap: 'emacs' } });
    try {
      await openExercise(page, 'practice');
      await page.locator('[data-testid=code-editor] .view-lines').click();
      await page.waitForTimeout(800);
      // Start of the file first, so only a real Emacs Ctrl+E can put the text at the end of the line.
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Control+E');
      await page.keyboard.insertText('MARKER');
      await expect(page.locator('[data-testid=code-editor] .view-lines')).toContainText('%{MARKER');
      expect(problems).toEqual([]);
    } finally {
      await page.request.patch('/api/settings', { data: { editorKeymap: 'default' } });
    }
  });
});

test.describe('with the real tools', () => {
  test('runs flex and gcc and shows the generated file', async ({ page, request }) => {
    const status = (await (await request.get('/api/system/status')).json()) as { labMode: string };
    test.skip(status.labMode !== 'real', 'flex, gcc and g++ are not installed on this machine.');

    await resetWork(page, 'word-counter');
    await page.goto('/lab/word-counter');
    await expect(page.locator('[data-testid=code-editor] .view-lines')).toBeVisible({
      timeout: 20_000,
    });
    await run(page);
    await expect(terminalText(page)).toContainText('Finished.', { timeout: 30_000 });
    await expect(page.getByText('Real tools').first()).toBeVisible();
    await tab(page, 'Generated files').click();
    await expect(page.getByLabel('File')).toHaveValue('lex.yy.c');
    await expect(page.getByTestId('generated-code')).toContainText('yy');
    await tab(page, 'Token stream').click();
    await expect(page.getByText('reported by flex -d')).toBeVisible();
  });
});
