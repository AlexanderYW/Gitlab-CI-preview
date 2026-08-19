/**
 * GitLab CI/CD include inputs handling.
 * https://docs.gitlab.com/ci/inputs/
 *
 * Templates and components can declare:
 *
 *   spec:
 *     inputs:
 *       environment:
 *         description: 'Which env to deploy to'
 *         default: staging
 *         type: string
 *       replicas:
 *         type: number
 *   ---
 *   deploy-$[[ inputs.environment ]]:
 *     script: ./deploy.sh $[[ inputs.environment ]]
 *
 * Including file provides the values:
 *
 *   include:
 *     - component: gitlab.com/org/p/deploy@1.0.0
 *       inputs:
 *         environment: production
 *         replicas: 5
 */
import { parseAllDocuments, isMap, isScalar, type YAMLMap, type Pair } from 'yaml';

export interface InputDecl {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'array';
  required: boolean;
  default?: unknown;
  description?: string;
  options?: unknown[];
  regex?: string;
}

export interface ApplyInputsResult {
  text: string;
  /** Inputs that were declared but not provided and have no default. */
  missingRequired: string[];
  /** Inputs provided but not declared. */
  unknown: string[];
  /** Inputs that failed type checks. */
  invalid: { name: string; reason: string }[];
}

/**
 * Parse the optional `spec.inputs` header from an included file. GitLab uses a YAML
 * multi-document split — the spec block is the first document, the actual pipeline
 * is the second. We tolerate both single- and multi-doc files.
 */
export function extractInputDeclarations(text: string): { decls: InputDecl[]; bodyText: string } {
  const docs = parseAllDocuments(text);
  if (docs.length >= 2) {
    const specDoc = docs[0];
    const body = docs.slice(1).map((d) => d.toString()).join('---\n');
    return { decls: parseInputSpec(specDoc.contents), bodyText: body };
  }
  // single doc — no spec
  return { decls: [], bodyText: text };
}

function parseInputSpec(node: unknown): InputDecl[] {
  if (!isMap(node)) return [];
  const map = node as YAMLMap;
  const spec = (map.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === 'spec');
  if (!spec || !isMap(spec.value as any)) return [];
  const inputs = ((spec.value as YAMLMap).items as Pair[]).find(
    (p) => (isScalar(p.key) ? String(p.key.value) : '') === 'inputs',
  );
  if (!inputs || !isMap(inputs.value as any)) return [];
  const decls: InputDecl[] = [];
  for (const pair of (inputs.value as YAMLMap).items as Pair[]) {
    const name = isScalar(pair.key) ? String(pair.key.value) : '';
    if (!name) continue;
    const v = pair.value as unknown;
    if (v === null || v === undefined) {
      decls.push({ name, required: true });
      continue;
    }
    if (isMap(v as any)) {
      const m = v as YAMLMap;
      const get = (k: string) => {
        const p = (m.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === k);
        return p?.value as any;
      };
      const def = get('default');
      const type = get('type');
      const desc = get('description');
      const opts = get('options');
      const regex = get('regex');
      decls.push({
        name,
        type: type && isScalar(type) ? String(type.value) as InputDecl['type'] : undefined,
        required: def === undefined,
        default: def !== undefined ? (def as any).toJSON?.() ?? (isScalar(def) ? def.value : undefined) : undefined,
        description: desc && isScalar(desc) ? String(desc.value) : undefined,
        options: opts && (opts as any).toJSON ? (opts as any).toJSON() : undefined,
        regex: regex && isScalar(regex) ? String(regex.value) : undefined,
      });
    }
  }
  return decls;
}

/**
 * Substitute `$[[ inputs.NAME ]]` placeholders in `text` using `provided` + defaults.
 * Validates against declarations.
 */
export function applyInputs(text: string, decls: InputDecl[], provided: Record<string, unknown>): ApplyInputsResult {
  const missingRequired: string[] = [];
  const invalid: { name: string; reason: string }[] = [];
  const declNames = new Set(decls.map((d) => d.name));
  const unknown = Object.keys(provided).filter((k) => !declNames.has(k));

  const resolved: Record<string, unknown> = {};
  for (const d of decls) {
    if (Object.prototype.hasOwnProperty.call(provided, d.name)) {
      const v = provided[d.name];
      const err = validate(d, v);
      if (err) invalid.push({ name: d.name, reason: err });
      resolved[d.name] = v;
    } else if (d.default !== undefined) {
      resolved[d.name] = d.default;
    } else {
      missingRequired.push(d.name);
    }
  }

  const out = text.replace(/\$\[\[\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*(\|[^\]]+)?\s*\]\]/g, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(resolved, name)) {
      return String(resolved[name]);
    }
    return '';
  });

  return { text: out, missingRequired, unknown, invalid };
}

function validate(decl: InputDecl, value: unknown): string | null {
  if (decl.type === 'number' && typeof value !== 'number') return 'expected number';
  if (decl.type === 'boolean' && typeof value !== 'boolean') return 'expected boolean';
  if (decl.type === 'array' && !Array.isArray(value)) return 'expected array';
  if (decl.type === 'string' && typeof value !== 'string') return 'expected string';
  if (decl.options && Array.isArray(decl.options) && !decl.options.includes(value)) {
    return `must be one of ${JSON.stringify(decl.options)}`;
  }
  if (decl.regex && typeof value === 'string' && !new RegExp(decl.regex).test(value)) {
    return `does not match /${decl.regex}/`;
  }
  return null;
}
