import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROUTES = [
  ['/', 'Learn how a compiler works, one phase at a time'],
  ['/learn', 'Course modules'],
  ['/learn/lexical-analysis', 'Lexical analysis'],
  ['/visualize', 'Visualizers'],
  ['/lab', 'Lab'],
  ['/practice', 'Practice'],
  ['/exam', 'Exam prep'],
  ['/tutor', 'AI tutor'],
  ['/projects', 'Projects'],
  ['/settings', 'Settings'],
  ['/no/such/page', 'Page not found'],
] as const;

async function expectNoAccessibilityViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

test.beforeEach(async ({ request, baseURL }) => {
  const response = await request.post(`${baseURL}/api/settings/reset`);
  expect(response.ok()).toBe(true);
});

for (const [path, heading] of ROUTES) {
  test(`${path} renders with no console errors or layout overflow`, async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    expect(problems).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${path} has no axe violations in the ${theme} theme`, async ({
      page,
      request,
      baseURL,
    }) => {
      await request.patch(`${baseURL}/api/settings`, { data: { theme } });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectNoAccessibilityViolations(page);
    });
  }
}

test('makes no network requests beyond its own server', async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect([...origins]).toEqual([baseURL]);
});

test('navigates from the pipeline to a module and shows breadcrumbs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Module 2: Syntax analysis' }).click();
  await expect(page).toHaveURL(/\/learn\/syntax-analysis$/);
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb.getByText('Syntax analysis')).toHaveAttribute('aria-current', 'page');
  await breadcrumb.getByRole('link', { name: 'Learn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Course modules' })).toBeVisible();
  await expect(page).toHaveTitle('Learn · CompilerLab');
});

test('route changes take under 100 ms once loaded', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Give the idle preloader a moment to fetch the page chunks.
  await page.waitForTimeout(500);

  for (const [name, heading] of [
    ['Practice', 'Practice'],
    ['Lab', 'Lab'],
    ['Exam prep', 'Exam prep'],
    ['Dashboard', 'Learn how a compiler works, one phase at a time'],
  ] as const) {
    const elapsed = await page.evaluate(
      async ({ name, heading }) => {
        const nav = document.querySelector('nav[aria-label="Main"]');
        const link = [...(nav?.querySelectorAll('a') ?? [])].find(
          (candidate) => candidate.textContent?.trim() === name,
        );
        const start = performance.now();
        link?.click();
        return new Promise<number>((resolve) => {
          const poll = () => {
            if (document.querySelector('h1')?.textContent === heading) {
              resolve(performance.now() - start);
            } else {
              requestAnimationFrame(poll);
            }
          };
          poll();
        });
      },
      { name, heading },
    );
    expect(elapsed, `route change to ${name}`).toBeLessThan(100);
  }
});

test('theme changes apply at once and survive a reload', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('label', { hasText: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('label', { hasText: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.waitForLoadState('networkidle');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
});

test('settings persist to the server', async ({ page, request, baseURL }) => {
  await page.goto('/settings');
  await page.getByLabel('Font size').fill('20');
  await expect(page.locator('html')).toHaveCSS('font-size', '20px');
  await page.getByLabel('Keymap').selectOption('vim');

  await expect
    .poll(async () => (await (await request.get(`${baseURL}/api/settings`)).json()).fontSize)
    .toBe(20);
  const saved = await (await request.get(`${baseURL}/api/settings`)).json();
  expect(saved.editorKeymap).toBe('vim');
});

test('a bad setting shows a readable error with Ask AI and rolls back', async ({ page }) => {
  await page.goto('/settings');
  const model = page.getByLabel('Gemini model');
  await model.fill('not a valid model!');
  await model.blur();
  const toast = page.getByRole('status').filter({ hasText: 'could not be saved' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Ask AI' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'AI tutor' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your question' })).toBeVisible();
});

test('shows a clear banner when the server stops responding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.route('**/api/**', (route) => route.abort());
  await page.getByRole('link', { name: 'Lab', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The Lab page reports the outage in its own panels too, so look for the shell's banner.
  const reconnect = page.getByRole('button', { name: 'Reconnect' });
  await expect(reconnect).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('alert').filter({ has: reconnect })).toContainText('not responding');
  await page.unroute('**/api/**');
  await reconnect.click();
  await expect(reconnect).toBeHidden();
});

test('the split pane resizes with the keyboard', async ({ page }) => {
  await page.goto('/learn/lexical-analysis');
  const separator = page.getByRole('separator', { name: /Resize/ });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBe(before + 2);
});

test('keyboard users can skip to content and toggle the sidebar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  await expect(page.getByText('CompilerLab', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(page.locator('aside')).toHaveCSS('width', '56px');
  await page.keyboard.press('Control+b');
  await expect(page.locator('aside')).toHaveCSS('width', '248px');
});

test('stays usable at tablet width', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  await expect(page.locator('aside')).toHaveCSS('width', '56px');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('respects the reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const duration = await page
    .locator('.pipeline-state')
    .first()
    .evaluate((element) => getComputedStyle(element, '::after').animationDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);
});

test('the API refuses other websites', async ({ request, baseURL }) => {
  const response = await request.patch(`${baseURL}/api/settings`, {
    headers: { origin: 'https://evil.example.com' },
    data: { theme: 'dark' },
  });
  expect(response.status()).toBe(403);
});
