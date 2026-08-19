import { describe, expect, test } from 'bun:test';
import { groupKeys, sectionForKey, SECTIONS } from '../src/sections.js';

describe('groupKeys', () => {
  test('routes present keys into their section and only keeps present ones', () => {
    const { sections } = groupKeys(['stage', 'script', 'image']);
    const identity = sections.find((s) => s.section.id === 'identity')!;
    const execution = sections.find((s) => s.section.id === 'execution')!;
    expect(identity.keys).toEqual(['stage', 'image']); // declared order, absent keys dropped
    expect(execution.keys).toEqual(['script']);
  });

  test('unknown keys land in `other` so nothing is lost', () => {
    const { other } = groupKeys(['stage', 'totally_custom_key']);
    expect(other).toEqual(['totally_custom_key']);
  });

  test('default-relevant keys are all assigned to a section', () => {
    for (const k of ['before_script', 'after_script', 'services', 'artifacts', 'cache', 'environment']) {
      expect(sectionForKey(k)).not.toBeNull();
    }
  });

  test('every section key is unique across sections', () => {
    const all = SECTIONS.flatMap((s) => s.keys);
    expect(new Set(all).size).toBe(all.length);
  });
});
