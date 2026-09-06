const plan = terraformPlan("app", { id: "plan" });
const apply = terraformApply("app", { planFile: stepOutput(plan, "planFile") });
