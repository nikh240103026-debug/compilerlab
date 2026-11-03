// The editor by itself, without the bundled languages and their heavy workers. This is the
// list from monaco-editor's own editor.main.js, minus the diff editor and language services.
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js';
import 'monaco-editor/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js';
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
import 'monaco-editor/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import 'monaco-editor/languages/definitions/cpp/register.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.start.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// One small definition for .l and .y files: their structure, and C words in the actions.
const LEX_LANGUAGE: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  keywords: [
    'auto',
    'break',
    'case',
    'char',
    'const',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extern',
    'float',
    'for',
    'if',
    'int',
    'long',
    'register',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'struct',
    'switch',
    'typedef',
    'union',
    'unsigned',
    'void',
    'volatile',
    'while',
  ],
  builtins: [
    'yytext',
    'yyleng',
    'yylineno',
    'yylex',
    'yywrap',
    'yyin',
    'yyout',
    'yylval',
    'ECHO',
    'BEGIN',
    'REJECT',
    'INITIAL',
    'yymore',
    'yyless',
    'input',
    'unput',
    'yyterminate',
    'printf',
  ],
  tokenizer: {
    root: [
      [/^%%\s*$/, 'keyword.control'],
      [/^%[{}]\s*$/, 'keyword.control'],
      [/^%\w+/, 'keyword.control'],
      [/^<[\w,*]+>/, 'type'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
      [/"([^"\\\n]|\\.)*"/, 'string'],
      [/'([^'\\\n]|\\.)*'/, 'string'],
      [/\{[A-Za-z_][\w-]*\}/, 'variable'],
      [/\[(\\.|[^\]\\\n])*\]/, 'regexp'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [
        /[A-Za-z_]\w*/,
        { cases: { '@keywords': 'keyword', '@builtins': 'predefined', '@default': 'identifier' } },
      ],
    ],
    comment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment'],
    ],
  },
};

monaco.languages.register({ id: 'lex', extensions: ['.l', '.y'], aliases: ['Lex', 'Yacc'] });
monaco.languages.setMonarchTokensProvider('lex', LEX_LANGUAGE);

export { monaco };

export function languageFor(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'l' || extension === 'y') return 'lex';
  if (extension === 'c' || extension === 'h') return 'c';
  if (extension === 'cpp' || extension === 'hpp') return 'cpp';
  return 'plaintext';
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Builds the editor theme from the design tokens, so it follows the app in light and dark. */
export function applyEditorTheme(isDark: boolean): void {
  monaco.editor.defineTheme('compilerlab', {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cssColor('--surface'),
      'editor.foreground': cssColor('--ink'),
      'editorLineNumber.foreground': cssColor('--ink-muted'),
      'editorCursor.foreground': cssColor('--accent'),
      'editor.lineHighlightBackground': cssColor('--surface-2'),
      'editorError.foreground': cssColor('--danger'),
      'editorWarning.foreground': cssColor('--warning'),
    },
  });
  monaco.editor.setTheme('compilerlab');
}
