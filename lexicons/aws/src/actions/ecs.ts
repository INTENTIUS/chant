export const ECSActions = {
  RunTask: ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"],
  Service: ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices"],
  Full: ["ecs:*"],
} as const;
