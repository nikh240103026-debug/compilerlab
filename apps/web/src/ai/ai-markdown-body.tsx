import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

// Images are removed because a picture in an answer would be a network call the app must not make.
const DISALLOWED = ['img'];

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

/** Raw HTML in the text is shown as text, because react-markdown never renders it. */
export default function AiMarkdownBody({ text }: { text: string }) {
  return (
    <div className="lesson-prose text-sm break-words">
      <Markdown
        remarkPlugins={PLUGINS}
        disallowedElements={DISALLOWED}
        unwrapDisallowed
        components={COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  );
}
