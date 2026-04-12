import { TemporalSchedule } from "@intentius/chant-lexicon-temporal";

export const dailySync = new TemporalSchedule({
  scheduleId: "daily-sync",
  namespace: "my-app",
  spec: {
    cronExpressions: ["0 8 * * *"],
  },
  action: {
    workflowType: "syncWorkflow",
    taskQueue: "my-app",
    workflowExecutionTimeout: "30m",
  },
  policies: {
    overlap: "Skip",
    pauseOnFailure: true,
  },
});
