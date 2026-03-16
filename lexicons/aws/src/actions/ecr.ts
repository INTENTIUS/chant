export const ECRActions = {
  Pull: [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage",
  ],
  Full: ["ecr:*"],
} as const;
