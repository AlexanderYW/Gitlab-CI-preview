import { useEffect, useMemo, useRef, useState } from 'react';
import { descend, effectiveType, itemSchema, jobSchema, pickVariant, type JsonSchema } from './schemaUtil.js';
import { groupKeys, SECTIONS } from './sections.js';
import { ReferenceChip, ReferenceBlock } from './ReferenceField.js';
import { isReference } from './referenceUtil.js';
import type { ResolvedReference } from './referenceUtil.js';
import { REFERENCE_MARKER } from '@gitlab-ci-preview/shared';

// Keys whose values are arrays of shell lines — render as multiline textarea.
const SHELL_LINE_KEYS = new Set(['script', 'before_script', 'after_script']);

export interface PipelineCtx {
  stages: string[];
  jobs: { name: string; stage: string; hidden?: boolean }[];
  currentStage: string;
  currentJobName: string;
  /**
   * Look up a `!reference [.job, key, ...]` path. Provided when the panel has
   * access to the full pipeline model; absent in test/preview harnesses.
   */
  resolveReference?: (path: string[]) => ResolvedReference;
}

export function SchemaForm({
  value, onChange, disabled, pipelineCtx,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  pipelineCtx?: PipelineCtx;
}) {
  const schema = useMemo(() => jobSchema(), []);
  const concreteSchema = useMemo(() => pickVariant(schema), [schema]);
  const props = concreteSchema.properties ?? {};
  const presentKeys = Object.keys(value);
  const grouped = useMemo(() => groupKeys(presentKeys), [presentKeys]);

  function setKey(k: string, v: unknown) {
    if (v === undefined) {
      const next = { ...value };
      delete next[k];
      onChange(next);
    } else {
      onChange({ ...value, [k]: v });
    }
  }

  return (
    <div>
      {grouped.sections.map(({ section, keys }) => {
        const allKeys = section.keys; // all schema keys in this section
        const availableToAdd = allKeys.filter((k) => !(k in value) && props[k] != null);
        if (keys.length === 0 && availableToAdd.length === 0) return null;
        return (
          <SectionCard
            key={section.id}
            title={section.title}
            description={section.description}
            addOptions={availableToAdd}
            schemaProps={props}
            onAdd={(k) => setKey(k, defaultFor(descend(schema, k)))}
            disabled={disabled}
          >
            {keys.map((k) => (
              <KeyRow
                key={k}
                name={k}
                value={value[k]}
                schema={descend(schema, k)}
                onChange={(v) => setKey(k, v)}
                onRemove={disabled ? undefined : () => setKey(k, undefined)}
                disabled={disabled}
                pipelineCtx={pipelineCtx}
              />
            ))}
          </SectionCard>
        );
      })}

      {/* Unknown / "Other" keys — preserve them so we don't lose data. */}
      {grouped.other.length > 0 && (
        <SectionCard title="Other" description="Keys not in the standard groups." disabled={disabled}>
          {grouped.other.map((k) => (
            <KeyRow
              key={k}
              name={k}
              value={value[k]}
              schema={descend(schema, k)}
              onChange={(v) => setKey(k, v)}
              onRemove={disabled ? undefined : () => setKey(k, undefined)}
              disabled={disabled}
            />
          ))}
        </SectionCard>
      )}

      {/* Global add-key for anything not already in a section */}
      {!disabled && <GlobalAddKey schemaProps={props} value={value} onAdd={(k) => setKey(k, defaultFor(descend(schema, k)))} />}
    </div>
  );
}

// ---------- Section card ----------

const SECTION_ICONS: Record<string, string> = {
  Identity: '◉',
  Execution: '⌘',
  'Control flow': '◧',
  Dependencies: '◇',
  'Environment & variables': '$',
  'Artifacts & cache': '⇩',
  Resources: '⚙',
  Other: '…',
};

function SectionCard({
  title, description, children, addOptions, schemaProps, onAdd, disabled,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  addOptions?: string[];
  schemaProps?: Record<string, JsonSchema>;
  onAdd?: (key: string) => void;
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const icon = SECTION_ICONS[title] ?? '•';
  return (
    <section style={{
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      marginBottom: 12,
      background: 'var(--vscode-editor-background)',
      overflow: 'hidden',
    }}>
      <header
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'pointer',
          userSelect: 'none',
          background: collapsed ? 'transparent' : 'rgba(255,255,255,0.025)',
          borderBottom: collapsed ? 'none' : '1px solid var(--vscode-panel-border, #2d2d2d)',
        }}
      >
        <span style={{
          width: 22, height: 22, lineHeight: '22px', textAlign: 'center',
          borderRadius: 4, background: 'rgba(255,255,255,0.06)',
          fontSize: 12, fontWeight: 700,
        }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
          {description && !collapsed && (
            <div style={{ fontSize: 10, opacity: 0.55, marginTop: 1 }}>{description}</div>
          )}
        </div>
        <span style={{ opacity: 0.5, fontSize: 11 }}>{collapsed ? '▸' : '▾'}</span>
      </header>
      {!collapsed && (
        <div style={{ padding: '8px 12px 10px' }}>
          {children}
          {!disabled && addOptions && addOptions.length > 0 && onAdd && schemaProps && (
            <InlineAddKey options={addOptions} schemaProps={schemaProps} onAdd={onAdd} />
          )}
        </div>
      )}
    </section>
  );
}

// ---------- Per-key row ----------

function KeyRow({
  name, value, schema, onChange, onRemove, disabled, pipelineCtx,
}: {
  name: string;
  value: unknown;
  schema: JsonSchema;
  onChange: (v: unknown) => void;
  onRemove?: () => void;
  disabled?: boolean;
  pipelineCtx?: PipelineCtx;
}) {
  const concrete = pickVariant(schema);
  const desc = concrete.description;
  const type = effectiveType(concrete);
  const isShellArray = SHELL_LINE_KEYS.has(name);
  const isWholeReference = isReference(value);
  const isNeeds = name === 'needs' && !!pipelineCtx;
  const isDependencies = name === 'dependencies' && !!pipelineCtx;
  const isStage = name === 'stage' && !!pipelineCtx;
  const isExtends = name === 'extends' && !!pipelineCtx;
  const isImage = name === 'image' && (typeof value === 'string' || value === undefined || value === null);
  const isServices = name === 'services';
  const isVariables = name === 'variables' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isRules = name === 'rules' && (value === undefined || value === null || Array.isArray(value));
  const isAllowFailure = name === 'allow_failure';
  const isInterruptible = name === 'interruptible' && (value === undefined || value === null || typeof value === 'boolean');
  const isRetry = name === 'retry' && (value === undefined || value === null || typeof value === 'number' || (typeof value === 'object' && !Array.isArray(value)));
  const isCoverage = name === 'coverage' && (value === undefined || value === null || typeof value === 'string');
  const isIdentity = name === 'identity' && (value === undefined || value === null || typeof value === 'string');
  const isIdTokens = name === 'id_tokens' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isRun = name === 'run' && (value === undefined || value === null || Array.isArray(value));
  const isHooks = name === 'hooks' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isSecrets = name === 'secrets' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isTags = name === 'tags' && (value === undefined || value === null || Array.isArray(value));
  const isTrigger = name === 'trigger' && (value === undefined || value === null || typeof value === 'string' || (typeof value === 'object' && !Array.isArray(value)));
  const isStartIn = name === 'start_in' && (value === undefined || value === null || typeof value === 'string');
  const isParallel = name === 'parallel' && (value === undefined || value === null || typeof value === 'number' || (typeof value === 'object' && !Array.isArray(value)));
  const isArtifacts = name === 'artifacts' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isCache = name === 'cache' && (value === undefined || value === null || typeof value === 'object');
  const isTimeout = name === 'timeout' && (value === undefined || value === null || typeof value === 'string');
  const isEnvironment = name === 'environment' && (value === undefined || value === null || typeof value === 'string' || (typeof value === 'object' && !Array.isArray(value)));
  const isRelease = name === 'release' && (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)));
  const isSimpleScalar = type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || (concrete.enum && concrete.enum.length > 0);
  const isSimpleArrayOfStrings = type === 'array' && (effectiveType(itemSchema(schema)) === 'string') && !isShellArray && !isNeeds && !isDependencies && !isExtends && !isServices;

  return (
    <div
      className="kv-row"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 4px',
        borderRadius: 4,
        position: 'relative',
        borderTop: '1px solid var(--vscode-panel-border, transparent)',
      }}
      onMouseEnter={(e) => { (e.currentTarget.querySelector('.kv-remove') as HTMLElement | null)?.style.setProperty('opacity', '1'); }}
      onMouseLeave={(e) => { (e.currentTarget.querySelector('.kv-remove') as HTMLElement | null)?.style.setProperty('opacity', '0'); }}
    >
      <div style={{ width: 116, flexShrink: 0, paddingTop: 5 }}>
        <div style={{
          fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: 'var(--vscode-foreground)',
        }} title={desc}>{name}<span style={{ opacity: 0.45 }}>:</span></div>
        {desc && isSimpleScalar && (
          <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3, lineHeight: 1.35 }}>{truncate(desc, 70)}</div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {isWholeReference ? (
          <ReferenceBlock
            path={(value as { __gitlabReference: string[] }).__gitlabReference}
            ctx={pipelineCtx}
            disabled={disabled}
            onChange={(p) => onChange({ [REFERENCE_MARKER]: p })}
          />
        ) : isShellArray ? (
          <ShellLinesEditor value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} ctx={pipelineCtx} />
        ) : isNeeds ? (
          <NeedsEditor value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} ctx={pipelineCtx!} />
        ) : isDependencies ? (
          <DependenciesPicker value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} ctx={pipelineCtx!} />
        ) : isStage ? (
          <StagePicker value={(value as string) ?? ''} onChange={onChange} disabled={disabled} ctx={pipelineCtx!} />
        ) : isExtends ? (
          <ExtendsPicker value={value} onChange={onChange} disabled={disabled} ctx={pipelineCtx!} />
        ) : isImage ? (
          <ImageField value={(value as string) ?? ''} onChange={onChange} disabled={disabled} />
        ) : isServices ? (
          <ServicesField value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} />
        ) : isVariables ? (
          <VariablesEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isRules ? (
          <RulesEditor value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} />
        ) : isAllowFailure ? (
          <AllowFailureToggle value={value} onChange={onChange} disabled={disabled} />
        ) : isInterruptible ? (
          <InterruptibleToggle value={value as boolean | undefined} onChange={onChange} disabled={disabled} />
        ) : isRetry ? (
          <RetryEditor value={value} onChange={onChange} disabled={disabled} />
        ) : isCoverage ? (
          <CoverageField value={(value as string) ?? ''} onChange={onChange} disabled={disabled} />
        ) : isIdentity ? (
          <IdentityField value={(value as string) ?? ''} onChange={onChange} disabled={disabled} />
        ) : isIdTokens ? (
          <IdTokensEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isRun ? (
          <RunEditor value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} />
        ) : isHooks ? (
          <HooksEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isSecrets ? (
          <SecretsEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isTags ? (
          <TagsEditor value={(value as unknown[]) ?? []} onChange={onChange} disabled={disabled} ctx={pipelineCtx} />
        ) : isTrigger ? (
          <TriggerEditor value={value} onChange={onChange} disabled={disabled} />
        ) : isStartIn ? (
          <StartInField value={(value as string) ?? ''} onChange={onChange} disabled={disabled} />
        ) : isParallel ? (
          <ParallelEditor value={value} onChange={onChange} disabled={disabled} />
        ) : isArtifacts ? (
          <ArtifactsEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isCache ? (
          <CacheList value={value} onChange={onChange} disabled={disabled} />
        ) : isTimeout ? (
          <TimeoutField value={(value as string) ?? ''} onChange={onChange} disabled={disabled} />
        ) : isEnvironment ? (
          <EnvironmentEditor value={value} onChange={onChange} disabled={disabled} ctx={pipelineCtx} />
        ) : isRelease ? (
          <ReleaseEditor value={(value as Record<string, unknown>) ?? {}} onChange={onChange} disabled={disabled} />
        ) : isSimpleArrayOfStrings ? (
          <SimpleStringList value={(value as string[]) ?? []} onChange={(v) => onChange(v)} disabled={disabled} />
        ) : (
          <ValueField value={value} schema={schema} onChange={onChange} disabled={disabled} depth={0} />
        )}
        {!isSimpleScalar && desc && (
          <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4, lineHeight: 1.35 }}>{desc}</div>
        )}
      </div>
      {onRemove && (
        <button
          className="kv-remove"
          onClick={onRemove}
          title="Remove this key"
          style={{ ...iconBtnStyle, opacity: 0, transition: 'opacity 100ms ease' }}
        >×</button>
      )}
    </div>
  );
}

// ---------- Value fields ----------

function ValueField({
  value, schema, onChange, disabled, depth,
}: {
  value: unknown;
  schema: JsonSchema;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  depth: number;
}) {
  const concrete = pickVariant(schema);
  const t = effectiveType(concrete);

  if (concrete.enum && concrete.enum.length > 0) {
    return (
      <select disabled={disabled} value={value as any ?? ''} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle}>
        <option value="">(unset)</option>
        {concrete.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </select>
    );
  }
  if (t === 'string') {
    const isMultiline = typeof value === 'string' && value.includes('\n');
    if (isMultiline) {
      return <textarea disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={3} style={textareaStyle} />;
    }
    return <input disabled={disabled} type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={inputStyle} />;
  }
  if (t === 'number' || t === 'integer') {
    return <input disabled={disabled} type="number" value={value == null ? '' : Number(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} style={inputStyle} />;
  }
  if (t === 'boolean') {
    return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <input disabled={disabled} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ opacity: 0.7 }}>{value ? 'true' : 'false'}</span>
    </label>;
  }
  if (t === 'array') {
    return <ArrayField value={(value as unknown[]) ?? []} schema={schema} onChange={onChange} disabled={disabled} depth={depth} />;
  }
  if (t === 'object') {
    return <NestedObject value={(value as Record<string, unknown>) ?? {}} schema={schema} onChange={onChange} disabled={disabled} depth={depth} />;
  }
  return <RawJson value={value} onChange={onChange} disabled={disabled} />;
}

// ---------- needs: editor ----------

type NeedItem = { job: string; artifacts?: boolean; optional?: boolean };

function parseNeed(raw: unknown): NeedItem | null {
  if (typeof raw === 'string') return { job: raw };
  if (raw && typeof raw === 'object' && typeof (raw as any).job === 'string') {
    const r = raw as any;
    const out: NeedItem = { job: r.job };
    if (typeof r.artifacts === 'boolean') out.artifacts = r.artifacts;
    if (typeof r.optional === 'boolean') out.optional = r.optional;
    return out;
  }
  return null;
}

function serializeNeed(n: NeedItem, original?: unknown): unknown {
  // Preserve other fields the user may have set on object-form needs (e.g. pipeline, project).
  const extra = (original && typeof original === 'object' && !Array.isArray(original))
    ? Object.fromEntries(Object.entries(original as Record<string, unknown>).filter(([k]) => !['job', 'artifacts', 'optional'].includes(k)))
    : {};
  const hasExtras = Object.keys(extra).length > 0;
  // Use shorthand string form only when no extra config and no overrides are set
  if (!hasExtras && n.artifacts === undefined && n.optional === undefined) return n.job;
  return { job: n.job, ...(n.artifacts !== undefined ? { artifacts: n.artifacts } : {}), ...(n.optional !== undefined ? { optional: n.optional } : {}), ...extra };
}

function NeedsEditor({
  value, onChange, disabled, ctx,
}: { value: unknown[]; onChange: (v: unknown[]) => void; disabled?: boolean; ctx: PipelineCtx }) {
  const items = value.map((v, i) => ({ parsed: parseNeed(v), original: v, idx: i }));
  const referenced = new Set(items.map((i) => i.parsed?.job).filter(Boolean) as string[]);

  // Build a stage list that's guaranteed to include the current stage.
  // (model.stages comes from declared `stages:` and may be missing custom stages.)
  const stageList = (() => {
    const out = ctx.stages.slice();
    for (const j of ctx.jobs) if (!out.includes(j.stage)) out.push(j.stage);
    if (!out.includes(ctx.currentStage)) out.push(ctx.currentStage);
    return out;
  })();
  const currentIdx = stageList.indexOf(ctx.currentStage);

  // Show every non-self, non-template, non-already-added job; mark later-stage jobs as disallowed.
  const candidates = ctx.jobs
    .filter((j) => j.name !== ctx.currentJobName && !referenced.has(j.name) && !j.hidden)
    .map((j) => {
      const jIdx = stageList.indexOf(j.stage);
      const tooLate = jIdx > currentIdx;
      return { ...j, jIdx, tooLate };
    });

  const byStage = new Map<string, typeof candidates>();
  for (const j of candidates) {
    if (!byStage.has(j.stage)) byStage.set(j.stage, []);
    byStage.get(j.stage)!.push(j);
  }
  // Display stages in pipeline order; only render stages that have candidates.
  const orderedStages = stageList.filter((s) => byStage.has(s));

  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  function add(jobName: string) {
    onChange([...value, jobName]);
    setPickerOpen(false);
    setFilter('');
  }
  function removeAt(idx: number) {
    const next = value.slice();
    next.splice(idx, 1);
    onChange(next);
  }
  function updateAt(idx: number, patch: Partial<NeedItem>) {
    const cur = items[idx];
    if (!cur.parsed) return;
    const merged: NeedItem = { ...cur.parsed, ...patch };
    // If patch sets undefined explicitly, drop the field
    if (patch.artifacts === undefined && 'artifacts' in patch) delete merged.artifacts;
    if (patch.optional === undefined && 'optional' in patch) delete merged.optional;
    const next = value.slice();
    next[idx] = serializeNeed(merged, cur.original);
    onChange(next);
  }

  const filtered = filter
    ? candidates.filter((j) => j.name.toLowerCase().includes(filter.toLowerCase()))
    : candidates;
  const filteredByStage = new Map<string, typeof candidates>();
  for (const j of filtered) {
    if (!filteredByStage.has(j.stage)) filteredByStage.set(j.stage, []);
    filteredByStage.get(j.stage)!.push(j);
  }
  const filteredStages = orderedStages.filter((s) => filteredByStage.has(s));
  const hasAnyPickable = candidates.some((j) => !j.tooLate);

  return (
    <div style={{
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      background: 'var(--vscode-editor-background)',
      overflow: 'visible',
    }}>
      {/* Chips list */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, minHeight: 32 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '4px 2px' }}>
            No upstream jobs — this job starts as soon as its stage begins.
          </span>
        )}
        {items.map((it, i) => {
          if (!it.parsed) {
            // Unparseable raw item — show as fallback chip
            return (
              <span key={i} style={chipFallback}>
                <span>{JSON.stringify(it.original)}</span>
                {!disabled && <ChipX onClick={() => removeAt(i)} />}
              </span>
            );
          }
          const n = it.parsed;
          const stageOfJob = ctx.jobs.find((j) => j.name === n.job)?.stage;
          const missing = !stageOfJob;
          const color = missing ? '#dd2b0e' : '#1f75cb';
          return (
            <span key={i} style={needChipStyle(color, missing)} title={missing ? 'Job not found in current pipeline' : `stage: ${stageOfJob}`}>
              {missing && <span aria-hidden style={{ marginRight: 2 }}>⚠</span>}
              <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>{n.job}</span>
              {n.optional && <MiniBadge label="optional" />}
              {n.artifacts === false && <MiniBadge label="no artifacts" />}
              {!disabled && (
                <>
                  <ChipMenu
                    artifacts={n.artifacts}
                    optional={n.optional}
                    onToggleArtifacts={() => updateAt(i, { artifacts: n.artifacts === false ? undefined : false })}
                    onToggleOptional={() => updateAt(i, { optional: n.optional ? undefined : true })}
                  />
                  <ChipX onClick={() => removeAt(i)} />
                </>
              )}
            </span>
          );
        })}
      </div>

      {/* Add control */}
      {!disabled && (
        <div ref={pickerRef} style={{ position: 'relative', borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)' }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            disabled={!hasAnyPickable}
            style={{
              width: '100%',
              padding: '7px 10px',
              background: pickerOpen ? 'rgba(31,117,203,0.10)' : 'transparent',
              color: !hasAnyPickable ? 'var(--vscode-descriptionForeground)' : '#1f75cb',
              border: 'none',
              cursor: !hasAnyPickable ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--vscode-font-family)',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <NeedsPlusIcon /> {!hasAnyPickable ? 'No upstream jobs available' : 'Add upstream job…'}
          </button>

          {pickerOpen && candidates.length > 0 && (
            <div style={{
              position: 'absolute',
              left: 6,
              right: 6,
              bottom: 'calc(100% + 4px)',
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-panel-border, #444)',
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              zIndex: 30,
              maxHeight: 320,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              <div style={{ padding: 6, borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
                <input
                  autoFocus
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter jobs…"
                  style={{
                    width: '100%',
                    padding: '5px 8px',
                    fontSize: 12,
                    background: 'var(--vscode-input-background)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, transparent)',
                    borderRadius: 3,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ overflowY: 'auto', padding: '4px 0' }}>
                {filteredStages.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 11, opacity: 0.6 }}>No matching jobs.</div>
                )}
                {filteredStages.map((stage) => {
                  const isCurrent = stage === ctx.currentStage;
                  const stageJobs = filteredByStage.get(stage)!;
                  const stageTooLate = stageJobs[0]?.tooLate;
                  return (
                    <div key={stage}>
                      <div style={{
                        padding: '5px 12px 3px',
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: 0.6,
                        textTransform: 'uppercase',
                        color: isCurrent ? '#c17d10' : 'var(--vscode-descriptionForeground)',
                        opacity: stageTooLate ? 0.5 : 0.75,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}>
                        <span>{stage}</span>
                        {isCurrent && <StageTag color="#c17d10" label="same stage" />}
                        {stageTooLate && <StageTag color="#888" label="later — not allowed" />}
                      </div>
                      {stageJobs.map((j) => (
                        <button
                          key={j.name}
                          onClick={() => !j.tooLate && add(j.name)}
                          disabled={j.tooLate}
                          title={j.tooLate ? 'Cannot reference a job in a later stage' : ''}
                          style={{
                            ...pickItemStyle,
                            opacity: j.tooLate ? 0.4 : 1,
                            cursor: j.tooLate ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                          onMouseEnter={(e) => { if (!j.tooLate) (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'; }}
                          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                        >
                          <code style={{ fontWeight: 600 }}>{j.name}</code>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div style={{
                padding: '6px 10px',
                borderTop: '1px solid var(--vscode-panel-border, #444)',
                fontSize: 10, opacity: 0.65,
                background: 'var(--vscode-editorWidget-background, #252526)',
                lineHeight: 1.4,
              }}>
                <code>needs:</code> can only reference jobs in the same or earlier stages. Later-stage jobs are shown disabled.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChipX({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Remove"
      style={{
        background: 'transparent', border: 'none', color: 'inherit',
        cursor: 'pointer', padding: 0, marginLeft: 2,
        width: 14, height: 14, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        borderRadius: 3, opacity: 0.7,
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '0.7')}
    >
      <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden>
        <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      </svg>
    </button>
  );
}

function ChipMenu({
  artifacts, optional, onToggleArtifacts, onToggleOptional,
}: { artifacts?: boolean; optional?: boolean; onToggleArtifacts: () => void; onToggleOptional: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Edit need options"
        style={{
          background: 'transparent', border: 'none', color: 'inherit',
          cursor: 'pointer', padding: 0, marginLeft: 2,
          width: 14, height: 14, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', borderRadius: 3, opacity: 0.7,
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '0.7')}
      >
        <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
          <circle cx={2} cy={5} r={1} fill="currentColor" />
          <circle cx={5} cy={5} r={1} fill="currentColor" />
          <circle cx={8} cy={5} r={1} fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          background: 'var(--vscode-editorWidget-background, #252526)',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          zIndex: 40,
          padding: 4,
          minWidth: 180,
          fontFamily: 'var(--vscode-font-family)',
        }}>
          <MenuToggle checked={optional === true} onClick={onToggleOptional} label="Optional" hint="Don't fail if the job is missing" />
          <MenuToggle checked={artifacts === false} onClick={onToggleArtifacts} label="Skip artifacts" hint="Don't download artifacts from this job" />
        </div>
      )}
    </span>
  );
}

function MenuToggle({ checked, onClick, label, hint }: { checked: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'flex', width: '100%', alignItems: 'flex-start', gap: 8,
        padding: '6px 8px', background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'var(--vscode-foreground)', borderRadius: 3, textAlign: 'left',
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
    >
      <span style={{
        width: 14, height: 14, flex: '0 0 auto', marginTop: 1,
        borderRadius: 3, border: `1px solid ${checked ? '#1f75cb' : 'var(--vscode-checkbox-border, #666)'}`,
        background: checked ? '#1f75cb' : 'transparent',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {checked && <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 1 }}>{hint}</div>
      </span>
    </button>
  );
}

function MiniBadge({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '0 5px', marginLeft: 2,
      borderRadius: 6, background: 'rgba(255,255,255,0.10)',
      textTransform: 'uppercase', letterSpacing: 0.4, lineHeight: '14px',
    }}>{label}</span>
  );
}

function StageTag({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      fontSize: 8, padding: '0 5px', borderRadius: 6,
      background: `${color}2e`,
      border: `1px solid ${color}66`,
      color,
      textTransform: 'uppercase', letterSpacing: 0.4,
      lineHeight: '13px',
    }}>{label}</span>
  );
}

function NeedsPlusIcon() {
  return <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden><path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>;
}

function needChipStyle(color: string, missing: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '3px 4px 3px 8px',
    fontSize: 11,
    color,
    background: missing ? 'rgba(221,43,14,0.10)' : 'rgba(31,117,203,0.10)',
    border: `1px solid ${color}55`,
    borderRadius: 10,
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  };
}

const chipFallback: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: '3px 4px 3px 8px',
  fontSize: 10,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  color: 'var(--vscode-descriptionForeground)',
  background: 'rgba(255,255,255,0.04)',
  border: '1px dashed var(--vscode-panel-border, #444)',
  borderRadius: 10,
};

const pickItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '5px 14px',
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 12,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

// ---------- timeout field ----------

const TIMEOUT_PRESETS: { label: string; value: string; seconds: number }[] = [
  { label: '10 min', value: '10 minutes', seconds: 600 },
  { label: '30 min', value: '30 minutes', seconds: 1800 },
  { label: '1 hour', value: '1 hour', seconds: 3600 },
  { label: '2 hours', value: '2 hours', seconds: 7200 },
  { label: '4 hours', value: '4 hours', seconds: 14400 },
];

// Tolerant parser for GitLab-style duration strings ("1h 30m 12s", "30 minutes", "2hrs 20min").
function parseDuration(raw: string): { seconds: number; pretty: string } | null {
  if (!raw.trim()) return null;
  const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  const parts: { n: number; unit: string }[] = [];
  while ((m = re.exec(raw))) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    let factor = 1;
    if (u.startsWith('w')) factor = 604800;
    else if (u.startsWith('d')) factor = 86400;
    else if (u.startsWith('h')) factor = 3600;
    else if (u.startsWith('m') && !u.startsWith('mo')) factor = 60;
    else if (u.startsWith('s')) factor = 1;
    total += n * factor;
    parts.push({ n, unit: u });
  }
  if (!matched) {
    // Try bare number = seconds
    const bare = parseFloat(raw);
    if (Number.isFinite(bare)) return { seconds: bare, pretty: formatSeconds(bare) };
    return null;
  }
  return { seconds: total, pretty: formatSeconds(total) };
}

function formatSeconds(s: number): string {
  if (s <= 0) return '0s';
  const units: [number, string][] = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
  const out: string[] = [];
  let rem = Math.round(s);
  for (const [size, label] of units) {
    const n = Math.floor(rem / size);
    if (n > 0) { out.push(`${n}${label}`); rem -= n * size; }
    if (out.length >= 2) break;
  }
  return out.join(' ') || '0s';
}

function TimeoutField({
  value, onChange, disabled,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const parsed = value ? parseDuration(value) : null;
  const parseFailed = !!value && !parsed;

  function commit(v: string) {
    onChange(v ? v : undefined);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${parseFailed ? 'rgba(221,43,14,0.5)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={{
          padding: '0 8px', height: 26,
          display: 'inline-flex', alignItems: 'center',
          background: parseFailed ? 'rgba(221,43,14,0.10)' : 'rgba(110,73,203,0.10)',
          color: parseFailed ? '#dd2b0e' : '#6e49cb',
          borderRight: `1px solid ${parseFailed ? 'rgba(221,43,14,0.30)' : 'var(--vscode-panel-border, #444)'}`,
          flex: '0 0 auto',
        }}>
          <ClockIcon />
        </span>
        <input
          disabled={disabled}
          type="text"
          value={value}
          onChange={(e) => commit(e.target.value)}
          placeholder="1h 30m"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 8px',
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
          }}
        />
        {parsed && (
          <span style={{
            padding: '0 8px', height: 26,
            display: 'inline-flex', alignItems: 'center',
            fontSize: 10, fontWeight: 600,
            color: '#108548',
            background: 'rgba(16,133,72,0.08)',
            borderLeft: '1px solid var(--vscode-panel-border, #444)',
          }}>≈ {parsed.pretty}</span>
        )}
      </div>

      {parseFailed && (
        <div style={{ fontSize: 10, color: '#dd2b0e', lineHeight: 1.4 }}>
          Can't parse duration. Try formats like <code style={inlineKbdStyle}>30 minutes</code> or <code style={inlineKbdStyle}>1h 30m</code>.
        </div>
      )}

      {!disabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {TIMEOUT_PRESETS.map((p) => {
            const active = parsed?.seconds === p.seconds;
            return (
              <button
                key={p.value}
                onClick={() => commit(p.value)}
                style={{
                  padding: '2px 8px',
                  fontSize: 10, fontWeight: 600,
                  background: active ? 'rgba(110,73,203,0.18)' : 'transparent',
                  color: active ? '#6e49cb' : 'var(--vscode-descriptionForeground)',
                  border: `1px solid ${active ? 'rgba(110,73,203,0.50)' : 'var(--vscode-panel-border, #444)'}`,
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontFamily: 'var(--vscode-font-family)',
                }}
                title={`Set to ${p.value}`}
              >{p.label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={8} r={6.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M8 4 V8 L11 10" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

const inlineKbdStyle: React.CSSProperties = {
  padding: '0 4px',
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  fontSize: 10,
};

// ---------- environment editor ----------

const ENV_ACTION: { value: string; color: string; hint: string }[] = [
  { value: 'start', color: '#108548', hint: 'Starts/updates the deployment (default)' },
  { value: 'prepare', color: '#1f75cb', hint: 'Reserve the environment without deploying' },
  { value: 'verify', color: '#1f75cb', hint: 'Verify the deployment is healthy' },
  { value: 'access', color: '#1f75cb', hint: 'Grant access without deploying' },
  { value: 'stop', color: '#dd2b0e', hint: 'Tear down the environment' },
];

const TIER_PRESETS = ['production', 'staging', 'testing', 'development', 'other'];
const TIER_COLOR: Record<string, string> = {
  production: '#dd2b0e',
  staging: '#c17d10',
  testing: '#1f75cb',
  development: '#6e49cb',
  other: '#888',
};

function EnvironmentEditor({
  value, onChange, disabled, ctx,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; ctx?: PipelineCtx }) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const obj = isObject ? (value as Record<string, unknown>) : {};
  const nameStr = typeof value === 'string' ? value : typeof obj.name === 'string' ? obj.name : '';
  const url = typeof obj.url === 'string' ? obj.url : '';
  const action = typeof obj.action === 'string' ? obj.action : 'start';
  const tier = typeof obj.deployment_tier === 'string' ? obj.deployment_tier : '';
  const onStop = typeof obj.on_stop === 'string' ? obj.on_stop : '';
  const autoStop = typeof obj.auto_stop_in === 'string' ? obj.auto_stop_in : '';

  const hasObjectOnlyFields = !!(url || (action && action !== 'start') || tier || onStop || autoStop || obj.kubernetes);
  const [advanced, setAdvanced] = useState(isObject && hasObjectOnlyFields);

  function commit(next: { name: string; url?: string; action?: string; deployment_tier?: string; on_stop?: string; auto_stop_in?: string }) {
    if (!next.name) { onChange(undefined); return; }
    const onlyName = !next.url && (!next.action || next.action === 'start') && !next.deployment_tier && !next.on_stop && !next.auto_stop_in && !obj.kubernetes;
    if (!advanced && onlyName) {
      onChange(next.name);
      return;
    }
    const merged: Record<string, unknown> = { ...obj, name: next.name };
    if (next.url) merged.url = next.url; else delete merged.url;
    if (next.action && next.action !== 'start') merged.action = next.action; else delete merged.action;
    if (next.deployment_tier) merged.deployment_tier = next.deployment_tier; else delete merged.deployment_tier;
    if (next.on_stop) merged.on_stop = next.on_stop; else delete merged.on_stop;
    if (next.auto_stop_in) merged.auto_stop_in = next.auto_stop_in; else delete merged.auto_stop_in;
    onChange(merged);
  }

  function patchField(patch: Partial<{ name: string; url: string; action: string; deployment_tier: string; on_stop: string; auto_stop_in: string }>) {
    commit({
      name: nameStr, url, action, deployment_tier: tier, on_stop: onStop, auto_stop_in: autoStop,
      ...patch,
    });
  }

  const tierColor = tier ? (TIER_COLOR[tier] ?? '#888') : '#888';
  // For on_stop picker, show hidden/visible jobs except self.
  const stopJobCandidates = ctx
    ? ctx.jobs.filter((j) => j.name !== ctx.currentJobName).map((j) => j.name)
    : [];

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<EnvIcon />} title="Environment" color={tier ? tierColor : '#108548'} />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Name */}
        <CardField label="Name" hint="Shown under /environments in GitLab">
          <div style={{ display: 'flex', alignItems: 'center', gap: 0,
            border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
            borderRadius: 4,
            background: 'var(--vscode-input-background)',
            overflow: 'hidden',
          }}>
            <span aria-hidden style={{
              padding: '0 8px', height: 26,
              display: 'inline-flex', alignItems: 'center',
              background: `${tier ? tierColor : '#108548'}1f`,
              color: tier ? tierColor : '#108548',
              borderRight: '1px solid var(--vscode-panel-border, #444)',
              flex: '0 0 auto',
            }}>
              <EnvIcon />
            </span>
            <input
              disabled={disabled}
              type="text"
              value={nameStr}
              onChange={(e) => patchField({ name: e.target.value })}
              placeholder="production"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0,
                padding: '4px 8px',
                background: 'transparent',
                color: 'var(--vscode-input-foreground)',
                border: 'none', outline: 'none',
                fontSize: 12,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </CardField>

        {/* Tier presets */}
        <div>
          <label style={varSubLabelStyle}>Deployment tier</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
            {TIER_PRESETS.map((t) => {
              const active = tier === t;
              const c = TIER_COLOR[t];
              return (
                <button
                  key={t}
                  onClick={() => patchField({ deployment_tier: active ? '' : t })}
                  disabled={disabled}
                  style={{
                    padding: '2px 8px',
                    fontSize: 10, fontWeight: 600,
                    background: active ? `${c}24` : 'transparent',
                    color: active ? c : 'var(--vscode-descriptionForeground)',
                    border: `1px solid ${active ? `${c}66` : 'var(--vscode-panel-border, #444)'}`,
                    borderRadius: 10,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--vscode-font-family)',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                  title={`Set deployment_tier: ${t}`}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} aria-hidden />
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        <Disclosure
          open={advanced}
          onToggle={() => setAdvanced((v) => !v)}
          label="Advanced"
          countBadge={[url, action !== 'start' ? action : '', onStop, autoStop, obj.kubernetes ? 'k8s' : ''].filter(Boolean).length}
        >
          {advanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* URL */}
              <CardField label="URL" hint="Opens from the environment page in GitLab">
                <div style={{
                  display: 'flex', alignItems: 'center',
                  border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
                  borderRadius: 4,
                  background: 'var(--vscode-input-background)',
                  overflow: 'hidden',
                }}>
                  <span aria-hidden style={{
                    padding: '0 8px', height: 24,
                    display: 'inline-flex', alignItems: 'center',
                    background: 'rgba(31,117,203,0.10)', color: '#1f75cb',
                    borderRight: '1px solid var(--vscode-panel-border, #444)',
                    flex: '0 0 auto',
                  }}>
                    <LinkIcon />
                  </span>
                  <input
                    disabled={disabled}
                    type="text"
                    value={url}
                    onChange={(e) => patchField({ url: e.target.value })}
                    placeholder="https://$CI_ENVIRONMENT_SLUG.example.com"
                    spellCheck={false}
                    style={{
                      flex: 1, minWidth: 0,
                      padding: '3px 8px',
                      background: 'transparent',
                      color: 'var(--vscode-input-foreground)',
                      border: 'none', outline: 'none',
                      fontSize: 12,
                      fontFamily: 'var(--vscode-editor-font-family, monospace)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </CardField>

              {/* Action */}
              <CardField label="Action" hint={ENV_ACTION.find((a) => a.value === action)?.hint ?? ''}>
                <EnumPill
                  value={action}
                  options={ENV_ACTION}
                  onChange={(v) => patchField({ action: v })}
                  disabled={disabled}
                />
              </CardField>

              {/* On stop */}
              <CardField label="On stop" hint="Job to run when the environment is stopped">
                {ctx ? (
                  <JobPickerInput
                    value={onStop}
                    onChange={(v) => patchField({ on_stop: v })}
                    candidates={stopJobCandidates}
                    placeholder=".stop_production"
                    disabled={disabled}
                  />
                ) : (
                  <input
                    disabled={disabled}
                    type="text"
                    value={onStop}
                    onChange={(e) => patchField({ on_stop: e.target.value })}
                    placeholder=".stop_production"
                    style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                  />
                )}
              </CardField>

              {/* Auto stop in */}
              <CardField label="Auto-stop after" hint="Stop the environment after this duration">
                <TimeoutField value={autoStop} onChange={(v) => patchField({ auto_stop_in: (v as string) ?? '' })} disabled={disabled} />
              </CardField>
            </div>
          )}
        </Disclosure>
      </div>
    </div>
  );
}

function JobPickerInput({
  value, onChange, candidates, placeholder, disabled,
}: { value: string; onChange: (v: string) => void; candidates: string[]; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const filter = value.toLowerCase();
  const filtered = filter ? candidates.filter((c) => c.toLowerCase().includes(filter)) : candidates;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        disabled={disabled}
        type="text"
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        placeholder={placeholder}
        spellCheck={false}
        style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
      />
      {open && filtered.length > 0 && (
        <div style={popoverStyle}>
          {filtered.slice(0, 50).map((c) => (
            <button
              key={c}
              onClick={() => { onChange(c); setOpen(false); }}
              style={pickItemStyle}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
            >
              <code style={{ fontWeight: 600 }}>{c}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EnvIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={8} r={6.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M1.5 8 H14.5 M8 1.5 a9 9 0 0 1 0 13 M8 1.5 a9 9 0 0 0 0 13" fill="none" stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}
function LinkIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M6 10 a3 3 0 0 1 0 -4 L8 4 a3 3 0 0 1 4 4 L11 9 M10 6 a3 3 0 0 1 0 4 L8 12 a3 3 0 0 1 -4 -4 L5 7" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- release editor helpers ----------

const TAG_NAME_PRESETS: { label: string; value: string; hint: string }[] = [
  { label: '$CI_COMMIT_TAG', value: '$CI_COMMIT_TAG', hint: 'Use the git tag that triggered the pipeline' },
  { label: 'v$CI_COMMIT_TAG', value: 'v$CI_COMMIT_TAG', hint: 'Prepend "v" to the triggering tag' },
  { label: 'release-$SHA', value: 'release-$CI_COMMIT_SHORT_SHA', hint: 'Auto-create a tag from the commit SHA' },
  { label: 'build-$ID', value: 'build-$CI_PIPELINE_IID', hint: 'Sequential pipeline build number' },
];

// ISO datetime helpers — GitLab requires `YYYY-MM-DDTHH:MM:SSZ` (with timezone).
function toLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Format as YYYY-MM-DDTHH:MM in the LOCAL timezone (what <input type="datetime-local"> expects)
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  // Convert local time to UTC ISO 8601 with seconds and Z suffix
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function nowIso(): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function ReleasedAtField({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const parsed = value ? new Date(value) : null;
  const valid = !value || (parsed && !Number.isNaN(parsed.getTime()));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'stretch',
        border: `1px solid ${!valid ? 'rgba(221,43,14,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={{
          padding: '0 8px',
          display: 'inline-flex', alignItems: 'center',
          background: 'rgba(252,109,38,0.10)', color: '#fc6d26',
          borderRight: '1px solid var(--vscode-panel-border, #444)',
          flex: '0 0 auto',
        }}>
          <CalendarIcon />
        </span>
        <input
          disabled={disabled}
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(e) => onChange(fromLocalInput(e.target.value))}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 8px', height: 26,
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
            colorScheme: 'dark',
          }}
        />
        {!disabled && (
          <>
            <button
              onClick={() => onChange(nowIso())}
              title="Set to current time (UTC)"
              style={dateActionBtnStyle}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.18)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.08)')}
            >Now</button>
            {value && (
              <button
                onClick={() => onChange('')}
                title="Clear"
                style={{ ...dateActionBtnStyle, color: '#dd2b0e' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(221,43,14,0.12)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
              >×</button>
            )}
          </>
        )}
      </div>
      {value && valid && (
        <div style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.4 }}>
          Saved as <code style={inlineKbdStyle}>{value}</code>
        </div>
      )}
      {value && !valid && (
        <div style={{ fontSize: 10, color: '#dd2b0e' }}>Can't parse as a date.</div>
      )}
    </div>
  );
}

const dateActionBtnStyle: React.CSSProperties = {
  padding: '0 10px',
  background: 'rgba(252,109,38,0.08)',
  color: '#fc6d26',
  border: 'none',
  borderLeft: '1px solid var(--vscode-panel-border, #444)',
  cursor: 'pointer',
  fontSize: 11, fontWeight: 600,
  fontFamily: 'var(--vscode-font-family)',
  transition: 'background 80ms ease',
};

function CalendarIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <rect x={2} y={3} width={12} height={11} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M2 6.5 H14 M5 2 V4 M11 2 V4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  );
}

// Description field with edit / preview tabs and a character/line counter.
function DescriptionField({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const lines = value ? value.split('\n').length : 0;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ ...varSubLabelStyle, marginBottom: 0 }}>Description *</span>
        <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— shown on the release page (Markdown)</span>
        <span style={{ flex: 1 }} />
        {!disabled && value && (
          <div style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, overflow: 'hidden' }}>
            <ModeBtn active={mode === 'edit'} onClick={() => setMode('edit')}>edit</ModeBtn>
            <ModeBtn active={mode === 'preview'} onClick={() => setMode('preview')}>preview</ModeBtn>
          </div>
        )}
      </div>
      {mode === 'edit' ? (
        <textarea
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="## What's new&#10;- ..."
          spellCheck={false}
          rows={Math.max(3, Math.min(10, lines + 1))}
          style={{
            width: '100%',
            padding: '6px 8px',
            border: `1px solid ${!value ? 'rgba(193,125,16,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
            borderRadius: 4,
            background: 'var(--vscode-input-background)',
            color: 'var(--vscode-input-foreground)',
            outline: 'none', resize: 'vertical',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: 12, lineHeight: 1.5,
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <div style={{
          padding: '8px 10px',
          minHeight: 80,
          border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
          borderRadius: 4,
          background: 'var(--vscode-editor-background)',
          fontSize: 12, lineHeight: 1.5,
        }}>
          <MarkdownPreview source={value} />
        </div>
      )}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        marginTop: 3,
        fontSize: 9, opacity: 0.55,
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
      }}>
        <span>{value.length === 0 ? 'Supports #, **, *, `, -, [link](url)' : `${lines} line${lines === 1 ? '' : 's'}`}</span>
        <span>{value.length} char{value.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

// Minimal Markdown renderer for changelog preview — headings, bold, italic, inline code,
// links, and bullet lines. Deliberately not a full parser; just the most common 90% bits.
function MarkdownPreview({ source }: { source: string }) {
  if (!source) {
    return <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: 11 }}>(empty preview)</div>;
  }
  const lines = source.split('\n');
  const blocks: React.ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      blocks.push(
        <ul key={`l${blocks.length}`} style={{ margin: '4px 0 4px 18px', padding: 0 }}>
          {listBuf.map((item, i) => <li key={i} style={{ marginBottom: 2 }}>{renderInline(item)}</li>)}
        </ul>
      );
      listBuf = [];
    }
  };
  lines.forEach((raw, i) => {
    const line = raw;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      const text = h[2];
      const sizes = [16, 14, 13, 12];
      const margins = [10, 8, 6, 4];
      blocks.push(
        <div key={i} style={{ fontWeight: 700, fontSize: sizes[level - 1], marginTop: margins[level - 1], marginBottom: 2 }}>
          {renderInline(text)}
        </div>
      );
      return;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      listBuf.push(li[1]);
      return;
    }
    flushList();
    if (line.trim() === '') {
      blocks.push(<div key={i} style={{ height: 6 }} />);
    } else {
      blocks.push(<div key={i} style={{ marginBottom: 2 }}>{renderInline(line)}</div>);
    }
  });
  flushList();
  return <>{blocks}</>;
}

function renderInline(text: string): React.ReactNode {
  // Split on a small set of inline patterns: **bold**, *italic*, `code`, [text](url).
  const out: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/;
  while (rest.length) {
    const m = pattern.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1]) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={key++}>{m[4]}</em>);
    else if (m[5]) out.push(<code key={key++} style={inlineKbdStyle}>{m[6]}</code>);
    else if (m[7]) out.push(
      <span key={key++} style={{ color: '#1f75cb', textDecoration: 'underline' }} title={m[9]}>{m[8]}</span>
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return <>{out}</>;
}

// ---------- release editor ----------

type AssetLink = { name?: string; url?: string; filepath?: string; link_type?: string; [k: string]: unknown };

const LINK_TYPE: { value: string; color: string; icon: React.ReactNode }[] = [
  { value: 'package', color: '#fc6d26', icon: <PackageGlyph /> },
  { value: 'image', color: '#1f75cb', icon: <ImageGlyph /> },
  { value: 'runbook', color: '#108548', icon: <BookGlyph /> },
  { value: 'other', color: '#888', icon: <DotGlyph /> },
];

function PackageGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M6 1 L11 3.5 V8.5 L6 11 L1 8.5 V3.5 Z M1 3.5 L6 6 L11 3.5 M6 6 V11" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" /></svg>; }
function ImageGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><rect x={1} y={2} width={10} height={8} rx={1} fill="none" stroke="currentColor" strokeWidth={1.2} /><circle cx={4} cy={5} r={1} fill="currentColor" /><path d="M1 8 L4 6 L7 8 L9 7 L11 9" fill="none" stroke="currentColor" strokeWidth={1.2} /></svg>; }
function BookGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 V10 H6 V2 H2 Z M6 2 V10 H10 V2 H6 Z" fill="none" stroke="currentColor" strokeWidth={1.2} /></svg>; }
function DotGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><circle cx={6} cy={6} r={2} fill="currentColor" /></svg>; }

function ReleaseEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...value, ...p };
    for (const k of deleteKeys) delete next[k];
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }

  const tagName = typeof value.tag_name === 'string' ? value.tag_name : '';
  const tagMessage = typeof value.tag_message === 'string' ? value.tag_message : '';
  const description = typeof value.description === 'string' ? value.description : '';
  const releaseName = typeof value.name === 'string' ? value.name : '';
  const ref = typeof value.ref === 'string' ? value.ref : '';
  const milestones = stringArrayFrom(value.milestones);
  const releasedAt = typeof value.released_at === 'string' ? value.released_at : '';
  const assets = (value.assets && typeof value.assets === 'object' && !Array.isArray(value.assets))
    ? value.assets as Record<string, unknown>
    : null;
  const links: AssetLink[] = Array.isArray(assets?.links)
    ? (assets!.links as unknown[]).map((l): AssetLink => (l && typeof l === 'object' && !Array.isArray(l)) ? l as AssetLink : {})
    : [];

  const missingRequired: string[] = [];
  if (!tagName) missingRequired.push('tag_name');
  if (!description) missingRequired.push('description');

  const [advancedOpen, setAdvancedOpen] = useState(!!(tagMessage || releaseName || ref || releasedAt || milestones.length));
  const [assetsOpen, setAssetsOpen] = useState(links.length > 0);

  function patchAssetsLinks(next: AssetLink[]) {
    if (next.length === 0) {
      patch({}, ['assets']);
      return;
    }
    const baseExtras = assets
      ? Object.fromEntries(Object.entries(assets).filter(([k]) => k !== 'links'))
      : {};
    patch({ assets: { ...baseExtras, links: next } });
  }
  function updateLink(i: number, p: Partial<AssetLink>, dels: (keyof AssetLink)[] = []) {
    const next = links.slice();
    const merged = { ...next[i], ...p };
    for (const k of dels) delete merged[k as string];
    next[i] = merged;
    patchAssetsLinks(next);
  }
  function removeLink(i: number) {
    const next = links.slice();
    next.splice(i, 1);
    patchAssetsLinks(next);
  }
  function addLink() {
    patchAssetsLinks([...links, { name: '', url: '' }]);
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<TagOutlineIcon />} title="Release" color="#fc6d26" />

      {/* Missing-required warning banner */}
      {missingRequired.length > 0 && (
        <div style={{
          padding: '7px 12px',
          fontSize: 11,
          background: 'rgba(193,125,16,0.08)',
          borderBottom: '1px solid rgba(193,125,16,0.30)',
          color: '#c17d10',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <WarnIcon /> <span><strong>Required:</strong> {missingRequired.map((k) => <code key={k} style={inlineKbdStyle}>{k}</code>).reduce((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [] as React.ReactNode[])}</span>
        </div>
      )}

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Tag name (required) */}
        <CardField label="Tag name *" hint="Must reference an existing or new git tag">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              display: 'flex', alignItems: 'center',
              border: `1px solid ${!tagName ? 'rgba(193,125,16,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
              borderRadius: 4,
              background: 'var(--vscode-input-background)',
              overflow: 'hidden',
            }}>
              <span aria-hidden style={{
                padding: '0 8px', height: 26,
                display: 'inline-flex', alignItems: 'center',
                background: 'rgba(252,109,38,0.10)', color: '#fc6d26',
                borderRight: '1px solid var(--vscode-panel-border, #444)',
                flex: '0 0 auto',
              }}>
                <TagFilledIcon />
              </span>
              <input
                disabled={disabled}
                type="text"
                value={tagName}
                onChange={(e) => patch(e.target.value ? { tag_name: e.target.value } : {}, e.target.value ? [] : ['tag_name'])}
                placeholder="v$CI_COMMIT_SHORT_SHA"
                spellCheck={false}
                style={{
                  flex: 1, minWidth: 0,
                  padding: '4px 8px',
                  background: 'transparent',
                  color: 'var(--vscode-input-foreground)',
                  border: 'none', outline: 'none',
                  fontSize: 12,
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {!disabled && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {TAG_NAME_PRESETS.map((p) => {
                  const active = tagName === p.value;
                  return (
                    <button
                      key={p.value}
                      onClick={() => patch({ tag_name: p.value })}
                      title={p.hint}
                      style={{
                        padding: '2px 8px',
                        fontSize: 10, fontWeight: 600,
                        background: active ? 'rgba(252,109,38,0.18)' : 'transparent',
                        color: active ? '#fc6d26' : 'var(--vscode-descriptionForeground)',
                        border: `1px solid ${active ? 'rgba(252,109,38,0.50)' : 'var(--vscode-panel-border, #444)'}`,
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                      }}
                    >{p.label}</button>
                  );
                })}
              </div>
            )}
          </div>
        </CardField>

        {/* Description (required) */}
        <DescriptionField
          value={description}
          disabled={disabled}
          onChange={(v) => patch(v ? { description: v } : {}, v ? [] : ['description'])}
        />

        {/* Release name */}
        <CardField label="Release name" hint="Defaults to tag_name when omitted">
          <input
            disabled={disabled}
            type="text"
            value={releaseName}
            onChange={(e) => patch(e.target.value ? { name: e.target.value } : {}, e.target.value ? [] : ['name'])}
            placeholder="Release $CI_COMMIT_TAG"
            style={{ ...glInputStyle, height: 26 }}
          />
        </CardField>

        {/* Assets / Links */}
        <Disclosure
          open={assetsOpen}
          onToggle={() => setAssetsOpen((v) => !v)}
          label="Asset links"
          countBadge={links.length}
        >
          {assetsOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {links.length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
                  No asset links. Add packages, container images, or runbooks.
                </div>
              )}
              {links.map((l, i) => {
                const lt = typeof l.link_type === 'string' ? l.link_type : 'other';
                const ltMeta = LINK_TYPE.find((x) => x.value === lt) ?? LINK_TYPE[3];
                return (
                  <div key={i} style={{
                    padding: 8,
                    background: `${ltMeta.color}0d`,
                    border: `1px solid ${ltMeta.color}33`,
                    borderRadius: 4,
                    display: 'flex', flexDirection: 'column', gap: 6,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 20, height: 20, flex: '0 0 auto',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: `${ltMeta.color}1f`, color: ltMeta.color,
                        border: `1px solid ${ltMeta.color}55`,
                        borderRadius: 4,
                      }}>{ltMeta.icon}</span>
                      <input
                        disabled={disabled}
                        type="text"
                        value={l.name ?? ''}
                        onChange={(e) => updateLink(i, { name: e.target.value })}
                        placeholder="Link name"
                        style={{ ...glInputStyle, height: 24, flex: 1 }}
                      />
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 4px 2px 8px',
                        border: `1px solid ${ltMeta.color}55`,
                        background: `${ltMeta.color}1f`,
                        borderRadius: 10,
                        color: ltMeta.color,
                        fontSize: 10, fontWeight: 700,
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: ltMeta.color }} aria-hidden />
                        <select
                          disabled={disabled}
                          value={lt}
                          onChange={(e) => updateLink(i, { link_type: e.target.value })}
                          style={{
                            background: 'transparent', color: ltMeta.color,
                            border: 'none', fontSize: 10, fontWeight: 700,
                            outline: 'none', appearance: 'none', paddingRight: 12,
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            fontFamily: 'var(--vscode-font-family)',
                          }}
                        >
                          {LINK_TYPE.map((o) => (
                            <option key={o.value} value={o.value} style={{ background: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-foreground)' }}>{o.value}</option>
                          ))}
                        </select>
                      </span>
                      {!disabled && (
                        <button onClick={() => removeLink(i)} title="Remove link" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
                          <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
                        </button>
                      )}
                    </div>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
                      borderRadius: 4,
                      background: 'var(--vscode-input-background)',
                      overflow: 'hidden',
                    }}>
                      <span aria-hidden style={{
                        padding: '0 8px', height: 24,
                        display: 'inline-flex', alignItems: 'center',
                        background: 'rgba(31,117,203,0.10)', color: '#1f75cb',
                        borderRight: '1px solid var(--vscode-panel-border, #444)',
                      }}>
                        <LinkIcon />
                      </span>
                      <input
                        disabled={disabled}
                        type="text"
                        value={l.url ?? ''}
                        onChange={(e) => updateLink(i, { url: e.target.value })}
                        placeholder="https://example.com/file.zip"
                        spellCheck={false}
                        style={{
                          flex: 1, minWidth: 0,
                          padding: '3px 8px',
                          background: 'transparent',
                          color: 'var(--vscode-input-foreground)',
                          border: 'none', outline: 'none',
                          fontSize: 12,
                          fontFamily: 'var(--vscode-editor-font-family, monospace)',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    {(l.filepath !== undefined && l.filepath !== '') ? (
                      <div>
                        <label style={varSubLabelStyle}>Filepath (download redirect)</label>
                        <input
                          disabled={disabled}
                          type="text"
                          value={l.filepath ?? ''}
                          onChange={(e) => updateLink(i, e.target.value ? { filepath: e.target.value } : {}, e.target.value ? [] : ['filepath'])}
                          placeholder="/binaries/linux-amd64.zip"
                          style={{ ...glInputStyle, height: 22, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                        />
                      </div>
                    ) : !disabled && (
                      <button
                        onClick={() => updateLink(i, { filepath: '' })}
                        style={{
                          alignSelf: 'flex-start',
                          padding: '2px 6px', fontSize: 9, fontWeight: 600,
                          background: 'transparent', color: 'var(--vscode-descriptionForeground)',
                          border: '1px dashed var(--vscode-panel-border, #444)',
                          borderRadius: 3, cursor: 'pointer',
                        }}
                      >+ filepath redirect</button>
                    )}
                  </div>
                );
              })}
              {!disabled && (
                <button
                  onClick={addLink}
                  style={{
                    alignSelf: 'flex-start',
                    padding: '4px 10px', fontSize: 11, fontWeight: 600,
                    background: 'rgba(252,109,38,0.08)', color: '#fc6d26',
                    border: '1px solid rgba(252,109,38,0.30)', borderRadius: 4,
                    cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontFamily: 'var(--vscode-font-family)',
                  }}
                >
                  <PlusIconSmall /> Add asset link
                </button>
              )}
            </div>
          )}
        </Disclosure>

        {/* Advanced */}
        <Disclosure
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          label="Advanced"
          countBadge={[tagMessage, ref, releasedAt, ...milestones].filter(Boolean).length}
        >
          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <CardField label="Tag message" hint="Used only when creating a new annotated tag">
                <input
                  disabled={disabled}
                  type="text"
                  value={tagMessage}
                  onChange={(e) => patch(e.target.value ? { tag_message: e.target.value } : {}, e.target.value ? [] : ['tag_message'])}
                  placeholder="Release v1.2.3"
                  style={{ ...glInputStyle, height: 24 }}
                />
              </CardField>
              <CardField label="Ref" hint="Branch / commit SHA / tag to create the tag from when it doesn't exist">
                <input
                  disabled={disabled}
                  type="text"
                  value={ref}
                  onChange={(e) => patch(e.target.value ? { ref: e.target.value } : {}, e.target.value ? [] : ['ref'])}
                  placeholder="main"
                  style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
              </CardField>
              <CardField label="Released at" hint="When the release is dated; defaults to now">
                <ReleasedAtField
                  value={releasedAt}
                  disabled={disabled}
                  onChange={(v) => patch(v ? { released_at: v } : {}, v ? [] : ['released_at'])}
                />
              </CardField>
              <CardField label="Milestones" hint="Milestone titles to associate with this release">
                <StringListEditor
                  list={milestones}
                  onChange={(l) => patch(l.length > 0 ? { milestones: l } : {}, l.length === 0 ? ['milestones'] : [])}
                  placeholder="v1.2"
                />
              </CardField>
            </div>
          )}
        </Disclosure>
      </div>
    </div>
  );
}

function TagOutlineIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 2 H8 L14 8 L8 14 L2 8 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={5} cy={5} r={1.1} fill="currentColor" />
    </svg>
  );
}
function TagFilledIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 2 H8 L14 8 L8 14 L2 8 Z" fill="currentColor" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" opacity={0.85} />
      <circle cx={5} cy={5} r={1.1} fill="var(--vscode-input-background, #1e1e1e)" />
    </svg>
  );
}

// Tiny inline warning glyph used in the release "required" banner
function WarnIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
      <rect x={7.4} y={6} width={1.2} height={4.5} rx={0.5} fill="currentColor" />
      <circle cx={8} cy={12} r={0.8} fill="currentColor" />
    </svg>
  );
}

// ---------- artifacts editor ----------

const ARTIFACTS_WHEN: { value: string; color: string }[] = [
  { value: 'on_success', color: '#108548' },
  { value: 'on_failure', color: '#c17d10' },
  { value: 'always', color: '#1f75cb' },
];
const ARTIFACTS_ACCESS: { value: string; color: string }[] = [
  { value: 'all', color: '#108548' },
  { value: 'developer', color: '#1f75cb' },
  { value: 'maintainer', color: '#6e49cb' },
  { value: 'none', color: '#dd2b0e' },
];

const KNOWN_REPORTS: { key: string; label: string; hint: string }[] = [
  { key: 'junit', label: 'JUnit', hint: 'Test results — shown in MR widget' },
  { key: 'coverage_report', label: 'Coverage', hint: 'Cobertura or Jacoco coverage' },
  { key: 'codequality', label: 'Code quality', hint: 'Code Climate style reports' },
  { key: 'sast', label: 'SAST', hint: 'Static application security test' },
  { key: 'dast', label: 'DAST', hint: 'Dynamic application security test' },
  { key: 'dependency_scanning', label: 'Dependencies', hint: 'Dependency vulnerability scan' },
  { key: 'container_scanning', label: 'Containers', hint: 'Container image vulnerabilities' },
  { key: 'secret_detection', label: 'Secrets', hint: 'Leaked credential scan' },
  { key: 'dotenv', label: 'Dotenv', hint: 'Export variables to downstream jobs' },
  { key: 'terraform', label: 'Terraform', hint: 'Terraform plan output' },
];

function ArtifactsEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...value, ...p };
    for (const k of deleteKeys) delete next[k];
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }

  const paths = stringArrayFrom(value.paths);
  const exclude = stringArrayFrom(value.exclude);
  const reports = (value.reports && typeof value.reports === 'object' && !Array.isArray(value.reports))
    ? value.reports as Record<string, unknown>
    : null;
  const when = typeof value.when === 'string' ? value.when : 'on_success';
  const access = typeof value.access === 'string' ? value.access : 'all';
  const expireIn = typeof value.expire_in === 'string' ? value.expire_in : '';
  const untracked = value.untracked === true;
  const name = typeof value.name === 'string' ? value.name : '';
  const exposeAs = typeof value.expose_as === 'string' ? value.expose_as : '';

  const [advancedOpen, setAdvancedOpen] = useState(!!name || !!exposeAs || untracked);
  const [reportsOpen, setReportsOpen] = useState(!!reports);

  return (
    <div style={chipsBoxStyle}>
      {/* Header */}
      <CardHeader icon={<ArtifactsIcon />} title="Artifacts" color="#1f75cb" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Paths */}
        <CardField label="Paths" hint="Files and directories to upload after the job succeeds">
          <StringListEditor list={paths} onChange={(l) => patch({ paths: l }, l.length === 0 ? ['paths'] : [])} placeholder="e.g. dist/**/*" />
        </CardField>

        {/* Quick row: when / access / expire_in */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <FieldInline label="When">
            <EnumPill
              value={when}
              options={ARTIFACTS_WHEN}
              onChange={(v) => patch(v === 'on_success' ? {} : { when: v }, v === 'on_success' ? ['when'] : [])}
              disabled={disabled}
            />
          </FieldInline>
          <FieldInline label="Access">
            <EnumPill
              value={access}
              options={ARTIFACTS_ACCESS}
              onChange={(v) => patch(v === 'all' ? {} : { access: v }, v === 'all' ? ['access'] : [])}
              disabled={disabled}
            />
          </FieldInline>
          <FieldInline label="Expire after" grow>
            <input
              disabled={disabled}
              type="text"
              value={expireIn}
              onChange={(e) => patch(e.target.value ? { expire_in: e.target.value } : {}, e.target.value ? [] : ['expire_in'])}
              placeholder="30 days"
              style={{ ...glInputStyle, height: 24 }}
            />
          </FieldInline>
        </div>

        {/* Untracked toggle */}
        <CheckboxRow
          checked={untracked}
          onChange={() => patch(untracked ? {} : { untracked: true }, untracked ? ['untracked'] : [])}
          label="Include untracked files"
          hint="Also upload any files not tracked by git"
        />

        {/* Reports (collapsible) */}
        <Disclosure
          open={reportsOpen}
          onToggle={() => setReportsOpen((v) => !v)}
          label="Reports"
          countBadge={reports ? Object.keys(reports).length : 0}
        >
          {reportsOpen && (
            <ReportsEditor
              value={reports ?? {}}
              onChange={(next) => patch(next ? { reports: next } : {}, next ? [] : ['reports'])}
              disabled={disabled}
            />
          )}
        </Disclosure>

        {/* Advanced (collapsible) */}
        <Disclosure
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          label="Advanced"
        >
          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <CardField label="Archive name" hint="Variables like $CI_JOB_NAME are expanded">
                <input
                  disabled={disabled}
                  type="text"
                  value={name}
                  onChange={(e) => patch(e.target.value ? { name: e.target.value } : {}, e.target.value ? [] : ['name'])}
                  placeholder="$CI_JOB_NAME-$CI_COMMIT_SHORT_SHA"
                  style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
              </CardField>
              <CardField label="Expose as" hint="Label shown in the merge request widget">
                <input
                  disabled={disabled}
                  type="text"
                  value={exposeAs}
                  onChange={(e) => patch(e.target.value ? { expose_as: e.target.value } : {}, e.target.value ? [] : ['expose_as'])}
                  placeholder="My report"
                  style={{ ...glInputStyle, height: 24 }}
                />
              </CardField>
              <CardField label="Exclude" hint="Paths to exclude from the archive">
                <StringListEditor list={exclude} onChange={(l) => patch({ exclude: l }, l.length === 0 ? ['exclude'] : [])} placeholder="e.g. **/*.log" />
              </CardField>
            </div>
          )}
        </Disclosure>
      </div>
    </div>
  );
}

function ReportsEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: Record<string, unknown> | undefined) => void; disabled?: boolean }) {
  function patch(key: string, next: unknown, remove = false) {
    const out = { ...value };
    if (remove) delete out[key];
    else out[key] = next;
    onChange(Object.keys(out).length === 0 ? undefined : out);
  }

  const presentKeys = new Set(Object.keys(value));
  const knownPresent = KNOWN_REPORTS.filter((r) => presentKeys.has(r.key));
  const knownAvailable = KNOWN_REPORTS.filter((r) => !presentKeys.has(r.key));
  const unknownKeys = Object.keys(value).filter((k) => !KNOWN_REPORTS.some((r) => r.key === k));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {knownPresent.length === 0 && unknownKeys.length === 0 && (
        <div style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>No reports configured.</div>
      )}
      {knownPresent.map((r) => {
        const raw = value[r.key];
        const isCoverage = r.key === 'coverage_report';
        if (isCoverage && raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const cov = raw as Record<string, unknown>;
          return (
            <ReportRow key={r.key} report={r} onRemove={() => patch(r.key, null, true)} disabled={disabled}>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  disabled={disabled}
                  value={typeof cov.coverage_format === 'string' ? cov.coverage_format : ''}
                  onChange={(e) => patch(r.key, { ...cov, coverage_format: e.target.value || undefined })}
                  style={{ ...glInputStyle, height: 24, width: 120, fontFamily: 'var(--vscode-font-family)' }}
                >
                  <option value="">(format)</option>
                  <option value="cobertura">cobertura</option>
                  <option value="jacoco">jacoco</option>
                </select>
                <input
                  disabled={disabled}
                  type="text"
                  value={typeof cov.path === 'string' ? cov.path : ''}
                  onChange={(e) => patch(r.key, { ...cov, path: e.target.value })}
                  placeholder="path/to/coverage.xml"
                  style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
              </div>
            </ReportRow>
          );
        }
        const isList = Array.isArray(raw);
        return (
          <ReportRow key={r.key} report={r} onRemove={() => patch(r.key, null, true)} disabled={disabled}>
            {isList ? (
              <StringListEditor
                list={(raw as unknown[]).map((x) => String(x))}
                onChange={(l) => patch(r.key, l.length === 1 ? l[0] : l)}
                placeholder="path/to/report.xml"
              />
            ) : (
              <input
                disabled={disabled}
                type="text"
                value={typeof raw === 'string' ? raw : ''}
                onChange={(e) => patch(r.key, e.target.value)}
                placeholder="path/to/report.xml"
                style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
              />
            )}
          </ReportRow>
        );
      })}
      {unknownKeys.map((k) => (
        <ReportRow
          key={k}
          report={{ key: k, label: k, hint: 'Custom report type' }}
          onRemove={() => patch(k, null, true)}
          disabled={disabled}
        >
          <input
            disabled={disabled}
            type="text"
            value={typeof value[k] === 'string' ? (value[k] as string) : JSON.stringify(value[k])}
            onChange={(e) => patch(k, e.target.value)}
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </ReportRow>
      ))}
      {!disabled && knownAvailable.length > 0 && (
        <ReportAddMenu options={knownAvailable} onAdd={(k) => patch(k, k === 'coverage_report' ? {} : '')} />
      )}
    </div>
  );
}

function ReportRow({
  report, onRemove, disabled, children,
}: { report: { key: string; label: string; hint: string }; onRemove: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 8, padding: 6,
      background: 'rgba(31,117,203,0.04)',
      border: '1px solid rgba(31,117,203,0.20)',
      borderRadius: 4,
      alignItems: 'flex-start',
    }}>
      <div style={{ flex: '0 0 110px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#1f75cb' }}>{report.label}</div>
        <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1 }}>{report.hint}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {!disabled && (
        <button onClick={onRemove} title="Remove report" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
          <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}

function ReportAddMenu({ options, onAdd }: { options: { key: string; label: string; hint: string }[]; onAdd: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          alignSelf: 'flex-start',
          padding: '3px 8px', fontSize: 10, fontWeight: 600,
          background: 'transparent', color: '#1f75cb',
          border: '1px dashed rgba(31,117,203,0.4)', borderRadius: 4, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >+ add report</button>
      {open && (
        <div style={{ ...popoverStyle, top: 'calc(100% + 4px)', left: 0, right: 'auto', minWidth: 220, maxHeight: 240 }}>
          {options.map((r) => (
            <button key={r.key} onClick={() => { onAdd(r.key); setOpen(false); }} style={{ ...pickItemStyle, fontFamily: 'var(--vscode-font-family)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}>
              <div style={{ fontSize: 11, fontWeight: 600 }}>{r.label}</div>
              <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1 }}>{r.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- cache: single or multi-cache wrapper ----------

// GitLab accepts `cache:` as a single object OR an array of cache objects (up to 4).
// Multiple caches let a job pull/push several keyed caches independently in one run.
const MAX_CACHES = 4;

function CacheList({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const asArray = Array.isArray(value) ? (value as unknown[]) : null;
  const items: Record<string, unknown>[] = asArray
    ? asArray.map((c) => (c && typeof c === 'object' && !Array.isArray(c)) ? c as Record<string, unknown> : {})
    : (value && typeof value === 'object' && !Array.isArray(value))
    ? [value as Record<string, unknown>]
    : [{}];
  const isMulti = items.length > 1 || asArray !== null;

  function commit(next: Record<string, unknown>[]) {
    // Drop trailing entries that became empty objects
    const cleaned = next.filter((c) => Object.keys(c).length > 0);
    if (cleaned.length === 0) { onChange(undefined); return; }
    if (cleaned.length === 1 && !isMulti) {
      onChange(cleaned[0]);
      return;
    }
    onChange(cleaned);
  }

  function update(i: number, next: unknown) {
    const arr = items.slice();
    if (next === undefined || next === null) {
      arr.splice(i, 1);
    } else if (typeof next === 'object' && !Array.isArray(next)) {
      arr[i] = next as Record<string, unknown>;
    }
    commit(arr);
  }

  function addCache() {
    if (items.length >= MAX_CACHES) return;
    // Switch to array form when adding a second cache; promote single object up.
    onChange([...items, {}]);
  }

  function removeAt(i: number) {
    const arr = items.slice();
    arr.splice(i, 1);
    if (arr.length === 0) { onChange(undefined); return; }
    if (arr.length === 1) { onChange(arr[0]); return; }
    onChange(arr);
  }

  // Identify human-readable subtitle for each cache (helps when there are several)
  function captionFor(c: Record<string, unknown>): string {
    if (typeof c.key === 'string' && c.key) return c.key;
    if (c.key && typeof c.key === 'object' && !Array.isArray(c.key)) {
      const files = (c.key as Record<string, unknown>).files;
      if (Array.isArray(files) && files.length > 0) return `by files: ${String(files[0])}${files.length > 1 ? ` +${files.length - 1}` : ''}`;
    }
    return '(unnamed cache)';
  }

  // Single-cache view — just render the editor inline without the list wrapper chrome.
  if (items.length <= 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CacheEditor value={items[0]} onChange={(v) => update(0, v)} disabled={disabled} />
        {!disabled && (
          <button
            onClick={addCache}
            style={addCacheBtnStyle}
            title="Configure an additional keyed cache for this job"
          >
            <PlusIconSmall /> Add another cache
          </button>
        )}
      </div>
    );
  }

  // Multi-cache view
  return (
    <div style={chipsBoxStyle}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
        background: 'linear-gradient(180deg, rgba(110,73,203,0.08), transparent)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 22, height: 22, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(110,73,203,0.18)', border: '1px solid rgba(110,73,203,0.50)', borderRadius: 4,
          color: '#6e49cb',
        }}><CacheIcon /></span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#6e49cb' }}>Caches</span>
        <MiniBadge label={`${items.length} of ${MAX_CACHES}`} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, opacity: 0.6 }}>All caches are pulled/pushed independently</span>
      </div>

      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((c, i) => (
          <CacheSubCard
            key={i}
            index={i}
            total={items.length}
            caption={captionFor(c)}
            disabled={disabled}
            onRemove={() => removeAt(i)}
          >
            <CacheEditor value={c} onChange={(v) => update(i, v)} disabled={disabled} />
          </CacheSubCard>
        ))}
        {!disabled && items.length < MAX_CACHES && (
          <button onClick={addCache} style={addCacheBtnStyle}>
            <PlusIconSmall /> Add another cache
          </button>
        )}
        {items.length >= MAX_CACHES && (
          <div style={{ fontSize: 10, opacity: 0.6, fontStyle: 'italic', padding: '2px 4px' }}>
            GitLab allows at most {MAX_CACHES} caches per job.
          </div>
        )}
      </div>
    </div>
  );
}

function CacheSubCard({
  index, total, caption, disabled, onRemove, children,
}: { index: number; total: number; caption: string; disabled?: boolean; onRemove: () => void; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{
      border: '1px solid rgba(110,73,203,0.30)',
      borderRadius: 4,
      background: 'rgba(110,73,203,0.04)',
      overflow: 'hidden',
    }}>
      <div
        onClick={() => setCollapsed((v) => !v)}
        style={{
          padding: '6px 10px',
          display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer',
          background: 'rgba(110,73,203,0.06)',
          borderBottom: collapsed ? 'none' : '1px solid rgba(110,73,203,0.20)',
          userSelect: 'none',
        }}
      >
        <span style={{
          width: 20, height: 20, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(110,73,203,0.16)', color: '#6e49cb',
          border: '1px solid rgba(110,73,203,0.40)', borderRadius: '50%',
          fontSize: 10, fontWeight: 700,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
        }}>{index + 1}</span>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 11, fontWeight: 600,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: '#6e49cb',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{caption}</span>
        <svg
          width={9} height={9} viewBox="0 0 12 12" aria-hidden
          style={{ opacity: 0.6, transition: 'transform 120ms ease', transform: collapsed ? 'none' : 'rotate(90deg)' }}
        >
          <path d="M4 3 L8 6 L4 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {!disabled && total > 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove this cache"
            style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e', marginLeft: 4 }}
          >
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

const addCacheBtnStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '5px 10px', fontSize: 11, fontWeight: 600,
  background: 'rgba(110,73,203,0.08)', color: '#6e49cb',
  border: '1px solid rgba(110,73,203,0.30)', borderRadius: 4,
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 5,
  fontFamily: 'var(--vscode-font-family)',
};

// ---------- cache editor ----------

const CACHE_POLICY: { value: string; color: string; hint: string }[] = [
  { value: 'pull-push', color: '#1f75cb', hint: 'Download at start, upload at end (default)' },
  { value: 'pull', color: '#108548', hint: 'Only download, never upload' },
  { value: 'push', color: '#c17d10', hint: 'Only upload, never download' },
];
const CACHE_WHEN: { value: string; color: string }[] = [
  { value: 'on_success', color: '#108548' },
  { value: 'on_failure', color: '#c17d10' },
  { value: 'always', color: '#1f75cb' },
];

function CacheEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...value, ...p };
    for (const k of deleteKeys) delete next[k];
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }

  const paths = stringArrayFrom(value.paths);
  const fallback = stringArrayFrom(value.fallback_keys);
  const policy = typeof value.policy === 'string' ? value.policy : 'pull-push';
  const when = typeof value.when === 'string' ? value.when : 'on_success';
  const untracked = value.untracked === true;
  const unprotect = value.unprotect === true;

  // Key can be a string or { files, prefix }
  const keyRaw = value.key;
  const keyIsObj = keyRaw && typeof keyRaw === 'object' && !Array.isArray(keyRaw);
  const keyStr = typeof keyRaw === 'string' ? keyRaw : '';
  const keyFiles = keyIsObj ? stringArrayFrom((keyRaw as Record<string, unknown>).files) : [];
  const keyPrefix = keyIsObj && typeof (keyRaw as Record<string, unknown>).prefix === 'string'
    ? (keyRaw as Record<string, unknown>).prefix as string
    : '';

  const [keyMode, setKeyMode] = useState<'string' | 'files'>(keyIsObj ? 'files' : 'string');
  const [advancedOpen, setAdvancedOpen] = useState(untracked || unprotect || fallback.length > 0);

  function setKeyString(s: string) {
    patch(s ? { key: s } : {}, s ? [] : ['key']);
  }
  function setKeyFiles(files: string[], prefix: string) {
    if (files.length === 0 && !prefix) {
      patch({}, ['key']);
      return;
    }
    patch({ key: { files, ...(prefix ? { prefix } : {}) } });
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<CacheIcon />} title="Cache" color="#6e49cb" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Key with mode toggle */}
        <CardField
          label="Key"
          hint={keyMode === 'string' ? 'Shared identifier for the cache' : 'Hash these files into a cache key'}
          trailing={
            !disabled && (
              <div style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, overflow: 'hidden' }}>
                <ModeBtn active={keyMode === 'string'} onClick={() => { setKeyMode('string'); if (keyIsObj) patch({}, ['key']); }}>string</ModeBtn>
                <ModeBtn active={keyMode === 'files'} onClick={() => { setKeyMode('files'); if (!keyIsObj && keyStr) setKeyFiles([], keyStr); }}>by files</ModeBtn>
              </div>
            )
          }
        >
          {keyMode === 'string' ? (
            <input
              disabled={disabled}
              type="text"
              value={keyStr}
              onChange={(e) => setKeyString(e.target.value)}
              placeholder="$CI_COMMIT_REF_SLUG"
              spellCheck={false}
              style={{ ...glInputStyle, height: 26, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <StringListEditor list={keyFiles} onChange={(l) => setKeyFiles(l, keyPrefix)} placeholder="e.g. package-lock.json" />
              <div>
                <label style={varSubLabelStyle}>Prefix (optional)</label>
                <input
                  disabled={disabled}
                  type="text"
                  value={keyPrefix}
                  onChange={(e) => setKeyFiles(keyFiles, e.target.value)}
                  placeholder="node-"
                  style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
              </div>
            </div>
          )}
        </CardField>

        {/* Paths */}
        <CardField label="Paths" hint="Directories to cache between job runs">
          <StringListEditor list={paths} onChange={(l) => patch({ paths: l }, l.length === 0 ? ['paths'] : [])} placeholder="e.g. node_modules/" />
        </CardField>

        {/* Quick row: policy / when */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <FieldInline label="Policy">
            <EnumPill
              value={policy}
              options={CACHE_POLICY}
              onChange={(v) => patch(v === 'pull-push' ? {} : { policy: v }, v === 'pull-push' ? ['policy'] : [])}
              disabled={disabled}
            />
          </FieldInline>
          <FieldInline label="When">
            <EnumPill
              value={when}
              options={CACHE_WHEN}
              onChange={(v) => patch(v === 'on_success' ? {} : { when: v }, v === 'on_success' ? ['when'] : [])}
              disabled={disabled}
            />
          </FieldInline>
        </div>

        {/* Tiny policy hint */}
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: -6, lineHeight: 1.4 }}>
          {CACHE_POLICY.find((p) => p.value === policy)?.hint}
        </div>

        {/* Advanced */}
        <Disclosure
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          label="Advanced"
        >
          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <CheckboxRow
                checked={untracked}
                onChange={() => patch(untracked ? {} : { untracked: true }, untracked ? ['untracked'] : [])}
                label="Cache untracked files"
                hint="Include files not tracked by git"
              />
              <CheckboxRow
                checked={unprotect}
                onChange={() => patch(unprotect ? {} : { unprotect: true }, unprotect ? ['unprotect'] : [])}
                label="Allow unprotected branches to use this cache"
                hint="By default protected and unprotected branches use separate caches"
              />
              <CardField label="Fallback keys" hint="Tried in order when the primary key misses">
                <StringListEditor list={fallback} onChange={(l) => patch({ fallback_keys: l }, l.length === 0 ? ['fallback_keys'] : [])} placeholder="$CI_DEFAULT_BRANCH" />
              </CardField>
            </div>
          )}
        </Disclosure>
      </div>
    </div>
  );
}

// ---------- shared bits for artifacts/cache cards ----------

function stringArrayFrom(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? ''));
  if (typeof v === 'string') return [v];
  return [];
}

function CardHeader({ icon, title, color }: { icon: React.ReactNode; title: string; color: string }) {
  return (
    <div style={{
      padding: '8px 12px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      background: `linear-gradient(180deg, ${color}10, transparent)`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{
        width: 22, height: 22, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}1f`, border: `1px solid ${color}55`, borderRadius: 4,
        color,
      }}>{icon}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color }}>{title}</span>
    </div>
  );
}

function CardField({
  label, hint, trailing, children,
}: { label: string; hint?: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ ...varSubLabelStyle, marginBottom: 0 }}>{label}</span>
        {hint && <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— {hint}</span>}
        <span style={{ flex: 1 }} />
        {trailing}
      </div>
      {children}
    </div>
  );
}

function FieldInline({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: grow ? '1 1 140px' : '0 0 auto', minWidth: 0 }}>
      <span style={varSubLabelStyle}>{label}</span>
      {children}
    </div>
  );
}

function EnumPill({
  value, options, onChange, disabled,
}: { value: string; options: { value: string; color: string }[]; onChange: (v: string) => void; disabled?: boolean }) {
  const opt = options.find((o) => o.value === value) ?? options[0];
  const color = opt.color;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 4px 2px 8px',
      border: `1px solid ${color}55`,
      background: `${color}1f`,
      borderRadius: 10,
      color,
      fontSize: 10, fontWeight: 700,
      width: 'fit-content',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} aria-hidden />
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'transparent', color,
          border: 'none', fontSize: 10, fontWeight: 700,
          fontFamily: 'var(--vscode-font-family)',
          outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
          appearance: 'none', paddingRight: 12,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-foreground)' }}>
            {o.value}
          </option>
        ))}
      </select>
    </span>
  );
}

function Disclosure({
  open, onToggle, label, countBadge, children,
}: { open: boolean; onToggle: () => void; label: string; countBadge?: number; children: React.ReactNode }) {
  return (
    <div>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: open ? 'rgba(255,255,255,0.04)' : 'transparent',
          border: '1px solid var(--vscode-panel-border, #2d2d2d)',
          borderRadius: 4,
          cursor: 'pointer',
          color: 'var(--vscode-foreground)',
          fontSize: 11, fontWeight: 600,
          fontFamily: 'var(--vscode-font-family)',
          textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden style={{ transition: 'transform 120ms ease', transform: open ? 'rotate(90deg)' : 'none' }}>
          <path d="M4 3 L8 6 L4 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{label}</span>
        {countBadge != null && countBadge > 0 && <MiniBadge label={String(countBadge)} />}
      </button>
      {open && <div style={{ padding: '8px 4px 2px' }}>{children}</div>}
    </div>
  );
}

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '2px 8px',
        fontSize: 10, fontWeight: 600,
        background: active ? 'var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.10))' : 'transparent',
        color: active ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'var(--vscode-font-family)',
      }}
    >{children}</button>
  );
}

function ArtifactsIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 5 L8 2 L14 5 L8 8 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <path d="M2 5 V11 L8 14 V8 M14 5 V11 L8 14" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}
function CacheIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <ellipse cx={8} cy={4} rx={5.5} ry={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M2.5 4 V8 a5.5 2 0 0 0 11 0 V4" fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M2.5 8 V12 a5.5 2 0 0 0 11 0 V8" fill="none" stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
}

// ---------- coverage regex field ----------

const COVERAGE_PRESETS: { label: string; pattern: string; hint: string }[] = [
  { label: 'pytest', pattern: '/TOTAL.*?(\\d+(?:\\.\\d+)?)%/', hint: 'pytest --cov' },
  { label: 'jest', pattern: '/All files[^|]*\\|[^|]*\\s+([\\d.]+)/', hint: 'Jest --coverage' },
  { label: 'go cover', pattern: '/coverage: (\\d+(?:\\.\\d+)?)% of statements/', hint: 'go test -cover' },
  { label: 'simplecov', pattern: '/\\(\\d+\\.\\d+\\%\\) covered/', hint: 'Ruby SimpleCov' },
  { label: 'phpunit', pattern: '/^\\s*Lines:\\s*\\d+\\.\\d+\\%/', hint: 'PHPUnit text report' },
  { label: 'istanbul', pattern: '/All files[^|]*\\|[^|]*\\s+([\\d.]+)/', hint: 'Istanbul / nyc' },
];

function stripCoverageSlashes(s: string): { body: string; valid: boolean } {
  if (!s) return { body: '', valid: true };
  // GitLab requires the regex be wrapped in `/.../`
  if (s.startsWith('/') && s.endsWith('/') && s.length >= 2) {
    return { body: s.slice(1, -1), valid: true };
  }
  return { body: s, valid: false };
}

function CoverageField({
  value, onChange, disabled,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { body, valid: hasSlashes } = stripCoverageSlashes(value);
  // Validate the regex part itself (does it compile?)
  const regexValid = (() => {
    if (!body) return true;
    try { new RegExp(body); return true; } catch { return false; }
  })();
  const fullyValid = !value || (hasSlashes && regexValid);

  function commit(newBody: string) {
    if (!newBody) { onChange(undefined); return; }
    onChange(`/${newBody}/`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'stretch',
        border: `1px solid ${!fullyValid ? 'rgba(221,43,14,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={slashAddon}>/</span>
        <input
          disabled={disabled}
          type="text"
          value={body}
          onChange={(e) => commit(e.target.value)}
          placeholder="coverage: (\\d+(?:\\.\\d+)?)%"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 6px',
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
          }}
        />
        <span aria-hidden style={slashAddon}>/</span>
        {body && regexValid && (
          <span style={{
            padding: '0 8px',
            display: 'inline-flex', alignItems: 'center',
            fontSize: 10, fontWeight: 600,
            color: '#108548',
            background: 'rgba(16,133,72,0.08)',
            borderLeft: '1px solid var(--vscode-panel-border, #444)',
          }}>valid</span>
        )}
      </div>
      {body && !regexValid && (
        <div style={{ fontSize: 10, color: '#dd2b0e', lineHeight: 1.4 }}>
          Invalid regular expression.
        </div>
      )}
      {value && !hasSlashes && regexValid && (
        <div style={{ fontSize: 10, color: '#dd2b0e', lineHeight: 1.4 }}>
          GitLab requires the regex to be wrapped in <code style={inlineKbdStyle}>/.../</code> — we'll save it that way.
        </div>
      )}
      {!disabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={varSubLabelStyle}>Common patterns</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {COVERAGE_PRESETS.map((p) => {
              const active = value === p.pattern;
              return (
                <button
                  key={p.label}
                  onClick={() => onChange(p.pattern)}
                  title={p.hint}
                  style={{
                    padding: '2px 8px',
                    fontSize: 10, fontWeight: 600,
                    background: active ? 'rgba(31,117,203,0.18)' : 'transparent',
                    color: active ? '#1f75cb' : 'var(--vscode-descriptionForeground)',
                    border: `1px solid ${active ? 'rgba(31,117,203,0.50)' : 'var(--vscode-panel-border, #444)'}`,
                    borderRadius: 10,
                    cursor: 'pointer',
                    fontFamily: 'var(--vscode-font-family)',
                  }}
                >{p.label}</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const slashAddon: React.CSSProperties = {
  padding: '0 8px',
  display: 'inline-flex', alignItems: 'center',
  background: 'rgba(110,73,203,0.10)',
  color: '#6e49cb',
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  fontSize: 14, fontWeight: 700,
  flex: '0 0 auto',
};

// ---------- identity field ----------

const IDENTITY_PROVIDERS: { value: string; label: string; color: string; hint: string; icon: React.ReactNode }[] = [
  { value: 'google_cloud', label: 'Google Cloud', color: '#1f75cb', hint: 'Workload Identity Federation for GCP', icon: <CloudIcon /> },
];

function CloudIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 12 a3.5 3 0 1 1 0.5 -5.9 a4 4 0 0 1 7 1.4 a2.5 2.5 0 0 1 -0.5 4.5 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

function IdentityField({
  value, onChange, disabled,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        padding: '6px 10px',
        fontSize: 10,
        background: 'rgba(193,125,16,0.08)',
        border: '1px solid rgba(193,125,16,0.30)',
        borderLeft: '3px solid #c17d10',
        borderRadius: 4,
        color: 'var(--vscode-foreground)',
        lineHeight: 1.4,
      }}>
        <span style={{ fontWeight: 700, color: '#c17d10', marginRight: 4 }}>EXPERIMENTAL</span>
        Workload identity — automatic auth with an external system.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {IDENTITY_PROVIDERS.map((p) => {
          const active = value === p.value;
          return (
            <button
              key={p.value}
              onClick={() => !disabled && onChange(active ? undefined : p.value)}
              disabled={disabled}
              title={p.hint}
              style={{
                padding: '6px 10px',
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: active ? `${p.color}1c` : 'transparent',
                color: active ? p.color : 'var(--vscode-foreground)',
                border: `1px solid ${active ? `${p.color}66` : 'var(--vscode-panel-border, #444)'}`,
                borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--vscode-font-family)',
                fontSize: 11, fontWeight: 600,
                transition: 'background 80ms ease, border-color 80ms ease',
              }}
            >
              <span style={{
                width: 22, height: 22,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: `${p.color}1f`, color: p.color,
                border: `1px solid ${p.color}55`, borderRadius: 4,
                flex: '0 0 auto',
              }}>{p.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                <span>{p.label}</span>
                <span style={{ fontSize: 9, opacity: 0.65, fontWeight: 400 }}>{p.hint}</span>
              </span>
              {active && <CheckTinyIcon />}
            </button>
          );
        })}
      </div>
      {/* Allow unknown values to be preserved (forward compatibility) */}
      {value && !IDENTITY_PROVIDERS.some((p) => p.value === value) && (
        <div style={{
          padding: '6px 8px',
          fontSize: 10,
          background: 'rgba(255,255,255,0.04)',
          border: '1px dashed var(--vscode-panel-border, #444)',
          borderRadius: 4,
          color: 'var(--vscode-descriptionForeground)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>Custom value:</span>
          <code style={inlineKbdStyle}>{value}</code>
          {!disabled && (
            <button
              onClick={() => onChange(undefined)}
              style={{ marginLeft: 'auto', ...iconBtnStyle, width: 18, height: 18, color: '#dd2b0e' }}
              title="Clear"
            >
              <svg width={8} height={8} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- parallel editor ----------

const PARALLEL_MAX = 200;
type MatrixEntry = Record<string, unknown>; // key -> string | number | array

type ParallelMode = 'count' | 'matrix';

function detectParallelMode(v: unknown): ParallelMode {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'matrix' in (v as Record<string, unknown>)) return 'matrix';
  return 'count';
}

// Count how many jobs a matrix entry expands to (cartesian product of array-valued keys).
function expandedJobsForEntry(entry: MatrixEntry): number {
  let total = 1;
  for (const v of Object.values(entry)) {
    if (Array.isArray(v)) total *= Math.max(1, v.length);
  }
  return total;
}

function ParallelEditor({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const mode = detectParallelMode(value);
  const count = typeof value === 'number' ? Math.max(1, Math.min(PARALLEL_MAX, Math.floor(value))) : 2;

  const matrix: MatrixEntry[] = (mode === 'matrix' && value && typeof value === 'object' && !Array.isArray(value))
    ? (() => {
        const m = (value as Record<string, unknown>).matrix;
        if (!Array.isArray(m)) return [{}];
        return m.map((e) => (e && typeof e === 'object' && !Array.isArray(e)) ? e as MatrixEntry : {});
      })()
    : [{}];

  function setMode(next: ParallelMode) {
    if (next === mode) return;
    if (next === 'count') onChange(2);
    else onChange({ matrix: [{ PROVIDER: ['aws', 'gcp'] }] });
  }

  function commitCount(n: number) {
    const clamped = Math.max(1, Math.min(PARALLEL_MAX, Math.floor(n) || 1));
    if (clamped <= 1) { onChange(undefined); return; }
    onChange(clamped);
  }

  function commitMatrix(next: MatrixEntry[]) {
    const cleaned = next.filter((e) => Object.keys(e).length > 0);
    if (cleaned.length === 0) { onChange(undefined); return; }
    onChange({ matrix: cleaned });
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<ParallelIcon />} title="Parallel" color="#fc6d26" />

      {/* Mode selector cards */}
      <div style={{ padding: 10, paddingBottom: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <ParallelKindCard
            active={mode === 'count'}
            disabled={disabled}
            color="#fc6d26"
            icon={<NodesIcon />}
            title="Count"
            hint="Run N identical instances with CI_NODE_INDEX"
            onClick={() => setMode('count')}
          />
          <ParallelKindCard
            active={mode === 'matrix'}
            disabled={disabled}
            color="#6e49cb"
            icon={<MatrixIcon />}
            title="Matrix"
            hint="Run a job per combination of variable values"
            onClick={() => setMode('matrix')}
          />
        </div>
      </div>

      {mode === 'count' ? (
        <CountModeBody count={count} disabled={disabled} onCommit={commitCount} />
      ) : (
        <MatrixModeBody entries={matrix} disabled={disabled} onCommit={commitMatrix} />
      )}
    </div>
  );
}

function ParallelKindCard({
  active, disabled, color, icon, title, hint, onClick,
}: { active: boolean; disabled?: boolean; color: string; icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: '1 1 180px',
        padding: 8,
        display: 'flex', alignItems: 'center', gap: 8,
        background: active ? `${color}1c` : 'transparent',
        border: `1px solid ${active ? `${color}66` : 'var(--vscode-panel-border, #444)'}`,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        color: 'var(--vscode-foreground)',
        fontFamily: 'var(--vscode-font-family)',
      }}
    >
      <span style={{
        width: 26, height: 26, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}1f`, color, border: `1px solid ${color}55`, borderRadius: 4,
      }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: active ? color : 'var(--vscode-foreground)' }}>{title}</div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 1, lineHeight: 1.35 }}>{hint}</div>
      </div>
      {active && <CheckTinyIcon />}
    </button>
  );
}

function CountModeBody({
  count, disabled, onCommit,
}: { count: number; disabled?: boolean; onCommit: (n: number) => void }) {
  // Quick preset chips for the common cases
  const presets = [2, 3, 5, 10, 20];

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Counter + slider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          disabled={disabled || count <= 1}
          onClick={() => onCommit(count - 1)}
          style={stepBtnStyle(disabled || count <= 1)}
          title="Decrease"
        >−</button>
        <input
          disabled={disabled}
          type="number"
          min={1}
          max={PARALLEL_MAX}
          value={count}
          onChange={(e) => onCommit(parseInt(e.target.value || '1', 10))}
          style={{
            width: 64, height: 30,
            padding: '0 6px',
            textAlign: 'center',
            fontSize: 16, fontWeight: 700,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            color: '#fc6d26',
            background: 'rgba(252,109,38,0.08)',
            border: '1px solid rgba(252,109,38,0.40)',
            borderRadius: 4,
            outline: 'none',
          }}
        />
        <button
          disabled={disabled || count >= PARALLEL_MAX}
          onClick={() => onCommit(count + 1)}
          style={stepBtnStyle(disabled || count >= PARALLEL_MAX)}
          title="Increase"
        >+</button>
        <input
          disabled={disabled}
          type="range"
          min={1}
          max={50}
          value={Math.min(50, count)}
          onChange={(e) => onCommit(parseInt(e.target.value, 10))}
          style={{ flex: 1, accentColor: '#fc6d26' }}
          title={count > 50 ? `${count} (slider capped at 50)` : `${count}`}
        />
        <span style={{
          fontSize: 11, fontWeight: 700, color: '#fc6d26',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          minWidth: 100, textAlign: 'right',
        }}>
          = {count} job{count === 1 ? '' : 's'}
        </span>
      </div>

      {/* Job-count visualization */}
      <NodeDotsRow count={count} />

      {/* Presets */}
      {!disabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {presets.map((n) => {
            const active = count === n;
            return (
              <button
                key={n}
                onClick={() => onCommit(n)}
                style={{
                  padding: '2px 8px',
                  fontSize: 10, fontWeight: 600,
                  background: active ? 'rgba(252,109,38,0.18)' : 'transparent',
                  color: active ? '#fc6d26' : 'var(--vscode-descriptionForeground)',
                  border: `1px solid ${active ? 'rgba(252,109,38,0.50)' : 'var(--vscode-panel-border, #444)'}`,
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontFamily: 'var(--vscode-font-family)',
                }}
              >× {n}</button>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.4 }}>
        Each instance gets <code style={inlineKbdStyle}>CI_NODE_INDEX</code> (1…{count}) and <code style={inlineKbdStyle}>CI_NODE_TOTAL</code> = {count}. Commonly used to split test suites.
      </div>
    </div>
  );
}

function stepBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 28, height: 30, flex: '0 0 auto',
    background: 'rgba(252,109,38,0.06)',
    color: disabled ? 'var(--vscode-descriptionForeground)' : '#fc6d26',
    border: '1px solid rgba(252,109,38,0.30)',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    fontSize: 16, fontWeight: 700,
    lineHeight: 1,
    fontFamily: 'var(--vscode-font-family)',
  };
}

function NodeDotsRow({ count }: { count: number }) {
  const dots = Math.min(count, 24);
  const extra = count - dots;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
      padding: '6px 8px',
      background: 'rgba(252,109,38,0.04)',
      border: '1px dashed rgba(252,109,38,0.25)',
      borderRadius: 4,
    }}>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          title={`CI_NODE_INDEX=${i + 1}`}
          style={{
            width: 14, height: 14,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 3,
            background: 'rgba(252,109,38,0.20)',
            border: '1px solid rgba(252,109,38,0.55)',
            color: '#fc6d26',
            fontSize: 8, fontWeight: 700,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
          }}
        >{i + 1}</span>
      ))}
      {extra > 0 && (
        <span style={{
          padding: '0 6px', height: 14,
          display: 'inline-flex', alignItems: 'center',
          fontSize: 9, fontWeight: 700, color: '#fc6d26',
          fontFamily: 'var(--vscode-font-family)',
        }}>+{extra} more</span>
      )}
    </div>
  );
}

function MatrixModeBody({
  entries, disabled, onCommit,
}: { entries: MatrixEntry[]; disabled?: boolean; onCommit: (next: MatrixEntry[]) => void }) {
  const totalJobs = entries.reduce((sum, e) => sum + expandedJobsForEntry(e), 0);
  const overLimit = totalJobs > PARALLEL_MAX;

  function updateEntry(i: number, next: MatrixEntry) {
    const arr = entries.slice();
    arr[i] = next;
    onCommit(arr);
  }
  function removeEntry(i: number) {
    const arr = entries.slice();
    arr.splice(i, 1);
    onCommit(arr);
  }
  function addEntry() {
    onCommit([...entries, { VAR: '' }]);
  }

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Total banner */}
      <div style={{
        padding: '6px 10px',
        background: overLimit ? 'rgba(221,43,14,0.08)' : 'rgba(110,73,203,0.08)',
        border: `1px solid ${overLimit ? 'rgba(221,43,14,0.30)' : 'rgba(110,73,203,0.30)'}`,
        borderLeft: `3px solid ${overLimit ? '#dd2b0e' : '#6e49cb'}`,
        borderRadius: 4,
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11,
      }}>
        <span style={{ fontWeight: 700, color: overLimit ? '#dd2b0e' : '#6e49cb' }}>= {totalJobs} parallel job{totalJobs === 1 ? '' : 's'}</span>
        <span style={{ opacity: 0.7 }}>
          {entries.length > 1 ? `(sum of ${entries.length} entries)` : `(${describeEntry(entries[0])})`}
        </span>
        {overLimit && <span style={{ marginLeft: 'auto', color: '#dd2b0e', fontWeight: 700 }}>over GitLab's {PARALLEL_MAX}-job cap</span>}
      </div>

      {entries.map((e, i) => (
        <MatrixEntryCard
          key={i}
          index={i}
          total={entries.length}
          entry={e}
          disabled={disabled}
          onChange={(next) => updateEntry(i, next)}
          onRemove={() => removeEntry(i)}
        />
      ))}

      {!disabled && (
        <button
          onClick={addEntry}
          style={addCacheBtnStyle}
          title="Add another variable set — its jobs add to the total"
        >
          <PlusIconSmall /> Add variable set
        </button>
      )}
    </div>
  );
}

function describeEntry(e: MatrixEntry | undefined): string {
  if (!e || Object.keys(e).length === 0) return 'empty';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (Array.isArray(v)) parts.push(`${v.length}× ${k}`);
    else parts.push(`${k}`);
  }
  return parts.join(' × ');
}

function MatrixEntryCard({
  index, total, entry, disabled, onChange, onRemove,
}: { index: number; total: number; entry: MatrixEntry; disabled?: boolean; onChange: (next: MatrixEntry) => void; onRemove: () => void }) {
  const entryJobs = expandedJobsForEntry(entry);
  const vars = Object.entries(entry);

  function updateVar(key: string, newKey: string | null, newVal?: unknown) {
    const next: MatrixEntry = {};
    for (const [k, v] of vars) {
      if (k === key) {
        if (newKey === null) continue; // remove
        next[newKey] = newVal !== undefined ? newVal : v;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  }

  function addVar() {
    const base = 'VAR'; let n = vars.length; let candidate = base;
    while (vars.some(([k]) => k === candidate)) candidate = `${base}_${++n}`;
    onChange({ ...entry, [candidate]: '' });
  }

  return (
    <div style={{
      padding: 8,
      background: 'rgba(110,73,203,0.04)',
      border: '1px solid rgba(110,73,203,0.30)',
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 22, height: 22, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(110,73,203,0.18)', color: '#6e49cb',
          border: '1px solid rgba(110,73,203,0.50)', borderRadius: '50%',
          fontSize: 11, fontWeight: 700,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
        }}>{index + 1}</span>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 11, fontWeight: 700, color: '#6e49cb',
        }}>
          {entryJobs} job{entryJobs === 1 ? '' : 's'} <span style={{ opacity: 0.6, fontWeight: 400 }}>· {describeEntry(entry)}</span>
        </span>
        {!disabled && total > 1 && (
          <button
            onClick={onRemove}
            title="Remove this entry"
            style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}
          >
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        )}
      </div>

      {vars.length === 0 ? (
        <div style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
          No variables yet — add at least one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vars.map(([k, v]) => (
            <MatrixVarRow
              key={k}
              keyName={k}
              value={v}
              disabled={disabled}
              onRename={(nk) => updateVar(k, nk)}
              onValueChange={(nv) => updateVar(k, k, nv)}
              onRemove={() => updateVar(k, null)}
            />
          ))}
        </div>
      )}

      {!disabled && (
        <button
          onClick={addVar}
          style={{
            alignSelf: 'flex-start',
            padding: '3px 8px', fontSize: 10, fontWeight: 600,
            background: 'transparent', color: '#6e49cb',
            border: '1px dashed rgba(110,73,203,0.5)', borderRadius: 10,
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--vscode-font-family)',
          }}
        >
          <PlusIconTiny /> add variable
        </button>
      )}
    </div>
  );
}

function MatrixVarRow({
  keyName, value, disabled, onRename, onValueChange, onRemove,
}: {
  keyName: string;
  value: unknown;
  disabled?: boolean;
  onRename: (nk: string) => void;
  onValueChange: (nv: unknown) => void;
  onRemove: () => void;
}) {
  const isArray = Array.isArray(value);
  const arrVals: string[] = isArray ? (value as unknown[]).map((x) => String(x ?? '')) : [];
  const scalarStr = !isArray ? (value == null ? '' : String(value)) : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6,
      padding: 6,
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 4,
    }}>
      <input
        disabled={disabled}
        type="text"
        value={keyName}
        onChange={(e) => onRename(e.target.value)}
        placeholder="VAR_NAME"
        spellCheck={false}
        style={{ ...glInputStyle, height: 24, width: 110, flex: '0 0 110px', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}
      />
      <span style={{
        paddingTop: 4, color: 'var(--vscode-descriptionForeground)',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: 12,
      }}>=</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {isArray ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {arrVals.length === 0 && (
              <div style={{ fontSize: 10, opacity: 0.5, fontStyle: 'italic' }}>No values — adds 0 jobs</div>
            )}
            {arrVals.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  disabled={disabled}
                  type="text"
                  value={v}
                  onChange={(e) => {
                    const next = arrVals.slice();
                    next[i] = e.target.value;
                    onValueChange(next);
                  }}
                  placeholder="value"
                  style={{ ...glInputStyle, height: 22, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
                {!disabled && (
                  <button
                    onClick={() => {
                      const next = arrVals.slice();
                      next.splice(i, 1);
                      onValueChange(next);
                    }}
                    title="Remove value"
                    style={{ ...iconBtnStyle, width: 20, height: 20, color: '#dd2b0e' }}
                  >
                    <svg width={8} height={8} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
                  </button>
                )}
              </div>
            ))}
            {!disabled && (
              <button
                onClick={() => onValueChange([...arrVals, ''])}
                style={{
                  alignSelf: 'flex-start',
                  padding: '2px 6px', fontSize: 9, fontWeight: 600,
                  background: 'transparent', color: '#6e49cb',
                  border: '1px dashed rgba(110,73,203,0.4)', borderRadius: 3,
                  cursor: 'pointer',
                }}
              >+ value</button>
            )}
          </div>
        ) : (
          <input
            disabled={disabled}
            type="text"
            value={scalarStr}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="value"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        )}
      </div>
      {!disabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '0 0 auto' }}>
          <button
            onClick={() => onValueChange(isArray ? (arrVals[0] ?? '') : [scalarStr || ''])}
            title={isArray ? 'Switch to single value' : 'Switch to list (cartesian)'}
            style={{
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: isArray ? 'rgba(110,73,203,0.16)' : 'transparent',
              color: isArray ? '#6e49cb' : 'var(--vscode-descriptionForeground)',
              border: `1px solid ${isArray ? 'rgba(110,73,203,0.40)' : 'var(--vscode-panel-border, #444)'}`,
              borderRadius: 3, cursor: 'pointer',
              fontFamily: 'var(--vscode-font-family)',
              whiteSpace: 'nowrap',
            }}
          >{isArray ? `list (${arrVals.length})` : 'single'}</button>
          <button
            onClick={onRemove}
            title="Remove variable"
            style={{ ...iconBtnStyle, width: 22, height: 18, color: '#dd2b0e' }}
          >
            <svg width={8} height={8} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function ParallelIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <rect x={1.5} y={2} width={3} height={12} rx={0.5} fill="currentColor" />
      <rect x={6.5} y={2} width={3} height={12} rx={0.5} fill="currentColor" />
      <rect x={11.5} y={2} width={3} height={12} rx={0.5} fill="currentColor" />
    </svg>
  );
}
function NodesIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={4} cy={4} r={1.5} fill="currentColor" />
      <circle cx={12} cy={4} r={1.5} fill="currentColor" />
      <circle cx={4} cy={12} r={1.5} fill="currentColor" />
      <circle cx={12} cy={12} r={1.5} fill="currentColor" />
    </svg>
  );
}
function MatrixIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <rect x={2} y={2} width={3} height={3} fill="currentColor" />
      <rect x={6.5} y={2} width={3} height={3} fill="currentColor" opacity={0.6} />
      <rect x={11} y={2} width={3} height={3} fill="currentColor" opacity={0.3} />
      <rect x={2} y={6.5} width={3} height={3} fill="currentColor" opacity={0.6} />
      <rect x={6.5} y={6.5} width={3} height={3} fill="currentColor" />
      <rect x={11} y={6.5} width={3} height={3} fill="currentColor" opacity={0.6} />
      <rect x={2} y={11} width={3} height={3} fill="currentColor" opacity={0.3} />
      <rect x={6.5} y={11} width={3} height={3} fill="currentColor" opacity={0.6} />
      <rect x={11} y={11} width={3} height={3} fill="currentColor" />
    </svg>
  );
}

// ---------- trigger editor ----------

type TriggerMode = 'child' | 'multi-project';

function detectTriggerMode(v: unknown): TriggerMode {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.project !== undefined && o.include === undefined) return 'multi-project';
    if (o.include !== undefined) return 'child';
  }
  return 'child';
}

function StrategyPill({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const opts = [
    { value: 'none', color: '#888', hint: 'Fire-and-forget — bridge succeeds once the downstream pipeline is created' },
    { value: 'depend', color: '#1f75cb', hint: 'Bridge job inherits the downstream pipeline status (success/failure)' },
    { value: 'mirror', color: '#6e49cb', hint: 'Bridge job mirrors the downstream pipeline (same status + duration)' },
  ];
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 4, overflow: 'hidden' }}>
      {opts.map((o) => {
        const active = (o.value === 'none' && (!value || value === 'none')) || value === o.value;
        return (
          <button
            key={o.value}
            disabled={disabled}
            onClick={() => onChange(o.value === 'none' ? '' : o.value)}
            title={o.hint}
            style={{
              padding: '3px 9px',
              fontSize: 10, fontWeight: 600,
              background: active ? `${o.color}24` : 'transparent',
              color: active ? o.color : 'var(--vscode-descriptionForeground)',
              border: 'none',
              borderRight: o === opts[opts.length - 1] ? 'none' : '1px solid var(--vscode-panel-border, #444)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--vscode-font-family)',
              transition: 'background 80ms ease',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: o.color }} aria-hidden />
            {o.value}
          </button>
        );
      })}
    </div>
  );
}

function TriggerEditor({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const obj = (value && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
  const mode = detectTriggerMode(value);
  const accent = mode === 'multi-project' ? '#6e49cb' : '#1f75cb';

  function commit(next: Record<string, unknown>) {
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }
  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...obj, ...p };
    for (const k of deleteKeys) delete next[k];
    commit(next);
  }
  function setMode(next: TriggerMode) {
    if (next === mode) return;
    const out: Record<string, unknown> = {};
    // Preserve overlapping fields
    if (typeof obj.strategy === 'string') out.strategy = obj.strategy;
    if (obj.forward) out.forward = obj.forward;
    if (obj.inputs) out.inputs = obj.inputs;
    if (next === 'multi-project') {
      out.project = typeof obj.project === 'string' ? obj.project : '';
    } else {
      // Preserve existing include if any; otherwise seed a local-file string
      out.include = obj.include ?? '';
    }
    commit(out);
  }

  const strategy = typeof obj.strategy === 'string' ? obj.strategy : '';
  const forward = (obj.forward && typeof obj.forward === 'object' && !Array.isArray(obj.forward))
    ? obj.forward as Record<string, unknown>
    : null;

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<TriggerArrowIcon />} title="Downstream trigger" color={accent} />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Kind selector */}
        <div>
          <label style={varSubLabelStyle}>Pipeline kind</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            <TriggerKindCard
              active={mode === 'child'}
              disabled={disabled}
              color="#1f75cb"
              icon={<ChildPipelineIcon />}
              title="Child pipeline"
              hint="Launches a pipeline defined in this repo or job artifacts"
              onClick={() => setMode('child')}
            />
            <TriggerKindCard
              active={mode === 'multi-project'}
              disabled={disabled}
              color="#6e49cb"
              icon={<MultiProjectIcon />}
              title="Multi-project"
              hint="Launches a pipeline in a different GitLab project"
              onClick={() => setMode('multi-project')}
            />
          </div>
        </div>

        {/* Body per mode */}
        {mode === 'multi-project' ? (
          <MultiProjectBody obj={obj} disabled={disabled} onPatch={patch} />
        ) : (
          <ChildPipelineBody obj={obj} disabled={disabled} onPatch={patch} />
        )}

        {/* Strategy + forward (shared) */}
        <CardField label="Strategy" hint="How the bridge job mirrors the downstream pipeline status">
          <StrategyPill
            value={strategy}
            disabled={disabled}
            onChange={(v) => patch(v ? { strategy: v } : {}, v ? [] : ['strategy'])}
          />
        </CardField>

        <ForwardSection
          forward={forward}
          disabled={disabled}
          onChange={(next) => patch(next ? { forward: next } : {}, next ? [] : ['forward'])}
        />
      </div>
    </div>
  );
}

function TriggerKindCard({
  active, disabled, color, icon, title, hint, onClick,
}: { active: boolean; disabled?: boolean; color: string; icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: '1 1 180px',
        padding: 8,
        display: 'flex', alignItems: 'center', gap: 8,
        background: active ? `${color}1c` : 'transparent',
        border: `1px solid ${active ? `${color}66` : 'var(--vscode-panel-border, #444)'}`,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        color: 'var(--vscode-foreground)',
        fontFamily: 'var(--vscode-font-family)',
      }}
    >
      <span style={{
        width: 26, height: 26, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}1f`, color, border: `1px solid ${color}55`, borderRadius: 4,
      }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: active ? color : 'var(--vscode-foreground)' }}>{title}</div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 1, lineHeight: 1.35 }}>{hint}</div>
      </div>
      {active && <CheckTinyIcon />}
    </button>
  );
}

function MultiProjectBody({
  obj, disabled, onPatch,
}: { obj: Record<string, unknown>; disabled?: boolean; onPatch: (p: Record<string, unknown>, deleteKeys?: string[]) => void }) {
  const project = typeof obj.project === 'string' ? obj.project : '';
  const branch = typeof obj.branch === 'string' ? obj.branch : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <CardField label="Project *" hint="Full path, e.g. group/project or group/sub-group/project">
        <div style={{
          display: 'flex', alignItems: 'center',
          border: `1px solid ${!project ? 'rgba(193,125,16,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
          borderRadius: 4,
          background: 'var(--vscode-input-background)',
          overflow: 'hidden',
        }}>
          <span aria-hidden style={{
            padding: '0 8px', height: 26,
            display: 'inline-flex', alignItems: 'center',
            background: 'rgba(110,73,203,0.10)', color: '#6e49cb',
            borderRight: '1px solid var(--vscode-panel-border, #444)',
          }}>
            <ProjectIcon />
          </span>
          <input
            disabled={disabled}
            type="text"
            value={project}
            onChange={(e) => onPatch(e.target.value ? { project: e.target.value } : {}, e.target.value ? [] : ['project'])}
            placeholder="my-group/my-project"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0,
              padding: '4px 8px',
              background: 'transparent',
              color: 'var(--vscode-input-foreground)',
              border: 'none', outline: 'none',
              fontSize: 12,
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </CardField>
      <CardField label="Branch" hint="Defaults to the project's default branch">
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
          borderRadius: 4,
          background: 'var(--vscode-input-background)',
          overflow: 'hidden',
        }}>
          <span aria-hidden style={{
            padding: '0 8px', height: 24,
            display: 'inline-flex', alignItems: 'center',
            background: 'rgba(31,117,203,0.10)', color: '#1f75cb',
            borderRight: '1px solid var(--vscode-panel-border, #444)',
          }}>
            <BranchIcon />
          </span>
          <input
            disabled={disabled}
            type="text"
            value={branch}
            onChange={(e) => onPatch(e.target.value ? { branch: e.target.value } : {}, e.target.value ? [] : ['branch'])}
            placeholder="main"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0,
              padding: '3px 8px',
              background: 'transparent',
              color: 'var(--vscode-input-foreground)',
              border: 'none', outline: 'none',
              fontSize: 12,
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </CardField>
    </div>
  );
}

function ChildPipelineBody({
  obj, disabled, onPatch,
}: { obj: Record<string, unknown>; disabled?: boolean; onPatch: (p: Record<string, unknown>, deleteKeys?: string[]) => void }) {
  const inc = obj.include;
  // Two simple modes: a single local-file string, or an array of include items (advanced).
  const asString = typeof inc === 'string' ? inc : '';
  const asArray = Array.isArray(inc) ? inc as unknown[] : null;
  const isArrayMode = asArray !== null;
  const [forceArray, setForceArray] = useState(isArrayMode);

  if (forceArray || isArrayMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CardField
          label="Include items *"
          hint="Each item references a YAML file: local, template, artifact, or project ref"
          trailing={
            !disabled && (
              <button
                onClick={() => {
                  setForceArray(false);
                  // Collapse to a single string if exactly one local-file item
                  if (asArray && asArray.length === 1) {
                    const it = asArray[0];
                    if (it && typeof it === 'object' && !Array.isArray(it) && typeof (it as Record<string, unknown>).local === 'string') {
                      onPatch({ include: (it as Record<string, unknown>).local });
                      return;
                    }
                  }
                  if (!asArray || asArray.length === 0) {
                    onPatch({ include: '' });
                  }
                }}
                style={{ ...glGhostBtnStyle, fontSize: 10, padding: '2px 6px' }}
              >use single file</button>
            )
          }
        >
          <div style={{
            padding: 8,
            background: 'rgba(31,117,203,0.05)',
            border: '1px solid rgba(31,117,203,0.20)',
            borderRadius: 4,
            fontSize: 11, opacity: 0.75,
          }}>
            Advanced include list ({asArray?.length ?? 0} item{asArray?.length === 1 ? '' : 's'}) — edit in YAML for now.
          </div>
        </CardField>
      </div>
    );
  }

  return (
    <CardField
      label="Include file *"
      hint="Path to a YAML file in this repo that defines the child pipeline"
      trailing={
        !disabled && (
          <button
            onClick={() => { setForceArray(true); onPatch({ include: [{ local: asString || '' }] }); }}
            style={{ ...glGhostBtnStyle, fontSize: 10, padding: '2px 6px' }}
          >use list</button>
        )
      }
    >
      <div style={{
        display: 'flex', alignItems: 'center',
        border: `1px solid ${!asString ? 'rgba(193,125,16,0.50)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={{
          padding: '0 8px', height: 26,
          display: 'inline-flex', alignItems: 'center',
          background: 'rgba(31,117,203,0.10)', color: '#1f75cb',
          borderRight: '1px solid var(--vscode-panel-border, #444)',
        }}>
          <FileIcon />
        </span>
        <input
          disabled={disabled}
          type="text"
          value={asString}
          onChange={(e) => onPatch(e.target.value ? { include: e.target.value } : {}, e.target.value ? [] : ['include'])}
          placeholder=".gitlab/ci/child.yml"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 8px',
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </CardField>
  );
}

function ForwardSection({
  forward, onChange,
}: { forward: Record<string, unknown> | null; disabled?: boolean; onChange: (next: Record<string, unknown> | null) => void }) {
  // Schema defaults: yaml_variables=true, pipeline_variables=false. We render the current
  // *effective* value but only persist a `forward` block when it differs from defaults.
  const yamlVars = forward?.yaml_variables === undefined ? true : forward.yaml_variables === true;
  const pipelineVars = forward?.pipeline_variables === undefined ? false : forward.pipeline_variables === true;

  function patch(p: { yaml_variables?: boolean; pipeline_variables?: boolean }) {
    const next = { ...(forward ?? {}), ...p };
    // Drop keys equal to default to avoid noisy YAML
    if (next.yaml_variables === true) delete next.yaml_variables;
    if (next.pipeline_variables === false) delete next.pipeline_variables;
    onChange(Object.keys(next).length === 0 ? null : next as Record<string, unknown>);
  }

  return (
    <CardField label="Forward to downstream" hint="What variables to pass to the triggered pipeline">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CheckboxRow
          checked={yamlVars}
          onChange={() => patch({ yaml_variables: !yamlVars })}
          label="YAML variables"
          hint="Variables defined in the trigger job (default: on)"
        />
        <CheckboxRow
          checked={pipelineVars}
          onChange={() => patch({ pipeline_variables: !pipelineVars })}
          label="Pipeline variables"
          hint="Variables from manual runs and schedules (default: off)"
        />
      </div>
    </CardField>
  );
}

function TriggerArrowIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 13 L13 3 M7 3 H13 V9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChildPipelineIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={3} r={1.5} fill="currentColor" />
      <circle cx={4} cy={12} r={1.5} fill="currentColor" />
      <circle cx={12} cy={12} r={1.5} fill="currentColor" />
      <path d="M8 4.5 L4 10.5 M8 4.5 L12 10.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}
function MultiProjectIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <rect x={1} y={3} width={6} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <rect x={9} y={7} width={6} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M5 9 L9 11" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}
function ProjectIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <rect x={2} y={4} width={12} height={10} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M2 4 L6 4 L7 2 H10 L11 4 H14" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={4} cy={3} r={1.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={4} cy={13} r={1.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={12} cy={8} r={1.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M4 4.5 V11.5 M4 8 c4 0 5 0 6.5 -2" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 1.5 H10 L13 4.5 V14.5 H3 Z M10 1.5 V4.5 H13" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

// ---------- start_in field ----------

const START_IN_PRESETS: { label: string; value: string }[] = [
  { label: '30 sec', value: '30 seconds' },
  { label: '5 min', value: '5 minutes' },
  { label: '30 min', value: '30 minutes' },
  { label: '1 hour', value: '1 hour' },
  { label: '1 day', value: '1 day' },
];

function StartInField({
  value, onChange, disabled,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const parsed = value ? parseDuration(value) : null;
  const parseFailed = !!value && !parsed;

  function commit(v: string) { onChange(v ? v : undefined); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        padding: '6px 10px',
        fontSize: 10,
        background: 'rgba(110,73,203,0.06)',
        border: '1px solid rgba(110,73,203,0.25)',
        borderLeft: '3px solid #6e49cb',
        borderRadius: 4,
        color: 'var(--vscode-foreground)',
        lineHeight: 1.4,
      }}>
        Used together with <code style={inlineKbdStyle}>when: delayed</code> — the job is scheduled to start this long after it is triggered.
      </div>

      <div style={{
        display: 'flex', alignItems: 'center',
        border: `1px solid ${parseFailed ? 'rgba(221,43,14,0.5)' : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={{
          padding: '0 8px', height: 26,
          display: 'inline-flex', alignItems: 'center',
          background: parseFailed ? 'rgba(221,43,14,0.10)' : 'rgba(110,73,203,0.10)',
          color: parseFailed ? '#dd2b0e' : '#6e49cb',
          borderRight: `1px solid ${parseFailed ? 'rgba(221,43,14,0.30)' : 'var(--vscode-panel-border, #444)'}`,
        }}>
          <HourglassIcon />
        </span>
        <input
          disabled={disabled}
          type="text"
          value={value}
          onChange={(e) => commit(e.target.value)}
          placeholder="30 minutes"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 8px',
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
          }}
        />
        {parsed && (
          <span style={{
            padding: '0 8px', height: 26,
            display: 'inline-flex', alignItems: 'center',
            fontSize: 10, fontWeight: 600,
            color: '#108548',
            background: 'rgba(16,133,72,0.08)',
            borderLeft: '1px solid var(--vscode-panel-border, #444)',
          }}>≈ {parsed.pretty}</span>
        )}
      </div>

      {parseFailed && (
        <div style={{ fontSize: 10, color: '#dd2b0e', lineHeight: 1.4 }}>
          Can't parse delay. Try formats like <code style={inlineKbdStyle}>30 minutes</code> or <code style={inlineKbdStyle}>1h 30m</code>.
        </div>
      )}

      {!disabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {START_IN_PRESETS.map((p) => {
            const active = parsed && parseDuration(p.value)?.seconds === parsed.seconds;
            return (
              <button
                key={p.value}
                onClick={() => commit(p.value)}
                style={{
                  padding: '2px 8px',
                  fontSize: 10, fontWeight: 600,
                  background: active ? 'rgba(110,73,203,0.18)' : 'transparent',
                  color: active ? '#6e49cb' : 'var(--vscode-descriptionForeground)',
                  border: `1px solid ${active ? 'rgba(110,73,203,0.50)' : 'var(--vscode-panel-border, #444)'}`,
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontFamily: 'var(--vscode-font-family)',
                }}
                title={`Delay ${p.value}`}
              >{p.label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HourglassIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M4 2 H12 V5 L8 8 L12 11 V14 H4 V11 L8 8 L4 5 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  );
}

// ---------- tags editor ----------

// Common runner-tag suggestions seen in real .gitlab-ci.yml files. Used as quick-add chips.
const COMMON_TAG_SUGGESTIONS = [
  'docker', 'shell', 'kubernetes',
  'linux', 'macos', 'windows',
  'amd64', 'arm64',
  'gpu', 'saas-linux-small-amd64', 'saas-linux-medium-amd64', 'saas-linux-large-amd64',
];

function TagsEditor({
  value, onChange, disabled, ctx,
}: { value: unknown[]; onChange: (v: unknown) => void; disabled?: boolean; ctx?: PipelineCtx }) {
  const list = value.map((v) => String(v ?? '')).filter((s) => s.length > 0 || s === '');
  const referenced = new Set(list);

  // Tags actually in use elsewhere in this pipeline — most useful auto-completion source.
  const inPipeline = ctx
    ? Array.from(new Set(ctx.jobs.flatMap((j) => ((j as unknown as { tags?: unknown }).tags as unknown) as string[] ?? [])))
        .filter((t): t is string => typeof t === 'string' && t.length > 0 && !referenced.has(t))
    : [];

  const commonSuggestions = COMMON_TAG_SUGGESTIONS.filter((t) => !referenced.has(t) && !inPipeline.includes(t));

  const [newTag, setNewTag] = useState('');

  function commit(next: string[]) {
    onChange(next.length === 0 ? undefined : next);
  }
  function add(t: string) {
    const trimmed = t.trim();
    if (!trimmed || referenced.has(trimmed)) return;
    commit([...list, trimmed]);
    setNewTag('');
  }
  function removeAt(i: number) {
    const next = list.slice();
    next.splice(i, 1);
    commit(next);
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<TagsIcon />} title="Runner tags" color="#108548" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Selected chips */}
        <div>
          <label style={varSubLabelStyle}>Selected</label>
          <div style={{
            marginTop: 4,
            padding: 6,
            minHeight: 32,
            border: '1px dashed var(--vscode-panel-border, #444)',
            borderRadius: 4,
            display: 'flex', flexWrap: 'wrap', gap: 4,
            alignItems: 'center',
          }}>
            {list.length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '2px 4px' }}>
                No tags — runs on any compatible runner.
              </span>
            )}
            {list.map((t, i) => (
              <span key={i} style={tagSelectedChipStyle} title={`Tag: ${t}`}>
                <TagSingleIcon />
                <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>{t}</span>
                {!disabled && <ChipX onClick={() => removeAt(i)} />}
              </span>
            ))}
            {!disabled && (
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ' && newTag.trim()) {
                    e.preventDefault();
                    add(newTag);
                  } else if (e.key === 'Backspace' && !newTag && list.length > 0) {
                    e.preventDefault();
                    removeAt(list.length - 1);
                  }
                }}
                placeholder={list.length === 0 ? 'Type tag, press Enter…' : ''}
                spellCheck={false}
                style={{
                  flex: 1, minWidth: 80,
                  padding: '2px 4px', height: 22,
                  background: 'transparent',
                  color: 'var(--vscode-input-foreground)',
                  border: 'none', outline: 'none',
                  fontSize: 12,
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            )}
          </div>
          <div style={{ fontSize: 9, opacity: 0.55, marginTop: 3, fontFamily: 'var(--vscode-font-family)' }}>
            Job runs only on runners that have <strong>all</strong> selected tags.
          </div>
        </div>

        {/* Suggestions */}
        {!disabled && (inPipeline.length > 0 || commonSuggestions.length > 0) && (
          <div>
            <label style={varSubLabelStyle}>Add from</label>
            {inPipeline.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 9, opacity: 0.6, marginBottom: 3, fontFamily: 'var(--vscode-font-family)' }}>Used elsewhere in this pipeline</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {inPipeline.map((t) => (
                    <button
                      key={t}
                      onClick={() => add(t)}
                      style={tagSuggestionChipStyle('#108548')}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(16,133,72,0.18)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                    >
                      <PlusIconTiny /> <code>{t}</code>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {commonSuggestions.length > 0 && (
              <div style={{ marginTop: inPipeline.length > 0 ? 6 : 4 }}>
                <div style={{ fontSize: 9, opacity: 0.6, marginBottom: 3, fontFamily: 'var(--vscode-font-family)' }}>Common runner tags</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {commonSuggestions.map((t) => (
                    <button
                      key={t}
                      onClick={() => add(t)}
                      style={tagSuggestionChipStyle('#888')}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                    >
                      <PlusIconTiny /> <code>{t}</code>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const tagSelectedChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 4px 3px 8px',
  fontSize: 11,
  color: '#108548',
  background: 'rgba(16,133,72,0.10)',
  border: '1px solid rgba(16,133,72,0.40)',
  borderRadius: 10,
  whiteSpace: 'nowrap',
};

function tagSuggestionChipStyle(color: string): React.CSSProperties {
  return {
    padding: '2px 8px',
    fontSize: 10, fontWeight: 600,
    background: 'transparent',
    color,
    border: `1px dashed ${color === '#888' ? 'var(--vscode-panel-border, #444)' : `${color}66`}`,
    borderRadius: 10,
    cursor: 'pointer',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    display: 'inline-flex', alignItems: 'center', gap: 3,
    transition: 'background 80ms ease',
  };
}

function PlusIconTiny() {
  return <svg width={8} height={8} viewBox="0 0 12 12" aria-hidden><path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>;
}
function TagSingleIcon() {
  return (
    <svg width={9} height={9} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 2 H8 L14 8 L8 14 L2 8 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={5} cy={5} r={1} fill="currentColor" />
    </svg>
  );
}
function TagsIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 4 H7 L13.5 10.5 L9.5 14.5 L3 8 V4 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={4.5} cy={6} r={1} fill="currentColor" />
      <path d="M5 1.5 H9 L14.5 7 L12 9.5" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round" opacity={0.5} />
    </svg>
  );
}

// ---------- secrets editor ----------

type SecretProvider = 'vault' | 'azure_key_vault' | 'gcp_secret_manager' | 'aws_secrets_manager' | 'gitlab_secrets_manager';

const SECRET_PROVIDERS: { id: SecretProvider; label: string; color: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'vault', label: 'Vault', color: '#000000', hint: 'HashiCorp Vault', icon: <VaultGlyph /> },
  { id: 'azure_key_vault', label: 'Azure', color: '#0078d4', hint: 'Azure Key Vault', icon: <AzureGlyph /> },
  { id: 'gcp_secret_manager', label: 'GCP', color: '#1f75cb', hint: 'Google Cloud Secret Manager (requires token)', icon: <CloudIcon /> },
  { id: 'aws_secrets_manager', label: 'AWS', color: '#ff9900', hint: 'AWS Secrets Manager', icon: <AwsGlyph /> },
  { id: 'gitlab_secrets_manager', label: 'GitLab', color: '#fc6d26', hint: 'GitLab Secrets Manager', icon: <GitLabGlyph /> },
];

function VaultGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" /><circle cx={6} cy={6} r={1.5} fill="currentColor" /></svg>; }
function AzureGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M5 2 L10 10 H6 L4 7 Z M2 10 L4 6" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" /></svg>; }
function AwsGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 5 L4 9 L6 5 L8 9 L10 5" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" /><path d="M2 11 H10" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" /></svg>; }
function GitLabGlyph() { return <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M6 11 L1 7 L2 4 L3 7 H9 L10 4 L11 7 Z" fill="currentColor" stroke="currentColor" strokeWidth={0.8} strokeLinejoin="round" /></svg>; }

function detectProvider(entry: Record<string, unknown>): SecretProvider | null {
  for (const p of SECRET_PROVIDERS) {
    if (p.id in entry) return p.id;
  }
  return null;
}

function SecretsEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  const entries = Object.entries(value).map(([k, raw]) => {
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    return { name: k, raw: obj, provider: detectProvider(obj) };
  });

  function commit(next: { name: string; raw: Record<string, unknown> }[]) {
    const out: Record<string, unknown> = {};
    for (const e of next) {
      if (!e.name) continue;
      out[e.name] = e.raw;
    }
    onChange(Object.keys(out).length === 0 ? undefined : out);
  }
  function update(i: number, raw: Record<string, unknown>) {
    const next = entries.slice();
    next[i] = { ...next[i], raw, provider: detectProvider(raw) };
    commit(next);
  }
  function rename(i: number, name: string) {
    const next = entries.slice();
    next[i] = { ...next[i], name };
    commit(next);
  }
  function remove(i: number) {
    const next = entries.slice();
    next.splice(i, 1);
    commit(next);
  }
  function add() {
    const base = 'MY_SECRET';
    let k = base; let n = 1;
    while (entries.some((e) => e.name === k)) { k = `${base}_${n++}`; }
    commit([...entries, { name: k, raw: { vault: '' } }]);
  }
  function setProvider(i: number, provider: SecretProvider) {
    const cur = { ...entries[i].raw };
    // Strip other providers
    for (const p of SECRET_PROVIDERS) {
      if (p.id !== provider) delete cur[p.id];
    }
    // Seed default shape if not present
    if (!(provider in cur)) {
      cur[provider] = provider === 'vault' || provider === 'aws_secrets_manager' ? '' : {};
    }
    // GCP requires token — seed empty if missing
    if (provider === 'gcp_secret_manager' && typeof cur.token !== 'string') cur.token = '';
    update(i, cur);
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<ShieldIcon />} title="Secrets" color="#dd2b0e" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
            No secrets defined. Each entry pulls a value from an external secret store and injects it as an environment variable or file.
          </div>
        ) : (
          entries.map((e, i) => (
            <SecretCard
              key={i}
              entry={e}
              disabled={disabled}
              onRename={(n) => rename(i, n)}
              onChange={(raw) => update(i, raw)}
              onSetProvider={(p) => setProvider(i, p)}
              onRemove={() => remove(i)}
            />
          ))
        )}
        {!disabled && (
          <button
            onClick={add}
            style={{
              alignSelf: 'flex-start',
              padding: '5px 10px', fontSize: 11, fontWeight: 600,
              background: 'rgba(221,43,14,0.08)', color: '#dd2b0e',
              border: '1px solid rgba(221,43,14,0.30)', borderRadius: 4,
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: 'var(--vscode-font-family)',
            }}
          >
            <PlusIconSmall /> Add secret
          </button>
        )}
      </div>
    </div>
  );
}

function SecretCard({
  entry, disabled, onRename, onChange, onSetProvider, onRemove,
}: {
  entry: { name: string; raw: Record<string, unknown>; provider: SecretProvider | null };
  disabled?: boolean;
  onRename: (n: string) => void;
  onChange: (raw: Record<string, unknown>) => void;
  onSetProvider: (p: SecretProvider) => void;
  onRemove: () => void;
}) {
  const { name, raw, provider } = entry;
  const providerMeta = SECRET_PROVIDERS.find((p) => p.id === provider);
  const accent = providerMeta?.color ?? '#888';
  const fileMode = raw.file === false ? 'variable' : 'file';
  const token = typeof raw.token === 'string' ? raw.token : '';

  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...raw, ...p };
    for (const k of deleteKeys) delete next[k];
    onChange(next);
  }

  return (
    <div style={{
      padding: 8,
      background: `${accent}0c`,
      border: `1px solid ${accent}33`,
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {/* Name + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden style={{
          width: 22, height: 22, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: `${accent}1f`, color: accent,
          border: `1px solid ${accent}55`, borderRadius: 4,
        }}>
          <ShieldIcon />
        </span>
        <input
          disabled={disabled}
          type="text"
          value={name}
          onChange={(e) => onRename(e.target.value)}
          placeholder="MY_SECRET"
          spellCheck={false}
          style={{ ...glInputStyle, height: 24, flex: 1, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
        />
        <span style={{
          fontSize: 10, color: 'var(--vscode-descriptionForeground)',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          padding: '2px 6px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: 3, whiteSpace: 'nowrap',
        }} title={fileMode === 'file' ? 'Injected as a path to a file (default)' : 'Injected as an env var value'}>
          {fileMode === 'file' ? '$path' : '$env'}
        </span>
        {!disabled && (
          <button onClick={onRemove} title="Remove secret" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        )}
      </div>

      {/* Provider picker */}
      <div>
        <label style={varSubLabelStyle}>Provider</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {SECRET_PROVIDERS.map((p) => {
            const active = provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => !disabled && onSetProvider(p.id)}
                disabled={disabled}
                title={p.hint}
                style={{
                  padding: '3px 9px',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: active ? `${p.color}1f` : 'transparent',
                  color: active ? p.color : 'var(--vscode-descriptionForeground)',
                  border: `1px solid ${active ? `${p.color}66` : 'var(--vscode-panel-border, #444)'}`,
                  borderRadius: 10,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--vscode-font-family)',
                  fontSize: 10, fontWeight: 600,
                }}
              >
                <span style={{ color: p.color, display: 'inline-flex' }}>{p.icon}</span>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Provider-specific body */}
      {provider && <ProviderBody provider={provider} raw={raw} accent={accent} disabled={disabled} onPatch={patch} />}

      {/* Quick row: file/variable mode + token (if GCP) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <FieldInline label="Injected as">
          <div style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, overflow: 'hidden' }}>
            <ModeBtn active={fileMode === 'file'} onClick={() => patch({}, ['file'])}>file (default)</ModeBtn>
            <ModeBtn active={fileMode === 'variable'} onClick={() => patch({ file: false })}>variable</ModeBtn>
          </div>
        </FieldInline>
        {(provider === 'gcp_secret_manager' || token) && (
          <FieldInline label={`Token${provider === 'gcp_secret_manager' ? ' *' : ''}`} grow>
            <input
              disabled={disabled}
              type="text"
              value={token}
              onChange={(e) => patch(e.target.value ? { token: e.target.value } : {}, e.target.value ? [] : ['token'])}
              placeholder="$ID_TOKEN_VAR"
              spellCheck={false}
              style={{
                ...glInputStyle, height: 24,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                borderColor: provider === 'gcp_secret_manager' && !token ? 'rgba(193,125,16,0.50)' : undefined,
              }}
            />
          </FieldInline>
        )}
      </div>
      {provider === 'gcp_secret_manager' && !token && (
        <div style={{ fontSize: 10, color: '#c17d10', lineHeight: 1.4 }}>
          GCP Secret Manager requires a JWT <code style={inlineKbdStyle}>token</code> referencing an <code style={inlineKbdStyle}>id_tokens</code> entry.
        </div>
      )}
    </div>
  );
}

function ProviderBody({
  provider, raw, disabled, onPatch,
}: { provider: SecretProvider; raw: Record<string, unknown>; accent: string; disabled?: boolean; onPatch: (p: Record<string, unknown>, deleteKeys?: string[]) => void }) {
  const v = raw[provider];

  if (provider === 'vault') {
    if (typeof v === 'string' || v === undefined || v === null) {
      return (
        <CardField label="Vault path" hint='e.g. "production/db/password@ops"'>
          <input
            disabled={disabled}
            type="text"
            value={typeof v === 'string' ? v : ''}
            onChange={(e) => onPatch({ vault: e.target.value })}
            placeholder="production/db/password@ops"
            spellCheck={false}
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
      );
    }
    // Object form
    const obj = v as Record<string, unknown>;
    const engine = obj.engine as Record<string, unknown> | undefined;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <CardField label="Path" hint="Secret path inside the engine">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.path === 'string' ? obj.path : ''}
            onChange={(e) => onPatch({ vault: { ...obj, path: e.target.value } })}
            placeholder="production/db"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
        <CardField label="Field" hint="Key inside the secret to read">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.field === 'string' ? obj.field : ''}
            onChange={(e) => onPatch({ vault: { ...obj, field: e.target.value } })}
            placeholder="password"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
        <div style={{ display: 'flex', gap: 6 }}>
          <FieldInline label="Engine name" grow>
            <input
              disabled={disabled}
              type="text"
              value={engine && typeof engine.name === 'string' ? engine.name : ''}
              onChange={(e) => onPatch({ vault: { ...obj, engine: { ...(engine ?? {}), name: e.target.value } } })}
              placeholder="kv-v2"
              style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
            />
          </FieldInline>
          <FieldInline label="Engine path" grow>
            <input
              disabled={disabled}
              type="text"
              value={engine && typeof engine.path === 'string' ? engine.path : ''}
              onChange={(e) => onPatch({ vault: { ...obj, engine: { ...(engine ?? {}), path: e.target.value } } })}
              placeholder="ops"
              style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
            />
          </FieldInline>
        </div>
      </div>
    );
  }

  if (provider === 'azure_key_vault') {
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <FieldInline label="Secret name *" grow>
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.name === 'string' ? obj.name : ''}
            onChange={(e) => onPatch({ azure_key_vault: { ...obj, name: e.target.value } })}
            placeholder="my-secret"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </FieldInline>
        <FieldInline label="Version">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.version === 'string' ? obj.version : ''}
            onChange={(e) => {
              const next = { ...obj };
              if (e.target.value) next.version = e.target.value; else delete next.version;
              onPatch({ azure_key_vault: next });
            }}
            placeholder="(latest)"
            style={{ ...glInputStyle, height: 24, width: 140, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </FieldInline>
      </div>
    );
  }

  if (provider === 'gcp_secret_manager') {
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <FieldInline label="Secret name *" grow>
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.name === 'string' ? obj.name : ''}
            onChange={(e) => onPatch({ gcp_secret_manager: { ...obj, name: e.target.value } })}
            placeholder="projects/my-project/secrets/my-secret"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </FieldInline>
        <FieldInline label="Version">
          <input
            disabled={disabled}
            type="text"
            value={obj.version === undefined || obj.version === null ? '' : String(obj.version)}
            onChange={(e) => {
              const next = { ...obj };
              if (e.target.value) next.version = e.target.value; else delete next.version;
              onPatch({ gcp_secret_manager: next });
            }}
            placeholder="latest"
            style={{ ...glInputStyle, height: 24, width: 100, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </FieldInline>
      </div>
    );
  }

  if (provider === 'aws_secrets_manager') {
    if (typeof v === 'string' || v === undefined || v === null) {
      return (
        <CardField label="Secret ARN or name" hint="String form — most common">
          <input
            disabled={disabled}
            type="text"
            value={typeof v === 'string' ? v : ''}
            onChange={(e) => onPatch({ aws_secrets_manager: e.target.value })}
            placeholder="arn:aws:secretsmanager:us-east-1:..."
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
      );
    }
    const obj = v as Record<string, unknown>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CardField label="Secret ID *" hint="ARN or name">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.secret_id === 'string' ? obj.secret_id : ''}
            onChange={(e) => onPatch({ aws_secrets_manager: { ...obj, secret_id: e.target.value } })}
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
        <div style={{ display: 'flex', gap: 6 }}>
          <FieldInline label="Region" grow>
            <input disabled={disabled} type="text" value={typeof obj.region === 'string' ? obj.region : ''}
              onChange={(e) => onPatch({ aws_secrets_manager: { ...obj, region: e.target.value || undefined } })}
              placeholder="us-east-1"
              style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }} />
          </FieldInline>
          <FieldInline label="Field" grow>
            <input disabled={disabled} type="text" value={typeof obj.field === 'string' ? obj.field : ''}
              onChange={(e) => onPatch({ aws_secrets_manager: { ...obj, field: e.target.value || undefined } })}
              placeholder="password"
              style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }} />
          </FieldInline>
        </div>
      </div>
    );
  }

  if (provider === 'gitlab_secrets_manager') {
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CardField label="Secret name *" hint="Letters, digits, underscores">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.name === 'string' ? obj.name : ''}
            onChange={(e) => onPatch({ gitlab_secrets_manager: { ...obj, name: e.target.value } })}
            placeholder="MY_SECRET"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
        <CardField label="Source" hint="Defaults to current project">
          <input
            disabled={disabled}
            type="text"
            value={typeof obj.source === 'string' ? obj.source : ''}
            onChange={(e) => onPatch({ gitlab_secrets_manager: { ...obj, source: e.target.value || undefined } })}
            placeholder="group/my-group"
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
        </CardField>
      </div>
    );
  }
  return null;
}

function ShieldIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 L13.5 4 V8 c0 3.5 -2.5 5.5 -5.5 6.5 c-3 -1 -5.5 -3 -5.5 -6.5 V4 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <path d="M5.5 8 L7.5 10 L11 6" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- hooks editor ----------

// Job lifecycle hooks defined by the GitLab schema. Add new ones here as GitLab introduces them.
const HOOK_DEFS: { key: string; label: string; hint: string; phase: string }[] = [
  {
    key: 'pre_get_sources_script',
    label: 'pre_get_sources_script',
    hint: 'Runs before the git clone — use this for SSH key setup, git config, proxy auth, etc.',
    phase: 'pre-clone',
  },
];

// Visual representation of the job execution lifecycle. Highlights where hooks fire.
const LIFECYCLE_PHASES: { id: string; label: string; isHook?: boolean }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'pre-clone', label: 'pre_get_sources_script', isHook: true },
  { id: 'clone', label: 'Git clone' },
  { id: 'before', label: 'before_script' },
  { id: 'script', label: 'script' },
  { id: 'after', label: 'after_script' },
  { id: 'upload', label: 'Upload artifacts' },
];

function HooksEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  function patch(p: Record<string, unknown>, deleteKeys: string[] = []) {
    const next = { ...value, ...p };
    for (const k of deleteKeys) delete next[k];
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }

  const presentKeys = new Set(Object.keys(value));
  const knownPresent = HOOK_DEFS.filter((h) => presentKeys.has(h.key));
  const knownAvailable = HOOK_DEFS.filter((h) => !presentKeys.has(h.key));
  // Preserve unknown keys (future-compat with new hook types)
  const unknownKeys = Object.keys(value).filter((k) => !HOOK_DEFS.some((h) => h.key === k));

  const activePhases = new Set<string>(knownPresent.map((h) => h.phase));

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<HookIcon />} title="Hooks" color="#6e49cb" />

      {/* Lifecycle diagram */}
      <LifecycleDiagram active={activePhases} />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {knownPresent.length === 0 && unknownKeys.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
            No hooks configured. Add one to inject commands at specific points in the job lifecycle.
          </div>
        ) : (
          <>
            {knownPresent.map((h) => {
              const raw = value[h.key];
              const lines: string[] = Array.isArray(raw)
                ? (raw as unknown[]).map((x) => typeof x === 'string' ? x : String(x ?? ''))
                : typeof raw === 'string'
                ? [raw]
                : [];
              return (
                <HookRow
                  key={h.key}
                  hook={h}
                  lines={lines}
                  disabled={disabled}
                  onChange={(next) => {
                    if (next.length === 0) patch({}, [h.key]);
                    else if (next.length === 1) patch({ [h.key]: next[0] });
                    else patch({ [h.key]: next });
                  }}
                  onRemove={() => patch({}, [h.key])}
                />
              );
            })}
            {unknownKeys.map((k) => (
              <HookRow
                key={k}
                hook={{ key: k, label: k, hint: 'Custom hook key (preserved as-is)', phase: 'other' }}
                lines={(() => {
                  const raw = value[k];
                  return Array.isArray(raw)
                    ? (raw as unknown[]).map((x) => String(x ?? ''))
                    : typeof raw === 'string' ? [raw] : [];
                })()}
                disabled={disabled}
                onChange={(next) => {
                  if (next.length === 0) patch({}, [k]);
                  else if (next.length === 1) patch({ [k]: next[0] });
                  else patch({ [k]: next });
                }}
                onRemove={() => patch({}, [k])}
              />
            ))}
          </>
        )}

        {!disabled && knownAvailable.length > 0 && (
          <HookAddMenu options={knownAvailable} onAdd={(k) => patch({ [k]: [''] })} />
        )}
      </div>
    </div>
  );
}

function HookRow({
  hook, lines, onChange, onRemove, disabled,
}: {
  hook: { key: string; label: string; hint: string; phase: string };
  lines: string[];
  onChange: (next: string[]) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{
      padding: 8,
      background: 'rgba(110,73,203,0.06)',
      border: '1px solid rgba(110,73,203,0.25)',
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span aria-hidden style={{
          width: 22, height: 22, flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(110,73,203,0.16)', color: '#6e49cb',
          border: '1px solid rgba(110,73,203,0.40)', borderRadius: 4,
        }}>
          <HookIcon />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: 12, fontWeight: 700, color: '#6e49cb',
          }}>{hook.label}</div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, lineHeight: 1.4 }}>{hook.hint}</div>
        </div>
        {!disabled && (
          <button onClick={onRemove} title="Remove hook" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      {/* Reuse the existing shell-step editor for command list */}
      <ShellLinesEditor value={lines} onChange={(v) => onChange((v as unknown[]).map((x) => String(x ?? '')))} disabled={disabled} />
    </div>
  );
}

function HookAddMenu({
  options, onAdd,
}: { options: { key: string; label: string; hint: string; phase: string }[]; onAdd: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [open]);
  // When only one option, render as a single direct-add button instead of a dropdown.
  if (options.length === 1) {
    const o = options[0];
    return (
      <button
        onClick={() => onAdd(o.key)}
        style={addHookBtnStyle}
        title={o.hint}
      >
        <PlusIconSmall /> Add <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{o.label}</code> hook
      </button>
    );
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((v) => !v)} style={addHookBtnStyle}>
        <PlusIconSmall /> Add hook
      </button>
      {open && (
        <div style={{ ...popoverStyle, top: 'calc(100% + 4px)', left: 0, right: 'auto', minWidth: 280, maxHeight: 260 }}>
          {options.map((o) => (
            <button
              key={o.key}
              onClick={() => { onAdd(o.key); setOpen(false); }}
              style={{ ...pickItemStyle, fontFamily: 'var(--vscode-font-family)' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
            >
              <div style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--vscode-editor-font-family, monospace)', color: '#6e49cb' }}>{o.label}</div>
              <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1, fontFamily: 'var(--vscode-font-family)' }}>{o.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const addHookBtnStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '5px 10px', fontSize: 11, fontWeight: 600,
  background: 'rgba(110,73,203,0.08)', color: '#6e49cb',
  border: '1px solid rgba(110,73,203,0.30)', borderRadius: 4,
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 5,
  fontFamily: 'var(--vscode-font-family)',
};

function LifecycleDiagram({ active }: { active: Set<string> }) {
  return (
    <div style={{
      padding: '8px 12px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      background: 'rgba(110,73,203,0.04)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)',
      }}>Job lifecycle</div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0,
      }}>
        {LIFECYCLE_PHASES.map((phase, i) => {
          const isHook = phase.isHook;
          const isActive = active.has(phase.id);
          const color = isHook
            ? isActive ? '#6e49cb' : '#888'
            : 'var(--vscode-descriptionForeground)';
          return (
            <span key={phase.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
              <span
                title={isHook ? `Hook${isActive ? ' (active)' : ' (available)'}` : 'Job step'}
                style={{
                  padding: '2px 6px',
                  fontSize: 9, fontWeight: isHook ? 700 : 500,
                  fontFamily: isHook ? 'var(--vscode-editor-font-family, monospace)' : 'var(--vscode-font-family)',
                  color,
                  background: isHook
                    ? isActive ? 'rgba(110,73,203,0.18)' : 'transparent'
                    : 'transparent',
                  border: isHook
                    ? `1px ${isActive ? 'solid' : 'dashed'} ${isActive ? 'rgba(110,73,203,0.50)' : 'rgba(255,255,255,0.18)'}`
                    : 'none',
                  borderRadius: 8,
                  opacity: isHook ? 1 : 0.7,
                }}
              >{phase.label}</span>
              {i < LIFECYCLE_PHASES.length - 1 && (
                <span style={{ opacity: 0.4, fontSize: 9, padding: '0 3px' }}>›</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function HookIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1 V7 a3 3 0 0 1 -3 3 a3 3 0 0 1 -3 -3" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
      <circle cx={8} cy={1.5} r={1.2} fill="currentColor" />
    </svg>
  );
}

// ---------- run editor (structured steps) ----------

type RunStep = {
  name?: string;
  script?: string;
  step?: unknown;   // string or { git: { url, rev, ... } }
  func?: unknown;
  env?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  [k: string]: unknown;
};

function classifyStep(s: RunStep): 'script' | 'reference' | 'empty' {
  if (typeof s.script === 'string' && s.script.length > 0) return 'script';
  if (s.step !== undefined || s.func !== undefined) return 'reference';
  return 'empty';
}

function stepRefDisplay(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    const g = (ref as Record<string, unknown>).git;
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      const url = (g as Record<string, unknown>).url;
      const rev = (g as Record<string, unknown>).rev;
      if (typeof url === 'string') return `${url}${typeof rev === 'string' ? `@${rev}` : ''}`;
    }
  }
  return '';
}

function RunEditor({
  value, onChange, disabled,
}: { value: unknown[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  const steps: RunStep[] = value.map((v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v as RunStep : {});
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function commit(next: RunStep[]) {
    onChange(next.length === 0 ? undefined : next);
  }
  function update(i: number, patch: Partial<RunStep>, deleteKeys: (keyof RunStep)[] = []) {
    const next = steps.slice();
    const merged = { ...next[i], ...patch };
    for (const k of deleteKeys) delete (merged as Record<string, unknown>)[k as string];
    next[i] = merged;
    commit(next);
  }
  function remove(i: number) {
    const next = steps.slice();
    next.splice(i, 1);
    commit(next);
    if (expandedIdx === i) setExpandedIdx(null);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }
  function addStep(kind: 'script' | 'reference') {
    const base = 'step';
    let n = steps.length + 1;
    let name = `${base}_${n}`;
    while (steps.some((s) => s.name === name)) { n++; name = `${base}_${n}`; }
    const newStep: RunStep = kind === 'script'
      ? { name, script: '' }
      : { name, step: '' };
    commit([...steps, newStep]);
    setExpandedIdx(steps.length);
  }
  function convertTo(i: number, kind: 'script' | 'reference') {
    const cur = steps[i];
    if (kind === 'script') {
      update(i, { script: typeof cur.script === 'string' ? cur.script : '' }, ['step', 'func', 'inputs']);
    } else {
      update(i, { step: typeof cur.step === 'string' ? cur.step : (cur.func ?? '') }, ['script', 'func']);
    }
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<RunIcon />} title="Run steps" color="#0095a8" />

      {steps.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
          No steps yet. <code style={inlineKbdStyle}>run:</code> is an alternative to <code style={inlineKbdStyle}>script:</code> for structured pipeline steps — use one or the other, not both.
        </div>
      ) : (
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {steps.map((s, i) => {
            const kind = classifyStep(s);
            const isExpanded = expandedIdx === i;
            const envCount = s.env && typeof s.env === 'object' ? Object.keys(s.env).length : 0;
            const inputsCount = s.inputs && typeof s.inputs === 'object' ? Object.keys(s.inputs).length : 0;
            const tone = kind === 'script' ? { color: '#0095a8', bg: 'rgba(0,149,168,0.08)', bd: 'rgba(0,149,168,0.30)' }
                       : kind === 'reference' ? { color: '#6e49cb', bg: 'rgba(110,73,203,0.08)', bd: 'rgba(110,73,203,0.30)' }
                       : { color: '#c17d10', bg: 'rgba(193,125,16,0.08)', bd: 'rgba(193,125,16,0.30)' };
            return (
              <div key={i} style={{
                padding: 8,
                background: tone.bg,
                border: `1px solid ${tone.bd}`,
                borderRadius: 4,
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                {/* Step header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    ...ruleBadgeStyle,
                    background: `${tone.color}1c`,
                    color: tone.color,
                    borderColor: `${tone.color}66`,
                  }}>{i + 1}</span>
                  <input
                    disabled={disabled}
                    type="text"
                    value={s.name ?? ''}
                    onChange={(e) => update(i, { name: e.target.value || undefined }, e.target.value ? [] : ['name'])}
                    placeholder="step_name"
                    spellCheck={false}
                    style={{ ...glInputStyle, height: 24, flex: 1, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                  />
                  {/* kind switcher */}
                  {!disabled && (
                    <div style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, overflow: 'hidden' }}>
                      <ModeBtn active={kind === 'script'} onClick={() => convertTo(i, 'script')}>script</ModeBtn>
                      <ModeBtn active={kind === 'reference'} onClick={() => convertTo(i, 'reference')}>ref</ModeBtn>
                    </div>
                  )}
                  {/* Reorder + delete */}
                  {!disabled && (
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" style={{ ...iconBtnStyle, width: 22, height: 22, opacity: i === 0 ? 0.3 : 1 }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 7 L6 4 L9 7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button onClick={() => move(i, 1)} disabled={i === steps.length - 1} title="Move down" style={{ ...iconBtnStyle, width: 22, height: 22, opacity: i === steps.length - 1 ? 0.3 : 1 }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 5 L6 8 L9 5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button onClick={() => remove(i)} title="Delete step" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
                        <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2.5 3.5 H9.5 M4.5 3.5 V2.5 H7.5 V3.5 M3.5 3.5 L4 10 H8 L8.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    </div>
                  )}
                </div>

                {/* Body — script or reference */}
                {kind === 'script' ? (
                  <ScriptStepBody
                    value={typeof s.script === 'string' ? s.script : ''}
                    onChange={(v) => update(i, v ? { script: v } : {}, v ? [] : ['script'])}
                    disabled={disabled}
                  />
                ) : kind === 'reference' ? (
                  <RefStepBody
                    value={s.step !== undefined ? s.step : s.func}
                    field={s.step !== undefined ? 'step' : 'func'}
                    onChange={(v, field) => update(i, { [field]: v } as Partial<RunStep>, field === 'step' ? ['func'] : ['step'])}
                    disabled={disabled}
                  />
                ) : (
                  <div style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic', padding: '4px 0' }}>
                    Choose <code style={inlineKbdStyle}>script</code> or <code style={inlineKbdStyle}>ref</code> above.
                  </div>
                )}

                {/* env + inputs (collapsible) */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                  <button
                    onClick={() => setExpandedIdx(isExpanded ? null : i)}
                    disabled={disabled}
                    style={{
                      background: 'transparent', border: 'none',
                      color: envCount > 0 || inputsCount > 0 ? tone.color : 'var(--vscode-descriptionForeground)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      fontSize: 10, fontWeight: 600,
                      padding: 0,
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontFamily: 'var(--vscode-font-family)',
                    }}
                    title={isExpanded ? 'Hide env / inputs' : 'Edit env / inputs'}
                  >
                    <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden style={{ transition: 'transform 120ms ease', transform: isExpanded ? 'rotate(90deg)' : 'none' }}>
                      <path d="M4 3 L8 6 L4 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    env
                    {envCount > 0 && <MiniBadge label={String(envCount)} />}
                    {kind === 'reference' && (
                      <>
                        <span style={{ opacity: 0.4, margin: '0 4px' }}>·</span>
                        inputs
                        {inputsCount > 0 && <MiniBadge label={String(inputsCount)} />}
                      </>
                    )}
                  </button>
                </div>
                {isExpanded && !disabled && (
                  <div style={{
                    padding: 8, marginTop: 2,
                    background: 'var(--vscode-editor-background)',
                    border: `1px solid ${tone.bd}`,
                    borderRadius: 4,
                    display: 'flex', flexDirection: 'column', gap: 10,
                  }}>
                    <div>
                      <label style={varSubLabelStyle}>Environment</label>
                      <VariablesEditor
                        value={(s.env as Record<string, unknown>) ?? {}}
                        onChange={(v) => update(i, v ? { env: v as Record<string, unknown> } : {}, v ? [] : ['env'])}
                      />
                    </div>
                    {kind === 'reference' && (
                      <div>
                        <label style={varSubLabelStyle}>Inputs</label>
                        <VariablesEditor
                          value={(s.inputs as Record<string, unknown>) ?? {}}
                          onChange={(v) => update(i, v ? { inputs: v as Record<string, unknown> } : {}, v ? [] : ['inputs'])}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!disabled && (
        <div style={{
          display: 'flex', gap: 6, padding: 8,
          borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)',
          background: 'rgba(255,255,255,0.02)',
        }}>
          <button
            onClick={() => addStep('script')}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'rgba(0,149,168,0.08)', color: '#0095a8',
              border: '1px solid rgba(0,149,168,0.30)', borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
              fontFamily: 'var(--vscode-font-family)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            <PlusIconSmall /> Add script step
          </button>
          <button
            onClick={() => addStep('reference')}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'rgba(110,73,203,0.08)', color: '#6e49cb',
              border: '1px solid rgba(110,73,203,0.30)', borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
              fontFamily: 'var(--vscode-font-family)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            <PlusIconSmall /> Add step reference
          </button>
        </div>
      )}
    </div>
  );
}

function ScriptStepBody({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const lines = value ? value.split('\n').length : 1;
  return (
    <div>
      <label style={varSubLabelStyle}>Script</label>
      <textarea
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="echo hello"
        spellCheck={false}
        rows={Math.max(2, Math.min(8, lines + 1))}
        style={{
          width: '100%',
          padding: '6px 8px',
          border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
          borderRadius: 4,
          background: 'var(--vscode-terminal-background, var(--vscode-input-background, #1a1a1a))',
          color: 'var(--vscode-terminal-foreground, var(--vscode-input-foreground, #cccccc))',
          outline: 'none', resize: 'vertical',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          fontSize: 12, lineHeight: 1.5,
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function RefStepBody({
  value, field, onChange, disabled,
}: { value: unknown; field: 'step' | 'func'; onChange: (v: unknown, f: 'step' | 'func') => void; disabled?: boolean }) {
  const stringRef = typeof value === 'string' ? value : '';
  const isGitObject = value !== null && typeof value === 'object' && !Array.isArray(value) && 'git' in (value as Record<string, unknown>);
  // For now we expose string form as the primary editor; git-object form is shown read-only as a hint chip.
  return (
    <div>
      <label style={varSubLabelStyle}>{field === 'step' ? 'Step reference' : 'Function reference'}</label>
      <div style={{
        display: 'flex', alignItems: 'center',
        border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
        borderRadius: 4,
        background: 'var(--vscode-input-background)',
        overflow: 'hidden',
      }}>
        <span aria-hidden style={{
          padding: '0 8px', height: 26,
          display: 'inline-flex', alignItems: 'center',
          background: 'rgba(110,73,203,0.10)', color: '#6e49cb',
          borderRight: '1px solid var(--vscode-panel-border, #444)',
          flex: '0 0 auto',
        }}>
          <RefIcon />
        </span>
        <input
          disabled={disabled || isGitObject}
          type="text"
          value={isGitObject ? stepRefDisplay(value) : stringRef}
          onChange={(e) => onChange(e.target.value || undefined, field)}
          placeholder="gitlab.com/components/foo/foo@1.0"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 8px',
            background: 'transparent',
            color: 'var(--vscode-input-foreground)',
            border: 'none', outline: 'none',
            fontSize: 12,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            boxSizing: 'border-box',
          }}
        />
        {isGitObject && (
          <span style={{
            padding: '0 8px', display: 'inline-flex', alignItems: 'center',
            fontSize: 9, color: 'var(--vscode-descriptionForeground)',
            background: 'rgba(255,255,255,0.04)',
            borderLeft: '1px solid var(--vscode-panel-border, #444)',
          }}>git object (read-only)</span>
        )}
      </div>
    </div>
  );
}

function RunIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 2 L13 8 L3 14 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <line x1={6} y1={5} x2={6} y2={11} stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}
function RefIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={4} cy={4} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={12} cy={12} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M5.5 5.5 L10.5 10.5" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  );
}

// ---------- id_tokens editor ----------

function IdTokensEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  const entries = Object.entries(value).map(([k, raw]) => {
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    const audRaw = obj.aud;
    const aud: string[] = Array.isArray(audRaw)
      ? (audRaw as unknown[]).map((x) => String(x ?? ''))
      : typeof audRaw === 'string'
      ? [audRaw]
      : [];
    const extras = Object.fromEntries(Object.entries(obj).filter(([key]) => key !== 'aud'));
    return { name: k, aud, extras };
  });

  function commit(next: { name: string; aud: string[]; extras: Record<string, unknown> }[]) {
    const out: Record<string, unknown> = {};
    for (const e of next) {
      if (!e.name) continue;
      const audVal = e.aud.length === 1 ? e.aud[0] : e.aud;
      out[e.name] = { aud: audVal, ...e.extras };
    }
    onChange(Object.keys(out).length === 0 ? undefined : out);
  }

  function updateName(i: number, name: string) {
    const next = entries.slice();
    next[i] = { ...next[i], name };
    commit(next);
  }
  function updateAud(i: number, aud: string[]) {
    const next = entries.slice();
    next[i] = { ...next[i], aud };
    commit(next);
  }
  function remove(i: number) {
    const next = entries.slice();
    next.splice(i, 1);
    commit(next);
  }
  function add() {
    const base = 'ID_TOKEN';
    let k = base; let n = 1;
    while (entries.some((e) => e.name === k)) { k = `${base}_${n++}`; }
    commit([...entries, { name: k, aud: [''], extras: {} }]);
  }

  return (
    <div style={chipsBoxStyle}>
      <CardHeader icon={<KeyIcon />} title="ID tokens" color="#108548" />

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
            No tokens defined. Each token is injected as an environment variable with a JWT signed for the chosen audience.
          </div>
        ) : (
          entries.map((e, i) => (
            <div key={i} style={{
              padding: 8,
              border: '1px solid var(--vscode-panel-border, #2d2d2d)',
              borderRadius: 4,
              background: 'var(--vscode-editor-background)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden style={{
                  width: 22, height: 22, flex: '0 0 auto',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(16,133,72,0.12)', color: '#108548',
                  border: '1px solid rgba(16,133,72,0.40)', borderRadius: 4,
                }}>
                  <KeyIcon />
                </span>
                <input
                  disabled={disabled}
                  type="text"
                  value={e.name}
                  onChange={(ev) => updateName(i, ev.target.value)}
                  placeholder="MY_TOKEN"
                  spellCheck={false}
                  style={{ ...glInputStyle, height: 24, flex: 1, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                />
                <span style={{
                  fontSize: 10, color: 'var(--vscode-descriptionForeground)',
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  padding: '2px 6px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--vscode-panel-border, #444)',
                  borderRadius: 3,
                  whiteSpace: 'nowrap',
                }} title="Available as this env var inside the job">$env</span>
                {!disabled && (
                  <button onClick={() => remove(i)} title="Remove token" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
                    <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
                  </button>
                )}
              </div>
              <CardField
                label="Audience"
                hint={e.aud.length > 1 ? 'Multiple audiences allowed' : 'Who the token is signed for (aud claim)'}
              >
                <StringListEditor
                  list={e.aud}
                  onChange={(l) => updateAud(i, l.length === 0 ? [''] : l)}
                  placeholder="https://gitlab.com"
                />
              </CardField>
              {Object.keys(e.extras).length > 0 && (
                <div style={{ fontSize: 10, opacity: 0.55 }}>
                  Preserved extra keys: {Object.keys(e.extras).map((k) => <code key={k} style={inlineKbdStyle}>{k}</code>).reduce((acc, el, idx) => idx === 0 ? [el] : [...acc, ', ', el], [] as React.ReactNode[])}
                </div>
              )}
            </div>
          ))
        )}
        {!disabled && (
          <button
            onClick={add}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              background: 'rgba(16,133,72,0.08)', color: '#108548',
              border: '1px solid rgba(16,133,72,0.30)', borderRadius: 4,
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontFamily: 'var(--vscode-font-family)',
            }}
          >
            <PlusIconSmall /> Add ID token
          </button>
        )}
      </div>
    </div>
  );
}

function KeyIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={5} cy={5} r={3} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M7 7 L13 13 M11 11 L13 9 M12 12 L13.5 10.5" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  );
}

// ---------- retry editor ----------

const RETRY_REASONS: { value: string; label: string; hint: string }[] = [
  { value: 'always', label: 'Any failure', hint: 'Retry on any failure (default)' },
  { value: 'script_failure', label: 'Script failure', hint: 'The job script exited non-zero' },
  { value: 'runner_system_failure', label: 'Runner system', hint: 'Runner setup failed' },
  { value: 'stuck_or_timeout_failure', label: 'Stuck / timeout', hint: 'Job hung or timed out' },
  { value: 'api_failure', label: 'API failure', hint: 'GitLab API error' },
  { value: 'unknown_failure', label: 'Unknown', hint: 'Failure reason not classified' },
  { value: 'runner_unsupported', label: 'Runner unsupported', hint: 'No runner could pick up the job' },
  { value: 'job_execution_timeout', label: 'Exec timeout', hint: 'Hit the job timeout' },
  { value: 'archived_failure', label: 'Archived', hint: 'Job was archived during run' },
  { value: 'scheduler_failure', label: 'Scheduler', hint: 'Scheduler picking failed' },
  { value: 'data_integrity_failure', label: 'Data integrity', hint: 'Data was inconsistent' },
];

function RetryEditor({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const obj = isObject ? (value as Record<string, unknown>) : {};
  const max = typeof value === 'number'
    ? Math.max(0, Math.min(2, value))
    : typeof obj.max === 'number'
    ? Math.max(0, Math.min(2, obj.max))
    : 0;

  const whenRaw = obj.when;
  const whenList: string[] = Array.isArray(whenRaw)
    ? (whenRaw as unknown[]).map((x) => String(x))
    : typeof whenRaw === 'string'
    ? [whenRaw]
    : ['always'];

  const exitCodesRaw = obj.exit_codes;
  const exitCodes: number[] = Array.isArray(exitCodesRaw)
    ? (exitCodesRaw as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : typeof exitCodesRaw === 'number'
    ? [exitCodesRaw]
    : [];

  const [draftCodes, setDraftCodes] = useState(exitCodes.join(', '));
  useEffect(() => { setDraftCodes(exitCodes.join(', ')); }, [JSON.stringify(exitCodes)]);

  function commit(nextMax: number, nextWhen: string[], nextCodes: number[]) {
    if (nextMax === 0) {
      onChange(undefined);
      return;
    }
    const onlyAlways = nextWhen.length === 0 || (nextWhen.length === 1 && nextWhen[0] === 'always');
    if (onlyAlways && nextCodes.length === 0) {
      onChange(nextMax);
      return;
    }
    const out: Record<string, unknown> = { max: nextMax };
    if (!onlyAlways) {
      out.when = nextWhen.length === 1 ? nextWhen[0] : nextWhen;
    }
    if (nextCodes.length > 0) {
      out.exit_codes = nextCodes.length === 1 ? nextCodes[0] : nextCodes;
    }
    // Preserve unknown keys
    for (const [k, v] of Object.entries(obj)) {
      if (!['max', 'when', 'exit_codes'].includes(k)) out[k] = v;
    }
    onChange(out);
  }

  function setMax(n: number) { commit(n, whenList, exitCodes); }
  function toggleWhen(reason: string) {
    if (reason === 'always') {
      commit(max, ['always'], exitCodes);
      return;
    }
    const without = whenList.filter((w) => w !== 'always');
    const next = without.includes(reason) ? without.filter((w) => w !== reason) : [...without, reason];
    commit(max, next.length === 0 ? ['always'] : next, exitCodes);
  }
  function commitExitCodes(text: string) {
    const codes = text
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      .map((s) => Number(s)).filter((n) => Number.isFinite(n));
    commit(max, whenList, codes);
  }

  const accent = max === 0 ? '#666' : max === 1 ? '#1f75cb' : '#fc6d26';
  const [showAdvanced, setShowAdvanced] = useState((whenList.length > 1 || whenList[0] !== 'always') || exitCodes.length > 0);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: 10,
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      background: 'var(--vscode-editor-background)',
    }}>
      {/* Step counter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <RetryIcon color={accent} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: accent }}>
            {max === 0 ? 'No retries' : max === 1 ? 'Retry once on failure' : 'Retry up to 2 times'}
          </div>
          <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.35, marginTop: 1 }}>
            {max === 0
              ? 'The job runs once and fails fast (default).'
              : `Up to ${max + 1} total attempts before the job is marked failed.`}
          </div>
        </div>
        {!disabled && (
          <div style={{
            display: 'inline-flex', alignItems: 'center',
            border: '1px solid var(--vscode-panel-border, #444)',
            borderRadius: 6, overflow: 'hidden', flex: '0 0 auto',
          }}>
            {[0, 1, 2].map((n) => {
              const active = max === n;
              const c = n === 0 ? '#666' : n === 1 ? '#1f75cb' : '#fc6d26';
              return (
                <button
                  key={n}
                  onClick={() => setMax(n)}
                  style={{
                    width: 32, height: 26,
                    background: active ? `${c}24` : 'transparent',
                    color: active ? c : 'var(--vscode-foreground)',
                    border: 'none',
                    borderRight: n === 2 ? 'none' : '1px solid var(--vscode-panel-border, #444)',
                    cursor: 'pointer',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    fontSize: 12, fontWeight: 700,
                    transition: 'background 80ms ease',
                  }}
                  title={n === 0 ? 'No retry' : `Retry ${n} time${n === 1 ? '' : 's'}`}
                >{n}</button>
              );
            })}
          </div>
        )}
      </div>

      {/* When + advanced — only meaningful when max > 0 */}
      {max > 0 && (
        <>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={varSubLabelStyle}>Retry on</span>
              {whenList.length === 1 && whenList[0] === 'always'
                ? <MiniBadge label="any failure" />
                : <MiniBadge label={`${whenList.length} reason${whenList.length === 1 ? '' : 's'}`} />}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {RETRY_REASONS.map((r) => {
                const active = r.value === 'always'
                  ? whenList.length === 1 && whenList[0] === 'always'
                  : whenList.includes(r.value);
                const c = r.value === 'always' ? '#108548' : active ? '#fc6d26' : '#666';
                return (
                  <button
                    key={r.value}
                    onClick={() => !disabled && toggleWhen(r.value)}
                    disabled={disabled}
                    title={r.hint}
                    style={{
                      padding: '3px 9px',
                      fontSize: 10, fontWeight: 600,
                      background: active ? `${c}1f` : 'transparent',
                      color: active ? c : 'var(--vscode-descriptionForeground)',
                      border: `1px solid ${active ? `${c}66` : 'var(--vscode-panel-border, #444)'}`,
                      borderRadius: 10,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--vscode-font-family)',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    {active && r.value !== 'always' && <CheckTinyIcon />}
                    {r.value === 'always' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} aria-hidden />}
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* exit_codes advanced */}
          {!disabled && (
            <div>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: exitCodes.length > 0 ? '#fc6d26' : 'var(--vscode-descriptionForeground)',
                  cursor: 'pointer',
                  fontSize: 10, fontWeight: 600,
                  padding: 0,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontFamily: 'var(--vscode-font-family)',
                }}
              >
                {exitCodes.length > 0 && <MiniBadge label={String(exitCodes.length)} />}
                Retry only on specific exit codes
                <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden>
                  <path d={showAdvanced ? 'M3 7 L6 4 L9 7' : 'M3 5 L6 8 L9 5'} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {showAdvanced && (
                <div style={{
                  marginTop: 6, padding: 8,
                  background: 'rgba(252,109,38,0.06)',
                  border: '1px solid rgba(252,109,38,0.20)',
                  borderRadius: 4,
                }}>
                  <input
                    type="text"
                    value={draftCodes}
                    onChange={(e) => setDraftCodes(e.target.value)}
                    onBlur={(e) => commitExitCodes(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="e.g. 137, 255"
                    spellCheck={false}
                    style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                  />
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, lineHeight: 1.35 }}>
                    Only retries when the script exits with one of these codes. Leave empty to retry on any matching failure type.
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RetryIcon({ color }: { color: string }) {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden style={{ color, flex: '0 0 auto' }}>
      <path d="M16 10 a6 6 0 1 1 -2 -4.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <path d="M15.5 2 V6 H11.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckTinyIcon() {
  return (
    <svg width={8} height={8} viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- interruptible toggle ----------

function InterruptibleToggle({
  value, onChange, disabled,
}: { value: boolean | undefined; onChange: (v: unknown) => void; disabled?: boolean }) {
  const checked = value === true;
  const accent = checked ? '#1f75cb' : '#666';
  return (
    <PajamasToggleCard
      checked={checked}
      accent={accent}
      disabled={disabled}
      onToggle={() => onChange(checked ? undefined : true)}
      thumbGlyph={checked ? <CancelGlyph /> : null}
      title={checked ? 'Interruptible' : 'Runs to completion'}
      hint={checked
        ? 'A newer pipeline on the same ref will cancel this job before it finishes. Good for fast feedback on rapid pushes.'
        : 'This job always runs to completion, even when a newer pipeline starts (default).'}
    />
  );
}

function CancelGlyph() {
  return (
    <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden>
      <circle cx={6} cy={6} r={4.5} fill="none" stroke="white" strokeWidth={1.4} />
      <path d="M3.5 3.5 L8.5 8.5" stroke="white" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

// Reusable Pajamas-style toggle card — switch + status text + hint, no advanced section.
function PajamasToggleCard({
  checked, accent, disabled, onToggle, thumbGlyph, title, hint, rightSlot,
}: {
  checked: boolean;
  accent: string;
  disabled?: boolean;
  onToggle: () => void;
  thumbGlyph?: React.ReactNode;
  title: string;
  hint: string;
  rightSlot?: React.ReactNode;
}) {
  const track = checked ? `${accent}66` : 'var(--vscode-input-background, rgba(255,255,255,0.10))';
  const thumb = checked ? accent : 'var(--vscode-descriptionForeground, #999)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: 10,
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      background: 'var(--vscode-editor-background)',
    }}>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => { if (!disabled) onToggle(); }}
        disabled={disabled}
        title={checked ? 'Turn off' : 'Turn on'}
        style={{
          position: 'relative',
          width: 36, height: 20, flex: '0 0 auto',
          background: track,
          border: `1px solid ${checked ? `${accent}88` : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
          borderRadius: 10,
          cursor: disabled ? 'not-allowed' : 'pointer',
          padding: 0,
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
      >
        <span aria-hidden style={{
          position: 'absolute', top: 1, left: checked ? 17 : 1,
          width: 16, height: 16, borderRadius: '50%',
          background: thumb,
          boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
          transition: 'left 140ms ease, background 120ms ease',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {thumbGlyph}
        </span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: checked ? accent : 'var(--vscode-foreground)' }}>{title}</div>
        <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.35, marginTop: 1 }}>{hint}</div>
      </div>
      {rightSlot}
    </div>
  );
}

// ---------- allow_failure toggle ----------

function AllowFailureToggle({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  // value can be: true | false | undefined | { exit_codes: number | number[] }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const checked = value === true || isObject;
  const exitCodes: number[] = isObject
    ? (() => {
        const ec = (value as Record<string, unknown>).exit_codes;
        if (Array.isArray(ec)) return ec.map((n) => Number(n)).filter((n) => Number.isFinite(n));
        if (typeof ec === 'number') return [ec];
        return [];
      })()
    : [];

  const [showAdvanced, setShowAdvanced] = useState(isObject);
  const [draftCodes, setDraftCodes] = useState(() => exitCodes.join(', '));

  // Sync draft when value changes from outside
  useEffect(() => { setDraftCodes(exitCodes.join(', ')); }, [JSON.stringify(exitCodes)]);

  function toggle() {
    if (disabled) return;
    onChange(checked ? undefined : true);
    if (!checked) setShowAdvanced(false);
  }

  function commitExitCodes(text: string) {
    const codes = text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    if (codes.length === 0) {
      onChange(true);
    } else if (codes.length === 1) {
      onChange({ exit_codes: codes[0] });
    } else {
      onChange({ exit_codes: codes });
    }
  }

  const accent = checked ? '#c17d10' : '#666';
  const track = checked ? 'rgba(193,125,16,0.40)' : 'var(--vscode-input-background, rgba(255,255,255,0.10))';
  const thumb = checked ? '#c17d10' : 'var(--vscode-descriptionForeground, #999)';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 10,
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      background: 'var(--vscode-editor-background)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Pajamas-style sliding toggle */}
        <button
          role="switch"
          aria-checked={checked}
          onClick={toggle}
          disabled={disabled}
          title={checked ? 'Turn off' : 'Turn on'}
          style={{
            position: 'relative',
            width: 36, height: 20, flex: '0 0 auto',
            background: track,
            border: `1px solid ${checked ? `${accent}88` : 'var(--vscode-input-border, var(--vscode-panel-border, #444))'}`,
            borderRadius: 10,
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: 0,
            transition: 'background 120ms ease, border-color 120ms ease',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 1, left: checked ? 17 : 1,
              width: 16, height: 16,
              borderRadius: '50%',
              background: thumb,
              boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
              transition: 'left 140ms ease, background 120ms ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {checked && (
              <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden>
                <path d="M8 1.5 L11 11 L1 11 Z" fill="white" />
              </svg>
            )}
          </span>
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: checked ? accent : 'var(--vscode-foreground)' }}>
            {checked ? 'Failure allowed' : 'Failure blocks pipeline'}
          </div>
          <div style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.35, marginTop: 1 }}>
            {checked
              ? 'The pipeline succeeds even when this job fails. Useful for non-blocking scans or experimental steps.'
              : 'If this job fails the pipeline is marked failed (default).'}
          </div>
        </div>

        {checked && !disabled && (
          <button
            onClick={() => {
              setShowAdvanced((v) => !v);
              if (!showAdvanced && exitCodes.length === 0) setDraftCodes('');
            }}
            title="Specify exit codes that count as 'allowed'"
            style={{
              ...glGhostBtnStyle,
              color: exitCodes.length > 0 ? accent : 'var(--vscode-descriptionForeground)',
              borderColor: exitCodes.length > 0 ? `${accent}55` : 'var(--vscode-panel-border, #444)',
              padding: '3px 8px', fontSize: 10,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            {exitCodes.length > 0 && <MiniBadge label={String(exitCodes.length)} />}
            exit codes
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden>
              <path d={showAdvanced ? 'M3 7 L6 4 L9 7' : 'M3 5 L6 8 L9 5'} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {checked && showAdvanced && !disabled && (
        <div style={{
          padding: 8,
          background: 'rgba(193,125,16,0.06)',
          border: '1px solid rgba(193,125,16,0.20)',
          borderRadius: 4,
        }}>
          <label style={varSubLabelStyle}>Allowed exit codes</label>
          <input
            type="text"
            value={draftCodes}
            onChange={(e) => setDraftCodes(e.target.value)}
            onBlur={(e) => commitExitCodes(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="e.g. 137, 255"
            spellCheck={false}
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, lineHeight: 1.35 }}>
            Only failures with these exit codes will be allowed. Leave empty to allow any failure.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- variables: editor ----------

type VarEntry = { key: string; value: string; description?: string; expand?: boolean; isObject: boolean };

function parseVarEntries(value: Record<string, unknown>): VarEntry[] {
  return Object.entries(value).map(([k, raw]) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      return {
        key: k,
        value: typeof r.value === 'string' ? r.value : r.value == null ? '' : String(r.value),
        description: typeof r.description === 'string' ? r.description : undefined,
        expand: typeof r.expand === 'boolean' ? r.expand : undefined,
        isObject: true,
      };
    }
    return { key: k, value: raw == null ? '' : String(raw), isObject: false };
  });
}

function serializeVarEntries(entries: VarEntry[], original: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entries.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.key) continue;
    if (e.isObject || e.description !== undefined || e.expand !== undefined) {
      const orig = original[e.key];
      const extras = (orig && typeof orig === 'object' && !Array.isArray(orig))
        ? Object.fromEntries(Object.entries(orig as Record<string, unknown>).filter(([k]) => !['value', 'description', 'expand'].includes(k)))
        : {};
      out[e.key] = {
        value: e.value,
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.expand !== undefined ? { expand: e.expand } : {}),
        ...extras,
      };
    } else {
      out[e.key] = e.value;
    }
  }
  return out;
}

function VariablesEditor({
  value, onChange, disabled,
}: { value: Record<string, unknown>; onChange: (v: unknown) => void; disabled?: boolean }) {
  const entries = parseVarEntries(value);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  function commit(next: VarEntry[]) {
    onChange(serializeVarEntries(next, value));
  }
  function update(i: number, patch: Partial<VarEntry>) {
    const next = entries.slice();
    next[i] = { ...next[i], ...patch };
    commit(next);
  }
  function remove(i: number) {
    const next = entries.slice();
    next.splice(i, 1);
    commit(next);
  }
  function add() {
    const base = 'NEW_VAR';
    let k = base;
    let n = 1;
    while (entries.some((e) => e.key === k)) { k = `${base}_${n++}`; }
    commit([...entries, { key: k, value: '', isObject: false }]);
    setExpandedKey(null);
  }

  return (
    <div style={chipsBoxStyle}>
      {entries.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
          No variables defined.
        </div>
      ) : (
        <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Header row */}
          <div style={varHeaderRowStyle}>
            <div style={{ ...varKeyCellStyle, fontWeight: 700, color: 'var(--vscode-descriptionForeground)' }}>KEY</div>
            <div style={{ ...varEqCellStyle }} />
            <div style={{ ...varValCellStyle, fontWeight: 700, color: 'var(--vscode-descriptionForeground)' }}>VALUE</div>
            <div style={{ width: 22 }} />
            <div style={{ width: 22 }} />
          </div>
          {entries.map((e, i) => {
            const isExpanded = expandedKey === e.key;
            return (
              <div key={i} style={{
                background: isExpanded ? 'rgba(252,109,38,0.04)' : 'transparent',
                borderRadius: 4,
                padding: isExpanded ? 4 : 0,
                border: isExpanded ? '1px solid rgba(252,109,38,0.20)' : '1px solid transparent',
              }}>
                <div style={varRowStyle}>
                  <input
                    disabled={disabled}
                    type="text"
                    value={e.key}
                    onChange={(ev) => update(i, { key: ev.target.value })}
                    placeholder="VAR_NAME"
                    spellCheck={false}
                    style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                  />
                  <div style={{ ...varEqCellStyle, color: 'var(--vscode-descriptionForeground)', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>=</div>
                  <input
                    disabled={disabled}
                    type="text"
                    value={e.value}
                    onChange={(ev) => update(i, { value: ev.target.value })}
                    placeholder="value"
                    spellCheck={false}
                    style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
                  />
                  {!disabled && (
                    <>
                      <button
                        onClick={() => setExpandedKey(isExpanded ? null : e.key)}
                        title={isExpanded ? 'Hide options' : 'Show description, expand…'}
                        style={{
                          ...iconBtnStyle,
                          width: 22, height: 22,
                          color: e.description !== undefined || e.expand !== undefined ? '#fc6d26' : 'var(--vscode-descriptionForeground)',
                        }}
                      >
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
                          <path d={isExpanded ? 'M3 7 L6 4 L9 7' : 'M3 5 L6 8 L9 5'} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button onClick={() => remove(i)} title="Remove variable" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M2.5 3.5 H9.5 M4.5 3.5 V2.5 H7.5 V3.5 M3.5 3.5 L4 10 H8 L8.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    </>
                  )}
                </div>
                {isExpanded && !disabled && (
                  <div style={{ padding: '6px 4px 2px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div>
                      <label style={varSubLabelStyle}>Description</label>
                      <input
                        type="text"
                        value={e.description ?? ''}
                        onChange={(ev) => update(i, { description: ev.target.value || undefined })}
                        placeholder="Shown when manually triggering pipelines"
                        style={{ ...glInputStyle, height: 24 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <CheckboxRow
                        checked={e.expand === false}
                        onChange={() => update(i, { expand: e.expand === false ? undefined : false })}
                        label="Raw value"
                        hint="Do not expand $variables inside this value"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!disabled && (
        <button
          onClick={add}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'rgba(252,109,38,0.06)',
            color: '#fc6d26',
            border: 'none',
            borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)',
            cursor: 'pointer',
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--vscode-font-family)',
            textAlign: 'left',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
          onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.12)')}
          onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.06)')}
        >
          <PlusIconSmall /> Add variable
        </button>
      )}
    </div>
  );
}

function CheckboxRow({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
      <span style={{
        width: 14, height: 14, flex: '0 0 auto', marginTop: 2,
        borderRadius: 3, border: `1px solid ${checked ? '#1f75cb' : 'var(--vscode-checkbox-border, #666)'}`,
        background: checked ? '#1f75cb' : 'transparent',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {checked && <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ display: 'none' }} />
      <span>
        <span style={{ fontSize: 11, fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: 10, opacity: 0.6, marginTop: 1 }}>{hint}</span>}
      </span>
    </label>
  );
}

function PlusIconSmall() {
  return <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden><path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>;
}

const varHeaderRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '0 24px 2px 0',
  fontSize: 9, letterSpacing: 0.5,
};
const varRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 };
const varKeyCellStyle: React.CSSProperties = { flex: '1 1 40%', minWidth: 0 };
const varValCellStyle: React.CSSProperties = { flex: '1 1 60%', minWidth: 0 };
const varEqCellStyle: React.CSSProperties = { width: 12, flex: '0 0 auto', textAlign: 'center', fontSize: 11, opacity: 0.5 };
const varSubLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)', marginBottom: 2,
};

// ---------- rules: editor ----------

type RuleObj = {
  if?: string;
  changes?: unknown;
  exists?: unknown;
  when?: string;
  allow_failure?: boolean;
  start_in?: string;
  variables?: Record<string, unknown>;
  [k: string]: unknown;
};

const WHEN_OPTIONS = ['on_success', 'on_failure', 'always', 'manual', 'delayed', 'never'] as const;
const WHEN_COLOR: Record<string, string> = {
  on_success: '#108548',
  on_failure: '#c17d10',
  always: '#1f75cb',
  manual: '#c17d10',
  delayed: '#6e49cb',
  never: '#dd2b0e',
};

function RulesEditor({
  value, onChange, disabled,
}: { value: unknown[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  // Each rule is treated as an object; non-object entries (strings/arrays) pass through as raw blobs.
  const rules = value.map((r, i): { obj: RuleObj | null; raw: unknown; key: number } => {
    if (r && typeof r === 'object' && !Array.isArray(r)) return { obj: r as RuleObj, raw: r, key: i };
    return { obj: null, raw: r, key: i };
  });
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function commit(next: unknown[]) {
    onChange(next.length === 0 ? undefined : next);
  }
  function updateRule(i: number, patch: Partial<RuleObj>, deleteKeys?: string[]) {
    const cur = rules[i].obj ?? {};
    const merged: RuleObj = { ...cur, ...patch };
    for (const k of deleteKeys ?? []) delete (merged as Record<string, unknown>)[k];
    const next = value.slice();
    next[i] = merged;
    commit(next);
  }
  function removeRule(i: number) {
    const next = value.slice();
    next.splice(i, 1);
    commit(next);
    if (expandedIdx === i) setExpandedIdx(null);
  }
  function moveRule(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }
  function addRule() {
    commit([...value, { if: '$CI_COMMIT_BRANCH == "main"' }]);
    setExpandedIdx(value.length);
  }

  return (
    <div style={chipsBoxStyle}>
      {value.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
          No rules defined. Without rules the job runs in every pipeline.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '6px 10px',
            fontSize: 10, opacity: 0.7,
            color: 'var(--vscode-descriptionForeground)',
            borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <strong>First match wins</strong> — rules are evaluated top-down; the first one whose conditions match decides the outcome.
          </div>
          {rules.map((r, i) => {
            const isExpanded = expandedIdx === i;
            const obj = r.obj;
            const isObject = !!obj;
            const when = obj?.when ?? 'on_success';
            const whenColor = WHEN_COLOR[when] ?? '#888';
            const advancedCount = isObject ? ['changes', 'exists', 'variables', 'start_in'].filter((k) => k in obj!).length : 0;
            return (
              <div key={r.key} style={{
                padding: 8,
                borderBottom: i === rules.length - 1 ? 'none' : '1px solid var(--vscode-panel-border, #2d2d2d)',
                background: isExpanded ? 'rgba(252,109,38,0.04)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {/* Number badge */}
                  <span style={ruleBadgeStyle}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* if: expression */}
                    {isObject ? (
                      <div>
                        <label style={varSubLabelStyle}>If</label>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 0,
                          border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
                          borderRadius: 4,
                          background: 'var(--vscode-input-background)',
                          overflow: 'hidden',
                        }}>
                          <span aria-hidden style={{
                            padding: '0 8px', height: 24,
                            display: 'inline-flex', alignItems: 'center',
                            background: 'rgba(31,117,203,0.10)', color: '#1f75cb',
                            borderRight: '1px solid var(--vscode-panel-border, #444)',
                            fontFamily: 'var(--vscode-editor-font-family, monospace)',
                            fontSize: 11, fontWeight: 700,
                          }}>$</span>
                          <input
                            disabled={disabled}
                            type="text"
                            value={obj!.if ?? ''}
                            onChange={(e) => updateRule(i, { if: e.target.value || undefined }, e.target.value ? [] : ['if'])}
                            placeholder='$CI_COMMIT_BRANCH == "main"'
                            spellCheck={false}
                            style={{
                              flex: 1, minWidth: 0,
                              padding: '3px 8px',
                              background: 'transparent',
                              color: 'var(--vscode-input-foreground)',
                              border: 'none', outline: 'none',
                              fontSize: 12,
                              fontFamily: 'var(--vscode-editor-font-family, monospace)',
                              boxSizing: 'border-box',
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div style={{
                        padding: '6px 8px',
                        fontSize: 11,
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px dashed var(--vscode-panel-border, #444)',
                        borderRadius: 4,
                        color: 'var(--vscode-descriptionForeground)',
                      }}>
                        {typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw)} <span style={{ opacity: 0.6 }}>(non-object rule — edit in YAML)</span>
                      </div>
                    )}

                    {/* When + allow_failure quick row */}
                    {isObject && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <label style={{ ...varSubLabelStyle, marginBottom: 0 }}>When</label>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 4px 2px 8px',
                            border: `1px solid ${whenColor}55`,
                            background: `${whenColor}1f`,
                            borderRadius: 10,
                            color: whenColor,
                            fontSize: 10, fontWeight: 700,
                          }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: whenColor }} aria-hidden />
                            <select
                              disabled={disabled}
                              value={when}
                              onChange={(e) => updateRule(i, { when: e.target.value })}
                              style={{
                                background: 'transparent',
                                color: whenColor,
                                border: 'none',
                                fontSize: 10, fontWeight: 700,
                                fontFamily: 'var(--vscode-font-family)',
                                outline: 'none',
                                cursor: 'pointer',
                                appearance: 'none',
                                paddingRight: 12,
                              }}
                            >
                              {WHEN_OPTIONS.map((w) => <option key={w} value={w} style={{ background: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-foreground)' }}>{w}</option>)}
                            </select>
                          </span>
                        </span>

                        <CheckboxRow
                          checked={obj!.allow_failure === true}
                          onChange={() => updateRule(i, { allow_failure: obj!.allow_failure === true ? undefined : true }, obj!.allow_failure === true ? ['allow_failure'] : [])}
                          label="Allow failure"
                        />

                        {advancedCount > 0 && <MiniBadge label={`+${advancedCount} advanced`} />}
                      </div>
                    )}

                    {/* Expanded advanced */}
                    {isExpanded && isObject && !disabled && (
                      <RuleAdvanced rule={obj!} onPatch={(p, dels) => updateRule(i, p, dels)} />
                    )}
                  </div>

                  {/* Controls */}
                  {!disabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <button onClick={() => moveRule(i, -1)} disabled={i === 0} title="Move up" style={{ ...iconBtnStyle, width: 22, height: 18, opacity: i === 0 ? 0.3 : 1 }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 7 L6 4 L9 7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button onClick={() => moveRule(i, 1)} disabled={i === rules.length - 1} title="Move down" style={{ ...iconBtnStyle, width: 22, height: 18, opacity: i === rules.length - 1 ? 0.3 : 1 }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 5 L6 8 L9 5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      {isObject && (
                        <button onClick={() => setExpandedIdx(isExpanded ? null : i)} title={isExpanded ? 'Hide advanced' : 'Show advanced'} style={{ ...iconBtnStyle, width: 22, height: 18, color: isExpanded || advancedCount > 0 ? '#fc6d26' : 'var(--vscode-descriptionForeground)' }}>
                          <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><circle cx={3} cy={6} r={1} fill="currentColor" /><circle cx={6} cy={6} r={1} fill="currentColor" /><circle cx={9} cy={6} r={1} fill="currentColor" /></svg>
                        </button>
                      )}
                      <button onClick={() => removeRule(i)} title="Delete rule" style={{ ...iconBtnStyle, width: 22, height: 18, color: '#dd2b0e' }}>
                        <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M2.5 3.5 H9.5 M4.5 3.5 V2.5 H7.5 V3.5 M3.5 3.5 L4 10 H8 L8.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!disabled && (
        <button
          onClick={addRule}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'rgba(252,109,38,0.06)',
            color: '#fc6d26',
            border: 'none',
            borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)',
            cursor: 'pointer',
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--vscode-font-family)',
            textAlign: 'left',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
          onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.12)')}
          onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.06)')}
        >
          <PlusIconSmall /> Add rule
        </button>
      )}
    </div>
  );
}

function RuleAdvanced({
  rule, onPatch,
}: { rule: RuleObj; onPatch: (patch: Partial<RuleObj>, deleteKeys?: string[]) => void }) {
  // changes: string[] | { paths, compare_to? }
  // exists: string[] | { paths, project?, ref? }
  // variables: Record<string, string>
  // start_in: string (for when: delayed)
  const changesList: string[] = Array.isArray(rule.changes)
    ? (rule.changes as unknown[]).map((c) => String(c))
    : (rule.changes && typeof rule.changes === 'object' && Array.isArray((rule.changes as any).paths))
    ? ((rule.changes as any).paths as unknown[]).map((c) => String(c))
    : [];
  const existsList: string[] = Array.isArray(rule.exists)
    ? (rule.exists as unknown[]).map((c) => String(c))
    : (rule.exists && typeof rule.exists === 'object' && Array.isArray((rule.exists as any).paths))
    ? ((rule.exists as any).paths as unknown[]).map((c) => String(c))
    : [];

  function setStringArray(key: 'changes' | 'exists', list: string[]) {
    if (list.length === 0) onPatch({}, [key]);
    else onPatch({ [key]: list } as Partial<RuleObj>);
  }

  return (
    <div style={{
      padding: 8, marginTop: 4,
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div>
        <label style={varSubLabelStyle}>Changes <span style={{ opacity: 0.6, fontWeight: 400, textTransform: 'none' }}>— file globs that must change</span></label>
        <StringListEditor list={changesList} onChange={(l) => setStringArray('changes', l)} placeholder="e.g. src/**/*.ts" />
      </div>
      <div>
        <label style={varSubLabelStyle}>Exists <span style={{ opacity: 0.6, fontWeight: 400, textTransform: 'none' }}>— paths that must exist</span></label>
        <StringListEditor list={existsList} onChange={(l) => setStringArray('exists', l)} placeholder="e.g. Dockerfile" />
      </div>
      {rule.when === 'delayed' && (
        <div>
          <label style={varSubLabelStyle}>Start in <span style={{ opacity: 0.6, fontWeight: 400, textTransform: 'none' }}>— delay before running</span></label>
          <input
            type="text"
            value={typeof rule.start_in === 'string' ? rule.start_in : ''}
            onChange={(e) => onPatch(e.target.value ? { start_in: e.target.value } : {}, e.target.value ? [] : ['start_in'])}
            placeholder="e.g. 30 minutes"
            style={{ ...glInputStyle, height: 24 }}
          />
        </div>
      )}
      <div>
        <label style={varSubLabelStyle}>Variables overrides</label>
        <VariablesEditor
          value={(rule.variables as Record<string, unknown>) ?? {}}
          onChange={(v) => v === undefined ? onPatch({}, ['variables']) : onPatch({ variables: v as Record<string, unknown> })}
        />
      </div>
    </div>
  );
}

function StringListEditor({ list, onChange, placeholder }: { list: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {list.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="text"
            value={v}
            onChange={(e) => { const next = list.slice(); next[i] = e.target.value; onChange(next); }}
            placeholder={placeholder}
            style={{ ...glInputStyle, height: 24, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
          <button onClick={() => { const next = list.slice(); next.splice(i, 1); onChange(next); }} title="Remove" style={{ ...iconBtnStyle, width: 22, height: 22, color: '#dd2b0e' }}>
            <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...list, ''])}
        style={{
          alignSelf: 'flex-start',
          padding: '3px 8px', fontSize: 10, fontWeight: 600,
          background: 'transparent', color: '#1f75cb',
          border: '1px dashed rgba(31,117,203,0.4)', borderRadius: 4, cursor: 'pointer',
        }}
      >+ add pattern</button>
    </div>
  );
}

const ruleBadgeStyle: React.CSSProperties = {
  flex: '0 0 auto',
  width: 22, height: 22,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(252,109,38,0.12)',
  color: '#fc6d26',
  border: '1px solid rgba(252,109,38,0.40)',
  borderRadius: '50%',
  fontSize: 11, fontWeight: 700,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

// ---------- dependencies: picker ----------

function DependenciesPicker({
  value, onChange, disabled, ctx,
}: { value: unknown[]; onChange: (v: unknown) => void; disabled?: boolean; ctx: PipelineCtx }) {
  const list = value.map((v) => String(v ?? ''));
  const referenced = new Set(list);

  // Match the needs: behaviour — build a stage list that always contains current.
  const stageList = (() => {
    const out = ctx.stages.slice();
    for (const j of ctx.jobs) if (!out.includes(j.stage)) out.push(j.stage);
    if (!out.includes(ctx.currentStage)) out.push(ctx.currentStage);
    return out;
  })();
  const currentIdx = stageList.indexOf(ctx.currentStage);

  const candidates = ctx.jobs
    .filter((j) => j.name !== ctx.currentJobName && !referenced.has(j.name) && !j.hidden)
    .map((j) => {
      const jIdx = stageList.indexOf(j.stage);
      return { ...j, jIdx, tooLate: jIdx > currentIdx };
    });

  const byStage = new Map<string, typeof candidates>();
  for (const j of candidates) {
    if (!byStage.has(j.stage)) byStage.set(j.stage, []);
    byStage.get(j.stage)!.push(j);
  }
  const orderedStages = stageList.filter((s) => byStage.has(s));

  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => { if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  function commit(next: string[]) {
    onChange(next.length === 0 ? undefined : next);
  }
  function add(name: string) {
    commit([...list, name]);
    setPickerOpen(false);
    setFilter('');
  }
  function removeAt(i: number) {
    commit(list.filter((_, j) => j !== i));
  }

  const filtered = filter ? candidates.filter((j) => j.name.toLowerCase().includes(filter.toLowerCase())) : candidates;
  const filteredByStage = new Map<string, typeof candidates>();
  for (const j of filtered) {
    if (!filteredByStage.has(j.stage)) filteredByStage.set(j.stage, []);
    filteredByStage.get(j.stage)!.push(j);
  }
  const filteredStages = orderedStages.filter((s) => filteredByStage.has(s));
  const hasAnyPickable = candidates.some((j) => !j.tooLate);
  const isDefault = list.length === 0; // empty dependencies: == download artifacts from all prior stages

  // The "deps color" — green/teal to evoke "artifacts download", distinct from needs (blue).
  const DEP_COLOR = '#0095a8';

  return (
    <div style={chipsBoxStyle}>
      {/* Default-behavior hint when empty */}
      {isDefault && (
        <div style={{
          padding: '8px 10px',
          fontSize: 11,
          color: 'var(--vscode-descriptionForeground)',
          fontStyle: 'italic',
          borderBottom: !disabled ? '1px solid var(--vscode-panel-border, #2d2d2d)' : undefined,
        }}>
          No restrictions — by default this job downloads artifacts from every job in earlier stages.
        </div>
      )}

      {list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8 }}>
          {list.map((name, i) => {
            const job = ctx.jobs.find((j) => j.name === name);
            const exists = !!job;
            const stage = job?.stage;
            const color = exists ? DEP_COLOR : '#dd2b0e';
            return (
              <span
                key={i}
                style={needChipStyle(color, !exists)}
                title={exists ? `Download artifacts from ${name} (stage: ${stage})` : 'Job not found in pipeline'}
              >
                {!exists && <span aria-hidden style={{ marginRight: 2 }}>⚠</span>}
                <DownloadIcon />
                <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>{name}</span>
                {!disabled && <ChipX onClick={() => removeAt(i)} />}
              </span>
            );
          })}
        </div>
      )}

      {!disabled && (
        <div ref={pickerRef} style={{ position: 'relative', borderTop: list.length > 0 ? '1px solid var(--vscode-panel-border, #2d2d2d)' : undefined }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            disabled={!hasAnyPickable}
            style={{
              width: '100%',
              padding: '7px 10px',
              background: pickerOpen ? 'rgba(0,149,168,0.12)' : 'transparent',
              color: !hasAnyPickable ? 'var(--vscode-descriptionForeground)' : DEP_COLOR,
              border: 'none',
              cursor: !hasAnyPickable ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--vscode-font-family)',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <NeedsPlusIcon /> {!hasAnyPickable ? 'No upstream jobs available' : 'Pick artifact source…'}
          </button>

          {pickerOpen && candidates.length > 0 && (
            <div style={{
              position: 'absolute', left: 6, right: 6, bottom: 'calc(100% + 4px)',
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-panel-border, #444)',
              borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              zIndex: 30, maxHeight: 320, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{ padding: 6, borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
                <input
                  autoFocus
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter jobs…"
                  style={glInputStyle}
                />
              </div>
              <div style={{ overflowY: 'auto', padding: '4px 0' }}>
                {filteredStages.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 11, opacity: 0.6 }}>No matching jobs.</div>
                )}
                {filteredStages.map((stage) => {
                  const isCurrent = stage === ctx.currentStage;
                  const stageJobs = filteredByStage.get(stage)!;
                  const stageTooLate = stageJobs[0]?.tooLate;
                  return (
                    <div key={stage}>
                      <div style={{
                        padding: '5px 12px 3px',
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.6,
                        textTransform: 'uppercase',
                        color: isCurrent ? '#c17d10' : 'var(--vscode-descriptionForeground)',
                        opacity: stageTooLate ? 0.5 : 0.75,
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        <span>{stage}</span>
                        {isCurrent && <StageTag color="#c17d10" label="same stage" />}
                        {stageTooLate && <StageTag color="#888" label="later — not allowed" />}
                      </div>
                      {stageJobs.map((j) => (
                        <button
                          key={j.name}
                          onClick={() => !j.tooLate && add(j.name)}
                          disabled={j.tooLate}
                          title={j.tooLate ? 'Cannot depend on a job in a later stage' : `Download artifacts from ${j.name}`}
                          style={{
                            ...pickItemStyle,
                            opacity: j.tooLate ? 0.4 : 1,
                            cursor: j.tooLate ? 'not-allowed' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 8,
                          }}
                          onMouseEnter={(e) => { if (!j.tooLate) (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'; }}
                          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                        >
                          <code style={{ fontWeight: 600 }}>{j.name}</code>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div style={{
                padding: '6px 10px', borderTop: '1px solid var(--vscode-panel-border, #444)',
                fontSize: 10, opacity: 0.65, lineHeight: 1.4,
                background: 'var(--vscode-editorWidget-background, #252526)',
              }}>
                <code>dependencies:</code> restricts which jobs' artifacts to download. Listing none downloads from all earlier stages.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
      <path d="M6 1.5 V7.5 M3.5 5 L6 7.5 L8.5 5 M2 10 H10" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- identity field editors ----------

function StagePicker({
  value, onChange, disabled, ctx,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean; ctx: PipelineCtx }) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Use the declared stages plus any in-use stages (so custom ones still show).
  const stages = (() => {
    const out = ctx.stages.slice();
    for (const j of ctx.jobs) if (!out.includes(j.stage)) out.push(j.stage);
    return out;
  })();
  const isKnown = stages.includes(value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setCustomMode(false); } };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (customMode && !disabled) {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setCustomMode(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setCustomMode(false); }}
          placeholder="custom-stage-name"
          style={glInputStyle}
        />
        <button onClick={() => setCustomMode(false)} style={glGhostBtnStyle} title="Switch back to picker">↩</button>
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          ...glInputStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span aria-hidden style={{
          width: 8, height: 8, borderRadius: '50%',
          background: value ? stageColor(value) : 'var(--vscode-descriptionForeground)',
          flex: '0 0 auto',
        }} />
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: value ? 'var(--vscode-input-foreground)' : 'var(--vscode-descriptionForeground)',
        }}>{value || 'select stage…'}</span>
        {!isKnown && value && <StageTag color="#c17d10" label="custom" />}
        <span style={{ opacity: 0.5, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div style={popoverStyle}>
          {stages.map((s) => (
            <button
              key={s}
              onClick={() => { onChange(s); setOpen(false); }}
              style={{
                ...pickItemStyle,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: s === value ? 700 : 500,
                background: s === value ? 'rgba(31,117,203,0.10)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (s !== value) (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = s === value ? 'rgba(31,117,203,0.10)' : 'transparent'; }}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: stageColor(s), flex: '0 0 auto' }} />
              <code>{s}</code>
              {s === ctx.currentStage && <StageTag color="#c17d10" label="current" />}
            </button>
          ))}
          {stages.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 11, opacity: 0.6 }}>No stages declared yet.</div>
          )}
          <div style={{ borderTop: '1px solid var(--vscode-panel-border, #444)', padding: 4 }}>
            <button
              onClick={() => { setOpen(false); setCustomMode(true); }}
              style={{ ...pickItemStyle, color: '#1f75cb', fontWeight: 600, fontSize: 11 }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
            >
              + custom stage name…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExtendsPicker({
  value, onChange, disabled, ctx,
}: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; ctx: PipelineCtx }) {
  // extends can be a single string or an array of strings.
  const list = Array.isArray(value)
    ? (value as unknown[]).map((v) => String(v ?? ''))
    : typeof value === 'string'
    ? [value]
    : [];

  function commit(next: string[]) {
    if (next.length === 0) onChange(undefined);
    else if (next.length === 1) onChange(next[0]);
    else onChange(next);
  }

  const referenced = new Set(list);
  // Templates = hidden jobs (start with '.'). Also include any current-value refs that don't exist.
  const candidates = ctx.jobs
    .filter((j) => j.hidden && j.name !== ctx.currentJobName && !referenced.has(j.name));

  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => { if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const filtered = filter ? candidates.filter((j) => j.name.toLowerCase().includes(filter.toLowerCase())) : candidates;

  return (
    <div style={chipsBoxStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, minHeight: 32 }}>
        {list.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '4px 2px' }}>
            No templates extended.
          </span>
        )}
        {list.map((name, i) => {
          const exists = ctx.jobs.some((j) => j.name === name);
          const color = exists ? '#6e49cb' : '#dd2b0e';
          return (
            <span
              key={i}
              style={needChipStyle(color, !exists)}
              title={exists ? 'Template job' : 'Template job not found'}
            >
              {!exists && <span aria-hidden style={{ marginRight: 2 }}>⚠</span>}
              <TemplateIcon />
              <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>{name}</span>
              {!disabled && <ChipX onClick={() => commit(list.filter((_, j) => j !== i))} />}
            </span>
          );
        })}
      </div>
      {!disabled && (
        <div ref={pickerRef} style={{ position: 'relative', borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)' }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            disabled={candidates.length === 0 && filter === ''}
            style={{
              width: '100%',
              padding: '7px 10px',
              background: pickerOpen ? 'rgba(110,73,203,0.12)' : 'transparent',
              color: candidates.length === 0 ? 'var(--vscode-descriptionForeground)' : '#6e49cb',
              border: 'none',
              cursor: candidates.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--vscode-font-family)',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <NeedsPlusIcon /> {candidates.length === 0 ? 'No templates available' : 'Extend template…'}
          </button>

          {pickerOpen && candidates.length > 0 && (
            <div style={{
              position: 'absolute', left: 6, right: 6, bottom: 'calc(100% + 4px)',
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-panel-border, #444)',
              borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              zIndex: 30, maxHeight: 320, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <div style={{ padding: 6, borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
                <input
                  autoFocus
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter templates…"
                  style={glInputStyle}
                />
              </div>
              <div style={{ overflowY: 'auto', padding: '4px 0' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 11, opacity: 0.6 }}>No matching templates.</div>
                )}
                {filtered.map((j) => (
                  <button
                    key={j.name}
                    onClick={() => { commit([...list, j.name]); setPickerOpen(false); setFilter(''); }}
                    style={{ ...pickItemStyle, display: 'flex', alignItems: 'center', gap: 8 }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                  >
                    <TemplateIcon />
                    <code style={{ fontWeight: 600 }}>{j.name}</code>
                  </button>
                ))}
              </div>
              <div style={{
                padding: '6px 10px', borderTop: '1px solid var(--vscode-panel-border, #444)',
                fontSize: 10, opacity: 0.65, lineHeight: 1.4,
                background: 'var(--vscode-editorWidget-background, #252526)',
              }}>
                Templates are hidden jobs (names starting with <code>.</code>) that other jobs can inherit from.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImageField({
  value, onChange, disabled,
}: { value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
      borderRadius: 4,
      background: 'var(--vscode-input-background)',
      overflow: 'hidden',
    }}>
      <span aria-hidden style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 8px',
        height: 26,
        background: 'rgba(252,109,38,0.10)',
        color: '#fc6d26',
        borderRight: '1px solid var(--vscode-panel-border, #444)',
        flex: '0 0 auto',
      }}>
        <ContainerIcon />
      </span>
      <input
        disabled={disabled}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder="e.g. node:20-alpine"
        spellCheck={false}
        style={{
          flex: 1, minWidth: 0,
          padding: '4px 8px',
          background: 'transparent',
          color: 'var(--vscode-input-foreground)',
          border: 'none', outline: 'none',
          fontSize: 12,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function ServicesField({
  value, onChange, disabled,
}: { value: unknown[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  // Services can be: string[] or array of { name, alias?, command?, entrypoint?, variables? }
  // For each item, show a chip with the image name; clicking opens inline form for advanced fields.
  const items = value.map((v) => {
    if (typeof v === 'string') return { kind: 'string' as const, name: v, raw: v };
    if (v && typeof v === 'object' && typeof (v as any).name === 'string') {
      return { kind: 'object' as const, name: (v as any).name as string, raw: v as Record<string, unknown> };
    }
    return { kind: 'unknown' as const, name: JSON.stringify(v), raw: v };
  });

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  function commit(next: unknown[]) {
    onChange(next.length === 0 ? undefined : next);
  }
  function addNew() {
    const name = newName.trim();
    if (!name) return;
    commit([...value, name]);
    setNewName('');
    setAdding(false);
  }
  function removeAt(i: number) {
    const next = value.slice();
    next.splice(i, 1);
    commit(next);
  }

  return (
    <div style={chipsBoxStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, minHeight: 32 }}>
        {items.length === 0 && !adding && (
          <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '4px 2px' }}>
            No service containers.
          </span>
        )}
        {items.map((it, i) => (
          <span key={i} style={serviceChipStyle(it.kind === 'unknown')} title={it.kind === 'object' ? 'Service with config (edit via Other)' : ''}>
            <ContainerIcon />
            <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>{it.name}</span>
            {it.kind === 'object' && Object.keys(it.raw).length > 1 && <MiniBadge label={`+${Object.keys(it.raw).length - 1}`} />}
            {!disabled && <ChipX onClick={() => removeAt(i)} />}
          </span>
        ))}
      </div>
      {!disabled && (
        <div style={{ borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)' }}>
          {adding ? (
            <div style={{ display: 'flex', gap: 4, padding: 6 }}>
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addNew(); else if (e.key === 'Escape') { setAdding(false); setNewName(''); } }}
                placeholder="e.g. postgres:16"
                style={glInputStyle}
              />
              <button onClick={addNew} style={{ ...glGhostBtnStyle, color: '#fc6d26', borderColor: 'rgba(252,109,38,0.5)' }}>add</button>
              <button onClick={() => { setAdding(false); setNewName(''); }} style={glGhostBtnStyle}>cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{
                width: '100%', padding: '7px 10px',
                background: 'transparent', color: '#fc6d26',
                border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600,
                fontFamily: 'var(--vscode-font-family)',
                textAlign: 'left',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <NeedsPlusIcon /> Add service…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ContainerIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <rect x={2} y={4} width={12} height={3} rx={0.5} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <rect x={2} y={8} width={12} height={3} rx={0.5} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <line x1={4} y1={5.5} x2={4.5} y2={5.5} stroke="currentColor" strokeWidth={1.2} />
      <line x1={4} y1={9.5} x2={4.5} y2={9.5} stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}
function TemplateIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
      <rect x={1.5} y={1.5} width={9} height={9} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.1} strokeDasharray="2 1.5" />
    </svg>
  );
}

// Deterministic stage color (matches JobDetailPanel.stageAccent palette spirit)
const STAGE_HUES = ['#1f75cb', '#6e49cb', '#fc6d26', '#108548', '#dd2b0e', '#0095a8', '#a8740e'];
function stageColor(stage: string): string {
  let h = 0;
  for (let i = 0; i < stage.length; i++) h = ((h << 5) - h + stage.charCodeAt(i)) | 0;
  return STAGE_HUES[Math.abs(h) % STAGE_HUES.length];
}

const glInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: 'var(--vscode-font-family)',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
  borderRadius: 4,
  outline: 'none',
  boxSizing: 'border-box',
  height: 28,
};
const glGhostBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 11,
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'var(--vscode-font-family)',
};
const chipsBoxStyle: React.CSSProperties = {
  border: '1px solid var(--vscode-panel-border, #2d2d2d)',
  borderRadius: 6,
  background: 'var(--vscode-editor-background)',
  overflow: 'visible',
};
const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)', left: 0, right: 0,
  background: 'var(--vscode-editorWidget-background, #252526)',
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
  zIndex: 30, maxHeight: 280,
  overflowY: 'auto',
  padding: '4px 0',
};
function serviceChipStyle(unknown: boolean): React.CSSProperties {
  const color = unknown ? '#888' : '#fc6d26';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 4px 3px 8px',
    fontSize: 11,
    color,
    background: unknown ? 'rgba(255,255,255,0.04)' : 'rgba(252,109,38,0.10)',
    border: `1px solid ${color}55`,
    borderRadius: 10,
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  };
}

// ---------- shell script editor ----------

function ShellLinesEditor({ value, onChange, disabled, ctx }: { value: unknown[]; onChange: (v: unknown[]) => void; disabled?: boolean; ctx?: PipelineCtx }) {
  // Preserve raw items so reference markers survive round-trip; for string-only
  // values we still drive the textareas off `lines`.
  const rawItems: unknown[] = Array.isArray(value) ? value : value == null ? [] : [value];
  const lines = rawItems.map((v) => (isReference(v) ? '' : typeof v === 'string' ? v : String(v ?? '')));
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const inputsRef = useRef<(HTMLTextAreaElement | null)[]>([]);
  // Index to focus on next render (e.g. after Enter inserts a new step)
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    if (pendingFocus.current != null) {
      const el = inputsRef.current[pendingFocus.current];
      if (el) {
        el.focus();
        el.setSelectionRange(0, 0);
      }
      pendingFocus.current = null;
    }
  });

  function update(i: number, v: string) {
    const next = rawItems.slice();
    next[i] = v;
    onChange(next);
  }
  function insertAfter(i: number) {
    const next = rawItems.slice();
    next.splice(i + 1, 0, '');
    pendingFocus.current = i + 1;
    onChange(next);
  }
  function remove(i: number) {
    const next = rawItems.slice();
    next.splice(i, 1);
    pendingFocus.current = Math.max(0, i - 1);
    onChange(next);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rawItems.length) return;
    const next = rawItems.slice();
    [next[i], next[j]] = [next[j], next[i]];
    pendingFocus.current = j;
    onChange(next);
  }

  function autosize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  return (
    <div style={{
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--vscode-terminal-background, #1a1a1a)',
    }}>
      {/* Header: terminal-ish chrome */}
      <div style={{
        padding: '6px 10px',
        fontSize: 10,
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
        fontFamily: 'var(--vscode-font-family)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--vscode-descriptionForeground)',
      }}>
        <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 700, color: '#fc6d26' }}>$</span>
        <span>shell · {rawItems.length} step{rawItems.length === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ opacity: 0.6, fontSize: 9 }}>Enter to add · Shift+Enter for newline</span>
      </div>

      {rawItems.length === 0 && (
        <div style={{ padding: '12px 10px', color: 'var(--vscode-descriptionForeground)', fontSize: 11, fontStyle: 'italic' }}>
          No steps yet.
        </div>
      )}

      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {rawItems.map((rawItem, i) => {
          const line = lines[i];
          const isFocus = focusIdx === i;
          const refPath = isReference(rawItem) ? (rawItem as { __gitlabReference: string[] }).__gitlabReference : null;
          return (
            <li
              key={i}
              style={{
                display: 'flex',
                alignItems: 'stretch',
                borderBottom: i === rawItems.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)',
                background: isFocus ? 'rgba(252,109,38,0.06)' : 'transparent',
                position: 'relative',
                transition: 'background 80ms ease',
              }}
            >
              {/* Step number gutter */}
              <div style={{
                width: 36,
                flex: '0 0 auto',
                padding: '6px 0 6px 8px',
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: 10,
                color: isFocus ? '#fc6d26' : 'var(--vscode-descriptionForeground)',
                opacity: isFocus ? 1 : 0.55,
                textAlign: 'right',
                userSelect: 'none',
                borderRight: '1px solid rgba(255,255,255,0.05)',
                marginRight: 8,
                paddingRight: 8,
                lineHeight: 1.5,
              }}>{i + 1}</div>

              {refPath ? (
                <div style={{ flex: 1, minWidth: 0, padding: '6px 4px 6px 0' }}>
                  <ReferenceChip path={refPath} ctx={ctx} compact />
                </div>
              ) : (
              <textarea
                ref={(el) => { inputsRef.current[i] = el; autosize(el); }}
                disabled={disabled}
                value={line}
                spellCheck={false}
                rows={1}
                placeholder="echo hello"
                onFocus={() => setFocusIdx(i)}
                onBlur={() => setFocusIdx((cur) => (cur === i ? null : cur))}
                onChange={(e) => { update(i, e.target.value); autosize(e.target); }}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    insertAfter(i);
                  } else if (e.key === 'Backspace' && line === '' && rawItems.length > 1) {
                    e.preventDefault();
                    remove(i);
                  } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(i, -1);
                  } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(i, 1);
                  }
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 4px 6px 0',
                  background: 'transparent',
                  color: 'var(--vscode-terminal-foreground, #cccccc)',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  overflow: 'hidden',
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  boxSizing: 'border-box',
                }}
              />
              )}

              {/* Per-row controls */}
              {!disabled && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  padding: '0 6px',
                  opacity: isFocus ? 1 : 0.35,
                  transition: 'opacity 100ms ease',
                }}>
                  <StepBtn onClick={() => move(i, -1)} title="Move up (⌘↑)" disabled={i === 0}>
                    <ArrowUpIcon />
                  </StepBtn>
                  <StepBtn onClick={() => move(i, 1)} title="Move down (⌘↓)" disabled={i === rawItems.length - 1}>
                    <ArrowDownIcon />
                  </StepBtn>
                  <StepBtn onClick={() => remove(i)} title="Delete step" danger>
                    <TrashIcon />
                  </StepBtn>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* Add step footer */}
      {!disabled && (
        <button
          onClick={() => {
            const next = [...rawItems, ''];
            pendingFocus.current = next.length - 1;
            onChange(next);
          }}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'rgba(252,109,38,0.06)',
            color: '#fc6d26',
            border: 'none',
            borderTop: '1px solid var(--vscode-panel-border, #2d2d2d)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--vscode-font-family)',
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.12)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(252,109,38,0.06)')}
        >
          <PlusIcon /> Add step
        </button>
      )}
    </div>
  );
}

function StepBtn({
  onClick, title, children, disabled, danger,
}: { onClick: () => void; title: string; children: React.ReactNode; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 22, height: 22,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent',
        color: danger ? '#dd2b0e' : 'var(--vscode-descriptionForeground)',
        border: 'none', borderRadius: 3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.3 : 1,
        transition: 'background 80ms ease',
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >{children}</button>
  );
}

function ArrowUpIcon() {
  return <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 7 L6 4 L9 7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ArrowDownIcon() {
  return <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden><path d="M3 5 L6 8 L9 5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function TrashIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 3.5 H9.5 M4.5 3.5 V2.5 H7.5 V3.5 M3.5 3.5 L4 10 H8 L8.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon() {
  return <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden><path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>;
}

function SimpleStringList({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {value.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            disabled={disabled}
            type="text"
            value={v}
            onChange={(e) => { const next = [...value]; next[i] = e.target.value; onChange(next); }}
            style={{ ...inputStyle, flex: 1 }}
          />
          {!disabled && (
            <button onClick={() => { const next = value.slice(); next.splice(i, 1); onChange(next); }} style={iconBtnStyle} title="remove">×</button>
          )}
        </div>
      ))}
      {!disabled && (
        <button onClick={() => onChange([...value, ''])} style={ghostBtnStyle}>+ add</button>
      )}
    </div>
  );
}

function ArrayField({
  value, schema, onChange, disabled, depth,
}: { value: unknown[]; schema: JsonSchema; onChange: (v: unknown[]) => void; disabled?: boolean; depth: number; }) {
  const item = itemSchema(schema);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {value.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start', padding: 4, border: '1px solid var(--vscode-panel-border, #333)', borderRadius: 3 }}>
          <span style={{ opacity: 0.4, fontSize: 11, paddingTop: 6, minWidth: 16, textAlign: 'right' }}>{i}.</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ValueField value={v} schema={item} onChange={(nv) => { const next = [...value]; next[i] = nv; onChange(next); }} disabled={disabled} depth={depth + 1} />
          </div>
          {!disabled && <button onClick={() => { const next = value.slice(); next.splice(i, 1); onChange(next); }} style={iconBtnStyle} title="remove">×</button>}
        </div>
      ))}
      {!disabled && <button onClick={() => onChange([...value, defaultFor(item)])} style={ghostBtnStyle}>+ add item</button>}
    </div>
  );
}

function NestedObject({
  value, schema, onChange, disabled,
}: { value: Record<string, unknown>; schema: JsonSchema; onChange: (v: Record<string, unknown>) => void; disabled?: boolean; depth: number; }) {
  const concrete = pickVariant(schema);
  const props = concrete.properties ?? {};
  const presentKeys = Object.keys(value);
  const schemaKeys = Object.keys(props);
  const availableToAdd = schemaKeys.filter((k) => !(k in value));
  const ordered = [
    ...schemaKeys.filter((k) => k in value),
    ...presentKeys.filter((k) => !schemaKeys.includes(k)),
  ];
  function setKey(k: string, v: unknown) {
    if (v === undefined) { const next = { ...value }; delete next[k]; onChange(next); }
    else onChange({ ...value, [k]: v });
  }
  return (
    <div style={{ border: '1px solid var(--vscode-panel-border, #333)', borderRadius: 3, padding: 6 }}>
      {ordered.map((k) => (
        <KeyRow
          key={k}
          name={k}
          value={value[k]}
          schema={descend(schema, k)}
          onChange={(v) => setKey(k, v)}
          onRemove={disabled ? undefined : () => setKey(k, undefined)}
          disabled={disabled}
        />
      ))}
      {!disabled && availableToAdd.length > 0 && (
        <InlineAddKey options={availableToAdd} schemaProps={props} onAdd={(k) => setKey(k, defaultFor(descend(schema, k)))} />
      )}
    </div>
  );
}

function RawJson({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <textarea
        disabled={disabled}
        value={text}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        onChange={(e) => {
          setText(e.target.value);
          try { setErr(null); onChange(JSON.parse(e.target.value)); }
          catch (ex) { setErr((ex as Error).message); }
        }}
        style={{ ...textareaStyle, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
      />
      {err && <div style={{ fontSize: 11, color: 'var(--vscode-errorForeground)' }}>{err}</div>}
    </div>
  );
}

// ---------- Add-key controls ----------

function InlineAddKey({ options, schemaProps, onAdd }: { options: string[]; schemaProps: Record<string, JsonSchema>; onAdd: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => options.filter((o) => o.toLowerCase().includes(filter.toLowerCase())), [options, filter]);
  if (!open) return <button onClick={() => setOpen(true)} style={ghostBtnStyle}>+ add field</button>;
  return (
    <div style={popupStyle}>
      <input autoFocus placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} style={inputStyle} />
      <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 6 }}>
        {filtered.map((k) => (
          <div key={k} onClick={() => { onAdd(k); setOpen(false); setFilter(''); }} style={addItemStyle} title={schemaProps[k]?.description}>
            <code style={{ fontWeight: 600 }}>{k}</code>
            {schemaProps[k]?.description && <div style={{ fontSize: 10, opacity: 0.6 }}>{truncate(schemaProps[k]!.description!, 90)}</div>}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ opacity: 0.5, padding: 6 }}>no matches</div>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <button onClick={() => setOpen(false)} style={ghostBtnStyle}>cancel</button>
      </div>
    </div>
  );
}

function GlobalAddKey({ value, schemaProps, onAdd }: { value: Record<string, unknown>; schemaProps: Record<string, JsonSchema>; onAdd: (k: string) => void }) {
  const sectionKeySet = new Set(SECTIONS.flatMap((s) => s.keys));
  const candidates = Object.keys(schemaProps).filter((k) => !(k in value) && !sectionKeySet.has(k));
  if (candidates.length === 0) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <InlineAddKey options={candidates} schemaProps={schemaProps} onAdd={onAdd} />
    </div>
  );
}

// ---------- Helpers ----------

function defaultFor(s: JsonSchema): unknown {
  const v = pickVariant(s);
  if (v.default !== undefined) return v.default;
  const t = effectiveType(v);
  if (t === 'string') return '';
  if (t === 'number' || t === 'integer') return 0;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') return {};
  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ---------- styles ----------

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '4px 6px', fontSize: 12, fontFamily: 'var(--vscode-font-family)',
  background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
  border: '1px solid var(--vscode-input-border, transparent)', borderRadius: 3, outline: 'none',
  boxSizing: 'border-box',
};
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: 'vertical', lineHeight: 1.4 };
const ghostBtnStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 11, background: 'transparent',
  color: 'var(--vscode-textLink-foreground, #4fc1ff)', border: '1px dashed var(--vscode-panel-border, #444)',
  borderRadius: 3, cursor: 'pointer', marginTop: 4,
};
const iconBtnStyle: React.CSSProperties = {
  width: 22, height: 22, lineHeight: 1, padding: 0, fontSize: 14,
  background: 'transparent', color: 'var(--vscode-descriptionForeground)', border: 'none', borderRadius: 3, cursor: 'pointer',
};
const popupStyle: React.CSSProperties = {
  background: 'var(--vscode-input-background)', border: '1px solid var(--vscode-input-border, #444)',
  borderRadius: 4, padding: 6, marginTop: 4,
};
const addItemStyle: React.CSSProperties = { padding: '4px 6px', cursor: 'pointer', borderRadius: 3 };
