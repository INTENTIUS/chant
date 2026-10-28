/**
 * The fan-out demo's two contracts, demo-step/v1 and demo-cycle/v1 (#4085
 * section 3, #4092). The schemas and their validators moved into the e2e
 * harness (chant#4587, packages/core/src/e2e-harness/schemas/), which every
 * product's driver shares; the demo reads them from there.
 */
export {
  DEMO_STEPS,
  validateDemoCycle,
  validateDemoStep,
  type DemoChapter,
  type DemoCycle,
  type DemoCycleReport,
  type DemoCycleStep,
  type DemoHighlight,
  type DemoReports,
  type DemoStep,
  type DemoStepName,
  type Validation,
} from "../../../../packages/core/src/e2e-harness/schemas/index.js";
