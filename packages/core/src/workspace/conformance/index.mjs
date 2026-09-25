// The entry of `@intentius/chant/workspace/conformance` for plain Node
// (#2679). The suite is written in TypeScript like the rest of the package,
// and Node does not strip types under node_modules, so this file loads it
// through tsx, a dependency of this package. `node --test` runs a reader's
// test file that imports it with no loader flag. Types come from
// dist/workspace/conformance/index.d.ts.

import { tsImport } from "tsx/esm/api";

const suite = await tsImport("./index.ts", import.meta.url);

export const {
  READ_CONTRACT_COMMANDS,
  READ_CONTRACT_SCHEMAS,
  READ_CONTRACT_JSON_FLAGS,
  REFERENCE_READS,
  CONFORMANCE_FIXTURE_DIR,
  defaultChantCommand,
  referenceWorkspaceDir,
  readContractSchema,
  treeDigest,
  treeChanges,
  readerCallProblems,
  checkReaderRead,
  selectCommands,
  MCP_READ_TOOLS,
  mcpToolCall,
  startMcpSession,
  createConformanceWorkspace,
  conformanceTarget,
  recordingTransport,
  readAndCheck,
  runWorkspaceReaderConformance,
} = suite;
