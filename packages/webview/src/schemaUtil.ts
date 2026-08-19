import schema from './gitlab-ci.schema.json' assert { type: 'json' };

// The embedded GitLab schema is far richer than our minimal JsonSchema shape; cast through
// unknown since the structural types don't (and needn't) overlap.
export const ROOT_SCHEMA = schema as unknown as JsonSchema;

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  required?: string[];
  default?: unknown;
  format?: string;
  pattern?: string;
}

export function resolveRef(s: JsonSchema, visited: Set<string> = new Set()): JsonSchema {
  if (!s || !s.$ref) return s;
  if (visited.has(s.$ref)) return {};
  visited.add(s.$ref);
  const parts = s.$ref.replace(/^#\//, '').split('/');
  let node: any = ROOT_SCHEMA;
  for (const part of parts) {
    node = node?.[part];
    if (!node) return {};
  }
  // Merge sibling props with the resolved one (rare but valid).
  const merged = { ...node, ...stripRef(s) };
  return resolveRef(merged, visited);
}
function stripRef(s: JsonSchema): JsonSchema {
  const { $ref: _ignored, ...rest } = s;
  return rest as JsonSchema;
}

/** Pick a single concrete schema variant from oneOf/anyOf, biased to "object" or first. */
export function pickVariant(s: JsonSchema): JsonSchema {
  s = resolveRef(s);
  const variants = s.oneOf ?? s.anyOf;
  if (!variants || variants.length === 0) return s;
  const resolved = variants.map((v) => resolveRef(v));
  const obj = resolved.find((v) => v.type === 'object' || v.properties);
  if (obj) return obj;
  return resolved[0];
}

/** Get the job-level schema definition (properties for a single job). */
export function jobSchema(): JsonSchema {
  const defs = (ROOT_SCHEMA.$defs ?? ROOT_SCHEMA.definitions ?? {}) as Record<string, JsonSchema>;
  // Some GitLab schemas name it 'job', others might differ.
  for (const k of ['job', 'jobTemplate', 'Job']) {
    if (defs[k]) return resolveRef(defs[k]);
  }
  return {};
}

/** Best-effort type detection. */
export function effectiveType(s: JsonSchema): string | null {
  s = pickVariant(s);
  if (Array.isArray(s.type)) return s.type[0] ?? null;
  if (typeof s.type === 'string') return s.type;
  if (s.properties || s.additionalProperties) return 'object';
  if (s.items) return 'array';
  if (s.enum) return 'enum';
  return null;
}

/** Find the schema for a sub-property by walking property paths. */
export function descend(schema: JsonSchema, key: string): JsonSchema {
  const s = pickVariant(schema);
  if (s.properties?.[key]) return resolveRef(s.properties[key]);
  if (typeof s.additionalProperties === 'object') return resolveRef(s.additionalProperties);
  return {};
}

/** Item schema for an array. */
export function itemSchema(schema: JsonSchema): JsonSchema {
  const s = pickVariant(schema);
  if (Array.isArray(s.items)) return resolveRef(s.items[0] ?? {});
  if (s.items) return resolveRef(s.items as JsonSchema);
  return {};
}
