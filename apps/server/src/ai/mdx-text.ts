const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FENCE = /(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m;
// Inline code is matched first and kept, so `<<EOF>>` in a code span is not read as a tag.
const TAG_OR_CODE =
  /`[^`\n]+`|<\/?[A-Z][\w.]*(?:\s+(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^<>"'{}])*)?\/?>|<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/g;

function cleanProse(prose: string): string {
  return prose
    .replace(/^(?:import|export)\s.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(TAG_OR_CODE, (match) => {
      if (match.startsWith('`')) return match;
      // A Callout's title is part of what it says. Other attributes only configure the page.
      const title = /\btitle="([^"]*)"/.exec(match)?.[1];
      return title ? `${title}. ` : '';
    })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Lesson text as plain Markdown: no frontmatter, imports or JSX. Code blocks stay as they are. */
export function stripMdx(source: string): string {
  const body = source.replace(FRONTMATTER, '').replace(/\r\n/g, '\n');
  return body
    .split(FENCE)
    .map((part, index) => (index % 2 === 1 ? part : cleanProse(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface LessonSection {
  heading: string;
  text: string;
}

const MAX_SECTION_CHARS = 1500;

/** Long sections are split at blank lines, so one result never swamps the prompt. */
function splitLong(section: LessonSection): LessonSection[] {
  if (section.text.length <= MAX_SECTION_CHARS) return [section];
  const pieces: LessonSection[] = [];
  let current = '';
  for (const paragraph of section.text.split(/\n\n+/)) {
    if (current && current.length + paragraph.length > MAX_SECTION_CHARS) {
      pieces.push({ heading: section.heading, text: current });
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) pieces.push({ heading: section.heading, text: current });
  return pieces;
}

/** Splits stripped lesson text at its headings. */
export function splitIntoSections(text: string): LessonSection[] {
  const sections: LessonSection[] = [];
  let heading = 'Introduction';
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ heading, text: body });
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const match = inFence ? null : /^#{1,4}\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = (match[1] as string).trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections.flatMap(splitLong);
}
