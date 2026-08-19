import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type { Document } from 'yaml';
import type { Diagnostic } from '@gitlab-ci-preview/shared';
import schema from '../schema/gitlab-ci.schema.json' assert { type: 'json' };
import { nodeRange } from '../parser.js';

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false });
addFormats(ajv);
let validate: ReturnType<typeof ajv.compile> | null = null;
function getValidator() {
  if (!validate) validate = ajv.compile(schema as object);
  return validate!;
}

/**
 * Validate a parsed YAML document against the GitLab CI JSON schema.
 * Returns diagnostics with their positions mapped back into the source.
 */
export function schemaDiagnostics(uri: string, text: string, doc: Document): Diagnostic[] {
  const v = getValidator();
  const json = doc.toJSON();
  if (json == null) return [];
  const ok = v(json);
  if (ok) return [];
  const errs = (v.errors ?? []) as ErrorObject[];
  const out: Diagnostic[] = [];
  for (const err of errs) {
    // skip noisy alternative-branch errors from oneOf/anyOf if a sibling produced a clearer message
    if (err.keyword === 'if') continue;
    const range = locate(doc, text, err.instancePath);
    out.push({
      uri,
      range,
      severity: 'warning',
      message: friendly(err),
      source: 'gitlab-ci/schema',
    });
  }
  return dedupe(out);
}

function friendly(err: ErrorObject): string {
  const path = err.instancePath || '(root)';
  switch (err.keyword) {
    case 'additionalProperties':
      return `${path}: unknown property "${(err.params as any).additionalProperty}"`;
    case 'required':
      return `${path}: missing required property "${(err.params as any).missingProperty}"`;
    case 'type':
      return `${path}: expected ${(err.params as any).type}`;
    case 'enum':
      return `${path}: must be one of ${JSON.stringify((err.params as any).allowedValues)}`;
    case 'pattern':
      return `${path}: ${err.message ?? 'pattern mismatch'}`;
    default:
      return `${path}: ${err.message ?? err.keyword}`;
  }
}

function locate(doc: Document, text: string, instancePath: string): import('@gitlab-ci-preview/shared').Range {
  const segs = instancePath.split('/').slice(1).map((s) => decodeURIComponent(s.replace(/~1/g, '/').replace(/~0/g, '~')));
  let node: any = doc.contents;
  for (const seg of segs) {
    if (node && typeof node.get === 'function') {
      const child = node.get(seg, true);
      if (child) { node = child; continue; }
    }
    if (node && Array.isArray((node as any).items)) {
      const idx = Number(seg);
      if (!Number.isNaN(idx) && (node as any).items[idx]) { node = (node as any).items[idx]; continue; }
    }
    break;
  }
  return nodeRange(text, node ?? null);
}

function dedupe(diags: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const k = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
