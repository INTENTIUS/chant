import { describeWorkspaceReaderConformance } from "./workspace-reader-conformance";
import { minimalReader } from "./minimal-reader";

// The minimal reader, its calls answered by the CLI. Each case starts the CLI, up to 7s a test on a
// loaded CI runner, past the unit project's 5s budget, so this run is in the e2e project. The
// reader-call checks that need no CLI stay in workspace-reader-conformance.test.ts; the same reader
// over chant serve mcp is in workspace-reader-conformance.e2e.test.ts.
describeWorkspaceReaderConformance({ name: "the minimal reader", reader: minimalReader });
