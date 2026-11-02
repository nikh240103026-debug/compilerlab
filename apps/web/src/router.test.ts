import { describe, expect, it } from 'vitest';
import { pages } from './router';

describe('route modules', () => {
  it.each(Object.entries(pages))('%s exports a page component', async (_name, load) => {
    const page = await load();
    expect(page.Component).toBeTypeOf('function');
  });
});
