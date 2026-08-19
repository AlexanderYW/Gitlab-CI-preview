import type { CodeLens } from 'vscode-languageserver';

export function codeLenses(uri: string): CodeLens[] {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return [
    {
      range,
      command: {
        title: '$(graph) Show Pipeline Graph',
        command: 'gitlabCi.showGraph',
        arguments: [uri],
      },
    },
  ];
}
