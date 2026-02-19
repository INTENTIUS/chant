import type { LexiconPlugin } from "../../lexicon";

/**
 * LSP server capabilities, conditionally advertised based on loaded plugins.
 */
export interface LspCapabilities {
  textDocumentSync: number;
  completionProvider?: { triggerCharacters: string[] };
  hoverProvider?: boolean;
  codeActionProvider?: boolean;
  diagnosticProvider?: { interFileDependencies: boolean; workspaceDiagnostics: boolean };
}

/**
 * Compute LSP capabilities based on which plugins implement providers.
 */
export function computeCapabilities(plugins: LexiconPlugin[]): LspCapabilities {
  const hasCompletion = plugins.some((p) => p.completionProvider !== undefined);
  const hasHover = plugins.some((p) => p.hoverProvider !== undefined);
  const hasCodeAction = plugins.some((p) => p.codeActionProvider !== undefined);

  const capabilities: LspCapabilities = {
    // Full sync — client sends full document content on open/change
    textDocumentSync: 1,
    diagnosticProvider: {
      interFileDependencies: false,
      workspaceDiagnostics: false,
    },
  };

  if (hasCompletion) {
    capabilities.completionProvider = {
      triggerCharacters: [".", " ", '"', "'", "`", "("],
    };
  }

  if (hasHover) {
    capabilities.hoverProvider = true;
  }

  if (hasCodeAction) {
    capabilities.codeActionProvider = true;
  }

  return capabilities;
}
