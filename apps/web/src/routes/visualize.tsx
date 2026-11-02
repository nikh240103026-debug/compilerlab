import { Link } from 'react-router';
import { ModuleChip } from '@/components/module-chip';
import { PlannedFeature } from '@/components/planned-feature';
import { Card } from '@/components/ui/card';
import { useModules } from '@/hooks/use-system';

export function Component() {
  const { data: modules = [] } = useModules();
  const withVisualizers = modules.filter((module) => module.visualizers.length > 0);

  return (
    <PlannedFeature
      title="Visualizers"
      lead="Watch each algorithm run one step at a time, on your own regex, grammar or code."
      milestone="Starts in Milestone 2"
      points={[
        'Play, pause, step forward and back, scrub, and change speed',
        'A plain-language explanation of every step',
        'A playground for each visualizer, with clear errors on bad input',
        'Export any step as PNG, SVG or GIF',
      ]}
    >
      <Card className="p-5">
        <h2 className="mb-3 text-base font-semibold">Planned by module</h2>
        <ul className="space-y-2">
          {withVisualizers.map((module) => (
            <li key={module.id}>
              <Link
                to={`/learn/${module.id}`}
                className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-surface-2"
              >
                <ModuleChip number={module.number} />
                <span className="min-w-0 flex-1 truncate">{module.title}</span>
                <span className="font-mono text-xs text-ink-muted">
                  {module.visualizers.length}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </PlannedFeature>
  );
}
