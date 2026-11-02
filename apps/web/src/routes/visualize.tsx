import { Link } from 'react-router';
import { moduleColor, ModuleChip } from '@/components/module-chip';
import { Page, PageHeader } from '@/components/page';
import { VISUALIZERS } from '@/visualizers/registry';

export function Component() {
  return (
    <Page>
      <PageHeader
        title="Visualizers"
        lead="Watch each algorithm run one step at a time, on your own regex, grammar or code. Every step explains itself, and any step can be exported as an image."
      />
      <ul className="grid gap-3 md:grid-cols-2">
        {VISUALIZERS.map((entry) => (
          <li key={entry.id}>
            <Link
              to={`/visualize/${entry.id}`}
              style={moduleColor(entry.moduleNumber)}
              className="flex h-full flex-col gap-1.5 rounded-lg border border-line bg-surface p-4 transition-colors duration-(--duration-fast) hover:border-line-strong hover:bg-surface-2"
            >
              <span className="flex items-center gap-2">
                <ModuleChip number={entry.moduleNumber} />
                <span className="font-medium">{entry.title}</span>
              </span>
              <span className="text-sm text-ink-muted">{entry.description}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-ink-muted">
        Visualizers for parsing, semantic analysis, code generation and runtime arrive with their
        modules.
      </p>
    </Page>
  );
}
