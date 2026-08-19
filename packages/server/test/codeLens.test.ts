import { describe, expect, test } from 'bun:test';
import { codeLenses } from '../src/features/codeLens.js';

const URI = 'file:///root/.gitlab-ci.yml';

describe('codeLenses', () => {
  test('emits a single Show Pipeline Graph lens at the top of the file', () => {
    const lenses = codeLenses(URI);
    expect(lenses.length).toBe(1);
    expect(lenses[0].command?.command).toBe('gitlabCi.showGraph');
    expect(lenses[0].command?.arguments).toEqual([URI]);
    expect(lenses[0].range.start).toEqual({ line: 0, character: 0 });
  });
});
