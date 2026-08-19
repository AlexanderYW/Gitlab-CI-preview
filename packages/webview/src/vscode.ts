interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}
declare function acquireVsCodeApi(): VsCodeApi;
let api: VsCodeApi | null = null;
export function vscode(): VsCodeApi {
  if (api) return api;
  api = acquireVsCodeApi();
  return api;
}
