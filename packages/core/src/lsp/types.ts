/**
 * Simplified LSP types for lexicon plugin contributions.
 * No dependency on vscode-languageserver — just plain interfaces.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export type CompletionItemKind =
  | "resource"
  | "property"
  | "intrinsic"
  | "pseudo-parameter"
  | "value";

export interface CompletionItem {
  label: string;
  insertText?: string;
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string;
}

export interface CompletionContext {
  uri: string;
  content: string;
  position: Position;
  wordAtCursor: string;
  linePrefix: string;
}

export interface HoverInfo {
  contents: string;
  range?: Range;
}

export interface HoverContext {
  uri: string;
  content: string;
  position: Position;
  word: string;
  lineText: string;
}

export type CodeActionKind = "quickfix" | "refactor" | "source";

export interface CodeAction {
  title: string;
  kind: CodeActionKind;
  edits?: TextEdit[];
  diagnosticRuleId?: string;
  isPreferred?: boolean;
}

export interface CodeActionContext {
  uri: string;
  content: string;
  range: Range;
  diagnostics: CodeActionDiagnostic[];
}

export interface CodeActionDiagnostic {
  range: Range;
  message: string;
  ruleId?: string;
  severity?: "error" | "warning" | "info";
}
