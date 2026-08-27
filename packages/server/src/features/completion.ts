import { CompletionItemKind, InsertTextFormat, type CompletionItem, type Position } from 'vscode-languageserver';
import type { PipelineModel } from '@gitlab-ci-preview/shared';
import { parseReference, resolveReference } from '@gitlab-ci-preview/shared';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { findReferenceAt } from './hover.js';
import schema from '../schema/gitlab-ci.schema.json' assert { type: 'json' };

// Pull key lists from the schema so we stay in sync with GitLab.
function schemaTopKeys(): string[] {
  const props = (schema as any).properties ?? {};
  const reserved = new Set(['default', 'include', 'stages', 'variables', 'workflow',
    'image', 'services', 'cache', 'before_script', 'after_script', 'pages']);
  return Object.keys(props).filter((k) => reserved.has(k) || /^[a-z]/.test(k));
}
function schemaJobKeys(): string[] {
  const defs: any = (schema as any).definitions ?? (schema as any).$defs ?? {};
  const job = defs.job ?? defs.jobTemplate ?? defs.Job;
  const fromJob = job?.properties ? Object.keys(job.properties) : [];
  if (fromJob.length) return fromJob;
  return [
    'stage', 'script', 'before_script', 'after_script', 'image', 'services',
    'needs', 'dependencies', 'extends', 'rules', 'only', 'except',
    'variables', 'tags', 'when', 'allow_failure', 'retry', 'timeout',
    'cache', 'artifacts', 'environment', 'parallel', 'trigger',
  ];
}
function docFor(keys: 'top' | 'job', key: string): string | undefined {
  const defs: any = (schema as any).definitions ?? (schema as any).$defs ?? {};
  if (keys === 'top') return (schema as any).properties?.[key]?.description;
  return defs.job?.properties?.[key]?.description;
}
const TOP_KEYS = schemaTopKeys();
const JOB_KEYS = schemaJobKeys();

const SNIPPETS: CompletionItem[] = [
  {
    label: 'job', kind: CompletionItemKind.Snippet,
    insertTextFormat: InsertTextFormat.Snippet,
    insertText: '${1:job_name}:\n  stage: ${2:test}\n  script:\n    - ${3:echo hello}\n',
    detail: 'job template',
  },
  {
    label: 'rules:if', kind: CompletionItemKind.Snippet,
    insertTextFormat: InsertTextFormat.Snippet,
    insertText: 'rules:\n  - if: \'$CI_PIPELINE_SOURCE == "${1:merge_request_event}"\'\n',
    detail: 'rules with if',
  },
  {
    label: 'include:component', kind: CompletionItemKind.Snippet,
    insertTextFormat: InsertTextFormat.Snippet,
    insertText: 'include:\n  - component: ${1:gitlab.com}/${2:org/project}/${3:component}@${4:1.0.0}\n    inputs:\n      ${5:name}: ${6:value}\n',
    detail: 'CI/CD component include',
  },
];

export function completion(model: PipelineModel, doc: TextDocument, pos: Position): CompletionItem[] {
  const text = doc.getText();
  const lineStart = doc.offsetAt({ line: pos.line, character: 0 });
  const linePrefix = text.slice(lineStart, doc.offsetAt(pos));

  // Inside `!reference[...]`: complete job names, then the job's spec keys.
  const ref = findReferenceAt(text, pos);
  if (ref) {
    return referenceCompletion(model, text.slice(ref.contentStart, doc.offsetAt(pos)));
  }

  // Top-level (no indent): suggest top keys + snippets.
  if (/^[A-Za-z_.]*$/.test(linePrefix)) {
    return [
      ...TOP_KEYS.map((k) => ({
        label: k, kind: CompletionItemKind.Keyword,
        documentation: docFor('top', k),
      })),
      ...SNIPPETS,
    ];
  }
  // After "stage:" complete with stages.
  if (/\bstage:\s*$/.test(linePrefix)) {
    return model.stages.map((s) => ({ label: s, kind: CompletionItemKind.EnumMember }));
  }
  // After "extends:" or "- " under needs/extends: suggest jobs.
  if (/\b(extends|needs|dependencies):\s*$/.test(linePrefix) || /^\s*-\s*$/.test(linePrefix)) {
    return model.jobs
      .filter((j) => j.hidden || /[A-Za-z]/.test(j.name))
      .map((j) => ({ label: j.name, kind: CompletionItemKind.Reference }));
  }
  // After "when:" suggest allowed values.
  if (/\bwhen:\s*$/.test(linePrefix)) {
    return ['on_success', 'on_failure', 'always', 'manual', 'delayed', 'never']
      .map((v) => ({ label: v, kind: CompletionItemKind.EnumMember }));
  }
  // Indented key: suggest job keys.
  if (/^\s+[A-Za-z_]*$/.test(linePrefix)) {
    return JOB_KEYS.map((k) => ({
      label: k, kind: CompletionItemKind.Property,
      documentation: docFor('job', k),
    }));
  }
  return [];
}

/**
 * Completion inside a `!reference[...]` payload.
 * Before the first separator → job names; after it → the referenced job's
 * top-level spec keys.
 */
function referenceCompletion(model: PipelineModel, rawBefore: string): CompletionItem[] {
  const trimmed = rawBefore.trim();
  // A trailing separator means the job name is done — move on to its keys.
  const endsWithSeparator = /[.,]\s*$/.test(trimmed);
  const cleaned = trimmed.replace(/[.,\s]+$/, '');
  const parsed = parseReference(cleaned);
  if (!endsWithSeparator && (!parsed || parsed.keyPath.length === 0)) {
    // Still typing the job name.
    return model.jobs
      .filter((j) => j.hidden || /[A-Za-z]/.test(j.name))
      .map((j) => ({ label: j.name, kind: CompletionItemKind.Reference }));
  }
  if (!parsed) return [];
  const res = resolveReference(cleaned, model.jobs);
  if (!res) return [];
  return Object.keys(res.job.raw).map((k) => ({ label: k, kind: CompletionItemKind.Property }));
}
