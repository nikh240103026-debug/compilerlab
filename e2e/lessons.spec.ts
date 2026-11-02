import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

const LESSON = '/learn/lexical-analysis/role-of-the-lexer';

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

async function lessons(request: APIRequestContext, baseURL: string | undefined) {
  const response = await request.get(`${baseURL}/api/content/lessons`);
  return (await response.json()) as { id: string; module: string; title: string }[];
}

test('every lesson opens, with its template sections and no console errors', async ({
  page,
  request,
  baseURL,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  const all = await lessons(request, baseURL);
  expect(all.length).toBeGreaterThanOrEqual(14);
  for (const lesson of all) {
    await page.goto(`/learn/${lesson.module}/${lesson.id}`);
    await expect(heading(page, lesson.title)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Why this matters' })).toBeVisible();
    for (const section of [
      'Worked example',
      'Common mistakes',
      'Practice',
      'Quiz',
      'Summary',
      'Flashcards',
    ]) {
      await expect(
        page.getByRole('heading', { level: 2, name: section, exact: true }),
      ).toBeAttached();
    }
    expect(problems, lesson.id).toEqual([]);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`a lesson has no axe violations in the ${theme} theme`, async ({
    page,
    request,
    baseURL,
  }) => {
    await request.patch(`${baseURL}/api/settings`, { data: { theme } });
    await page.goto(LESSON);
    await expect(page.getByRole('heading', { name: 'Practice' })).toBeVisible();
    await expect(page.getByLabel('Scrub through the steps')).toBeVisible({ timeout: 15000 });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    ).toEqual([]);
    await request.post(`${baseURL}/api/settings/reset`);
  });
}

test('math renders, from a lesson with formulas, under the content security policy', async ({
  page,
}) => {
  await page.goto('/learn/lexical-analysis/regular-expressions');
  await expect(page.locator('.katex').first()).toBeVisible();
  const font = await page
    .locator('.katex')
    .first()
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font).toContain('KaTeX');
});

test('lessons make no requests beyond the local server', async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await page.goto(LESSON);
  await expect(page.getByLabel('Scrub through the steps')).toBeVisible({ timeout: 15000 });
  expect([...origins]).toEqual([baseURL]);
});

test('the module page lists its lessons, and links to them', async ({ page }) => {
  await page.goto('/learn/lexical-analysis');
  await expect(heading(page, 'Lexical analysis')).toBeVisible();
  await page.getByRole('link', { name: /The role of the lexer/ }).click();
  await expect(page).toHaveURL(new RegExp(`${LESSON}$`));
  await expect(heading(page, 'The role of the lexer')).toBeVisible();
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb.getByRole('link', { name: 'Lexical analysis' })).toBeVisible();
  await expect(breadcrumb.getByText('The role of the lexer')).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('an unknown topic explains itself', async ({ page }) => {
  await page.goto('/learn/lexical-analysis/nope');
  await expect(page.getByText('There is no topic with that name')).toBeVisible();
});

test('a Try it button loads the example into the visualizer', async ({ page }) => {
  await page.goto(LESSON);
  await expect(page.getByLabel('Scrub through the steps')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Run it without the spaces' }).click();
  await expect(page.getByLabel('Source code')).toHaveValue('E=M*C**2');
  // The tab's own rules still apply, so ** stays one token, as the lesson says.
  await expect(page.getByLabel('Lexer rules')).toHaveValue(/EXP/);
  await page.getByRole('button', { name: 'Go to the last step' }).click();
  await expect(page.getByRole('list', { name: 'Tokens so far' })).toContainText('EXP **');
});

test('a regex practice problem is graded by the engine, with a counterexample', async ({
  page,
}) => {
  await page.goto(LESSON);
  const field = page.getByLabel('Your regular expression');
  const check = page.getByRole('button', { name: 'Check with the engine' });

  await field.fill('[a-z]+');
  await check.click();
  await expect(page.getByText(/Your expression misses "A"/)).toBeVisible();

  await field.fill('(');
  await check.click();
  await expect(page.getByText(/never closed/)).toBeVisible();

  // Written differently from the reference answer, but the same language.
  await field.fill('[a-zA-Z]([a-zA-Z]|[0-9])*');
  await check.click();
  await expect(page.getByText(/Correct\. Your expression describes exactly/)).toBeVisible();
});

test('progress builds up and survives a reload', async ({ page, request, baseURL }) => {
  await page.goto(LESSON);
  const meter = page.getByRole('meter', { name: 'Mastery of this topic' });
  await expect(meter).toBeVisible();

  await page.getByRole('button', { name: 'Step forward' }).click({ timeout: 15000 });

  // Scrolling to the end of the lesson text counts as reading it.
  await page.getByRole('heading', { name: 'Common mistakes' }).scrollIntoViewIfNeeded();
  await page.getByRole('heading', { name: 'Practice' }).scrollIntoViewIfNeeded();
  await expect(page.getByText('Used a visualizer: done')).toBeAttached();
  await expect(page.getByText('Read the lesson: done')).toBeAttached();

  // Answer the quiz correctly from the bank.
  const bank = (await (
    await request.get(`${baseURL}/api/content/lessons/role-of-the-lexer/bank`)
  ).json()) as { quiz: { type: string; prompt: string; options?: string[]; answer?: number }[] };
  const quiz = page
    .getByRole('region', { name: 'Quiz' })
    .or(page.locator('section[aria-labelledby="quiz-heading"]'));
  for (const question of bank.quiz) {
    const card = quiz.getByRole('listitem').filter({ hasText: question.prompt.slice(0, 40) });
    if (question.type === 'mcq') {
      await card.getByLabel(question.options?.[question.answer as number] as string).check();
      await card.getByRole('button', { name: 'Check answer' }).click();
      await expect(card.getByText('Correct.')).toBeVisible();
    } else {
      await card.getByRole('button', { name: 'Show the solution' }).click();
      await card.getByRole('button', { name: 'I got it' }).click();
    }
  }
  await expect(page.getByText(/You scored 100%/)).toBeVisible();
  await expect(page.getByText('Topic complete')).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuenow', '100');

  await page.reload();
  await expect(page.getByText('Topic complete')).toBeVisible();

  await page.goto('/');
  await expect(page.getByText(/topics complete/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Continue with/ })).toBeVisible();

  await page.goto('/learn/lexical-analysis');
  await expect(page.getByLabel('Complete')).toBeVisible();
});

test('flashcards flip and move', async ({ page }) => {
  await page.goto(LESSON);
  const section = page.locator('section[aria-labelledby="flashcards-heading"]');
  const card = section.getByRole('button', { name: /^Question:/ });
  await card.click();
  await expect(section.getByRole('button', { name: /^Answer:/ })).toBeVisible();
  await section.getByRole('button', { name: 'Next' }).click();
  await expect(section.getByText('2/5')).toBeVisible();
  await expect(section.getByRole('button', { name: /^Question:/ })).toBeVisible();
});

test('the panes resize, and the lesson stays usable at tablet width', async ({ page }) => {
  await page.goto(LESSON);
  const separator = page.getByRole('separator', { name: /Resize/ });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBe(before - 2);

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(heading(page, 'The role of the lexer')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('reduced motion is respected by the visualizers', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/visualize/regex-to-nfa');
  await expect(page.getByLabel('Scrub through the steps')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect(page.getByRole('img').first()).toBeVisible();
});
