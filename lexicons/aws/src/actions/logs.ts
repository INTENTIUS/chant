export const LogsActions = {
  Write: ["logs:CreateLogStream", "logs:PutLogEvents"],
  Full: ["logs:*"],
} as const;
