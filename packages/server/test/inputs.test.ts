import { describe, expect, test } from 'bun:test';
import { extractInputDeclarations, applyInputs } from '../src/includes/inputs.js';

describe('inputs', () => {
  test('parses spec.inputs from a 2-doc YAML', () => {
    const text = `spec:
  inputs:
    env:
      default: staging
      type: string
    replicas:
      type: number
---
deploy:
  script: ./d.sh $[[ inputs.env ]] $[[ inputs.replicas ]]
`;
    const { decls, bodyText } = extractInputDeclarations(text);
    expect(decls.map((d) => d.name).sort()).toEqual(['env', 'replicas']);
    expect(decls.find((d) => d.name === 'env')!.required).toBe(false);
    expect(decls.find((d) => d.name === 'replicas')!.required).toBe(true);
    expect(bodyText).toContain('deploy:');
  });

  test('substitutes inputs with defaults and provided values', () => {
    const text = `\ndeploy:\n  script: ./d.sh $[[ inputs.env ]] $[[ inputs.replicas ]]\n`;
    const decls = [
      { name: 'env', required: false, default: 'staging', type: 'string' as const },
      { name: 'replicas', required: true, type: 'number' as const },
    ];
    const res = applyInputs(text, decls, { replicas: 3 });
    expect(res.text).toContain('./d.sh staging 3');
    expect(res.missingRequired).toEqual([]);
    expect(res.unknown).toEqual([]);
  });

  test('flags missing required inputs', () => {
    const res = applyInputs(`x: $[[ inputs.foo ]]\n`, [{ name: 'foo', required: true }], {});
    expect(res.missingRequired).toEqual(['foo']);
  });

  test('flags unknown inputs and type mismatches', () => {
    const res = applyInputs(`x: $[[ inputs.a ]]\n`, [{ name: 'a', required: false, default: 'x', type: 'string' }], { a: 42, b: 'x' });
    expect(res.unknown).toEqual(['b']);
    expect(res.invalid).toEqual([{ name: 'a', reason: 'expected string' }]);
  });
});
