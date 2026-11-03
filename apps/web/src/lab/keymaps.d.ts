// monaco-emacs ships no types. This is the part of it the editor uses.
declare module 'monaco-emacs' {
  export class EmacsExtension {
    constructor(editor: unknown);
    start(): void;
    dispose(): void;
  }
}

declare module 'monaco-vim' {
  export function initVimMode(editor: unknown, statusBar: HTMLElement): { dispose(): void };
}
