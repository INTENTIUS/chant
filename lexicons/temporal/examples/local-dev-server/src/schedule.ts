import { TemporalSchedule } from "@intentius/chant-lexicon-temporal";

/**
 * A nightly maintenance workflow, scheduled to run at 2am against the
 * "my-app" namespace's default task queue.
 */
export const nightlyMaintenance = new TemporalSchedule({
  scheduleId: "nightly-maintenance",
  spec: {
    cronExpressions: ["0 2 * * *"],
  },
  action: {
    workflowType: "maintenanceWorkflow",
    taskQueue: "my-app",
  },
  policies: {
    overlap: "Skip",
  },
  namespace: "my-app",
});
