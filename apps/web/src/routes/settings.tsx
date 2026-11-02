import type { Settings, Theme, ToolStatus } from '@compilerlab/shared';
import {
  ANIMATION_SPEED_RANGE,
  EDITOR_KEYMAPS,
  FONT_SIZE_RANGE,
} from '@compilerlab/shared/constants';
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ErrorPanel } from '@/components/error-panel';
import { Page, PageHeader } from '@/components/page';
import { LabModeBadge, ToolFix } from '@/components/system-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useDebouncedSettingsSave,
  useResetSettings,
  useSettings,
  useUpdateSettings,
} from '@/hooks/use-settings';
import { useSystemStatus } from '@/hooks/use-system';
import { describeError } from '@/lib/api';

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: <Monitor aria-hidden="true" /> },
  { value: 'light', label: 'Light', icon: <Sun aria-hidden="true" /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden="true" /> },
] as const satisfies readonly { value: Theme; label: string; icon: ReactNode }[];

const KEYMAP_LABELS: Record<Settings['editorKeymap'], string> = {
  default: 'Standard',
  vim: 'Vim',
  emacs: 'Emacs',
};

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${title}-heading`} className="scroll-mt-4">
      <h2 id={`${title}-heading`} className="text-base font-semibold">
        {title}
      </h2>
      {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      <Card className="mt-3 divide-y divide-line">{children}</Card>
    </section>
  );
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid items-center gap-x-6 gap-y-2 p-4 md:grid-cols-[1fr_minmax(0,20rem)]">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        {hint ? <p className="mt-0.5 text-[0.8125rem] text-ink-muted">{hint}</p> : null}
      </div>
      <div className="md:justify-self-end md:text-right">{children}</div>
    </div>
  );
}

function RangeControl({
  id,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        className="h-5 w-full md:w-48"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={display}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="w-12 text-right font-mono text-[0.8125rem] text-ink-muted">
        {display}
      </output>
    </div>
  );
}

/** A text setting that saves when focus leaves it, so each keystroke is not a request. */
function CommitInput({
  id,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  // Follow outside changes, such as Restore defaults, without an effect.
  if (value !== saved) {
    setSaved(value);
    setDraft(value);
  }
  return (
    <Input
      id={id}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="font-mono text-[0.8125rem]"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft.trim());
      }}
    />
  );
}

function ToolRow({
  tool,
  path,
  onCommit,
}: {
  tool: ToolStatus;
  path: string;
  onCommit: (value: string) => void;
}) {
  const id = useId();
  return (
    <Row label={tool.label} htmlFor={id} hint={tool.version ?? 'Not found'}>
      <div className="flex items-center gap-2">
        <Badge tone={tool.state === 'ok' ? 'success' : 'warning'}>
          {tool.state === 'ok' ? 'Found' : 'Missing'}
        </Badge>
        <CommitInput id={id} value={path} placeholder="Use PATH" onCommit={onCommit} />
      </div>
    </Row>
  );
}

function SystemSection({ settings }: { settings: Settings }) {
  const { data: status, error, refetch, isFetching } = useSystemStatus();
  const { mutate } = useUpdateSettings();
  const modelId = useId();

  if (error) {
    return (
      <ErrorPanel
        title="The system status could not be checked"
        message={describeError(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!status) {
    return <Skeleton className="h-64 w-full rounded-lg" />;
  }

  return (
    <div id="system" className="scroll-mt-4 space-y-8">
      <Section
        id="toolchain"
        title="Lab tools"
        description="The lab runs these real tools. Leave a path empty to find the tool on PATH."
      >
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            Lab mode <LabModeBadge mode={status.labMode} />
          </p>
          <Button size="sm" disabled={isFetching} onClick={() => void refetch()}>
            <RotateCcw aria-hidden="true" />
            Check again
          </Button>
        </div>
        {status.tools.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            path={settings.toolPaths[tool.id]}
            onCommit={(value) => mutate({ toolPaths: { [tool.id]: value } })}
          />
        ))}
        {status.toolFix.length > 0 ? (
          <div className="p-4">
            <p className="mb-2 text-sm font-medium">Install the missing tools</p>
            <ToolFix lines={status.toolFix} />
          </div>
        ) : null}
      </Section>

      <Section
        title="AI tutor"
        description="Your Gemini key stays in the .env file on this computer and never reaches this page."
      >
        <Row
          label="Gemini key"
          hint={
            status.gemini.configured
              ? 'Set in .env.'
              : 'Create one at aistudio.google.com/apikey, put it in .env as GEMINI_API_KEY, then restart the app.'
          }
        >
          <Badge tone={status.gemini.configured ? 'success' : 'warning'}>
            {status.gemini.configured ? 'Key set' : 'No key'}
          </Badge>
        </Row>
        <Row label="Gemini model" htmlFor={modelId} hint="Leave empty to use the model from .env.">
          <CommitInput
            id={modelId}
            value={settings.geminiModel}
            placeholder={status.gemini.defaultModel}
            onCommit={(value) => mutate({ geminiModel: value })}
          />
        </Row>
      </Section>

      <Section
        title="Your data"
        description="Everything stays on this computer. To manage it, stop the app and run these commands."
      >
        <Row label="Stored in" hint={`Database driver: ${status.data.dbDriver}`}>
          <code className="font-mono text-[0.8125rem] break-all text-ink-muted">
            {status.data.directory}
          </code>
        </Row>
        <Row label="Back up" hint="Saves a copy in data/backups. Safe to run at any time.">
          <code className="font-mono text-[0.8125rem] text-ink">npm run backup</code>
        </Row>
        <Row label="Start over" hint="Asks first, saves a backup, then deletes your data.">
          <code className="font-mono text-[0.8125rem] text-ink">npm run reset</code>
        </Row>
      </Section>
    </div>
  );
}

export function Component() {
  const { settings, isPending } = useSettings();
  const { mutate, isPending: isSaving } = useUpdateSettings();
  const preview = useDebouncedSettingsSave();
  const reset = useResetSettings();
  const fontId = useId();
  const speedId = useId();
  const keymapId = useId();

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="Settings"
        lead="Changes save automatically."
        actions={
          <div className="flex items-center gap-3">
            <p role="status" className="text-[0.8125rem] text-ink-muted">
              {isSaving ? 'Saving…' : ''}
            </p>
            <Button size="sm" disabled={reset.isPending} onClick={() => reset.mutate()}>
              <RotateCcw aria-hidden="true" />
              Restore defaults
            </Button>
          </div>
        }
      />
      {isPending ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : (
        <div className="space-y-8">
          <Section title="Appearance">
            <Row label="Theme" hint="System follows your computer's light or dark setting.">
              <Segmented
                name="theme"
                legend="Theme"
                value={settings.theme}
                options={THEME_OPTIONS}
                onChange={(theme) => mutate({ theme })}
              />
            </Row>
            <Row label="Font size" htmlFor={fontId} hint="Scales all text in the app.">
              <RangeControl
                id={fontId}
                {...FONT_SIZE_RANGE}
                value={settings.fontSize}
                display={`${settings.fontSize}px`}
                onChange={(fontSize) => preview({ fontSize })}
              />
            </Row>
            <Row
              label="Animation speed"
              htmlFor={speedId}
              hint="Your system's reduced-motion setting always takes priority."
            >
              <RangeControl
                id={speedId}
                {...ANIMATION_SPEED_RANGE}
                value={settings.animationSpeed}
                display={`${settings.animationSpeed}x`}
                onChange={(animationSpeed) => preview({ animationSpeed })}
              />
            </Row>
          </Section>

          <Section title="Editor">
            <Row label="Keymap" htmlFor={keymapId} hint="Used by the code editor in the lab.">
              <NativeSelect
                id={keymapId}
                value={settings.editorKeymap}
                onChange={(event) =>
                  mutate({ editorKeymap: event.target.value as Settings['editorKeymap'] })
                }
              >
                {EDITOR_KEYMAPS.map((keymap) => (
                  <option key={keymap} value={keymap}>
                    {KEYMAP_LABELS[keymap]}
                  </option>
                ))}
              </NativeSelect>
            </Row>
          </Section>

          <SystemSection settings={settings} />
        </div>
      )}
    </Page>
  );
}
