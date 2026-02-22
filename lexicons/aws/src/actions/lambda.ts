export const LambdaActions = {
  Invoke: ["lambda:InvokeFunction", "lambda:InvokeAsync"],
  ReadOnly: [
    "lambda:GetFunction",
    "lambda:GetFunctionConfiguration",
    "lambda:GetPolicy",
    "lambda:ListVersionsByFunction",
    "lambda:ListAliases",
  ],
  Full: ["lambda:*"],
} as const;
