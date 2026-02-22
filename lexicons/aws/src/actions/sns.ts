export const SNSActions = {
  Publish: ["sns:Publish"],
  Subscribe: ["sns:Subscribe", "sns:Unsubscribe"],
  Full: ["sns:*"],
} as const;
