import { isScalar, YAMLSeq, type CollectionTag, type Schema } from 'yaml';
import { REFERENCE_MARKER, isReferenceMarker } from '@gitlab-ci-preview/shared';

/**
 * Custom YAML tag for GitLab's `!reference [.job, key, ...]` form.
 *
 * Parse: turns the tagged sequence into `{ __gitlabReference: [..items] }` so
 * the marker survives `toJSON()` and reaches the webview through `Job.raw`.
 *
 * Stringify: takes that marker back to a flow-style sequence tagged
 * `!reference`, so saves from the form editor round-trip cleanly.
 */
export const REFERENCE_TAG: CollectionTag = {
  tag: '!reference',
  collection: 'seq',
  identify: isReferenceMarker,
  resolve: (node) => {
    const path: string[] = [];
    const items = (node as YAMLSeq).items ?? [];
    for (const it of items) {
      if (isScalar(it)) path.push(String(it.value));
      else if (typeof it === 'string') path.push(it);
    }
    return { [REFERENCE_MARKER]: path };
  },
  createNode: (schema: Schema, value: unknown, ctx) => {
    const path = isReferenceMarker(value) ? value[REFERENCE_MARKER] : [];
    const seq = YAMLSeq.from(schema, path, ctx);
    seq.tag = '!reference';
    seq.flow = true;
    return seq;
  },
};
