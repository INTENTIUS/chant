import { describeWorkspaceReaderConformance } from "./workspace-reader-conformance";
import { minimalReader } from "./minimal-reader";

// The minimal reader, its calls answered by chant serve mcp's workspace tools (#2707): each tool's
// document must be the one the command prints. Each case starts the CLI and the MCP server, and
// under a loaded CI shard graph --composites went past the 15s unit budget (#3019), so this run
// lives in the e2e project. The CLI run stays in workspace-reader-conformance.test.ts.
describeWorkspaceReaderConformance({ name: "the minimal reader", reader: minimalReader, over: "mcp" });
