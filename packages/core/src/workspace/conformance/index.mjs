// The entry of `@intentius/chant/workspace/conformance` for plain Node
// (#2679): the reader suite, and the writer suite (#3159). The suites are
// written in TypeScript like the rest of the package, and Node does not
// strip types under node_modules, so this file loads them through tsx, a
// dependency of this package. `node --test` runs a reader's or a writer's
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
  UNCOMMITTED_DECISION,
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
  sameReadDocument,
  startMcpSession,
  createConformanceWorkspace,
  conformanceTarget,
  recordingTransport,
  readAndCheck,
  runWorkspaceReaderConformance,
  runChant,
  WRITE_CONTRACT_ACTIONS,
  WRITE_CONTRACT_SCHEMAS,
  WRITE_CONTRACT_JSON_FLAGS,
  WRITER_KINDS,
  WRITER_PRINCIPALS,
  WRITER_SCRIPT,
  WRITER_FIXTURE_DIR,
  PRIVATE_STATE_CATEGORIES,
  writeArgv,
  writeContractSchema,
  worktreeDigest,
  gitRefs,
  refChanges,
  isReadCall,
  writerCallProblems,
  writerDocumentProblems,
  reportedWrites,
  unreportedChanges,
  buildStep,
  referenceWriter,
  createWriterConformanceWorkspace,
  selectActions,
  undeclaredState,
  runWorkspaceWriterConformance,
} = suite;
