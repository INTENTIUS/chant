/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "./prior-art";

export const coreAuditLineage: Record<string, Lineage[]> = {
  AGT002: [
    { tool: "agent-audit", rule: "auth-bypass/env-secret-in-config", url: "https://raw.githubusercontent.com/piiiico/agent-audit/main/README.md", relation: "equivalent" },
    { tool: "mcp-audit", rule: "Secrets Detection", url: "https://raw.githubusercontent.com/apisec-inc/mcp-audit/main/README.md", relation: "overlaps" },
    { tool: "agent-scan", rule: "W008", url: "https://raw.githubusercontent.com/invariantlabs-ai/mcp-scan/main/docs/issue-codes.md", relation: "overlaps" },
  ],
  COR020: [
    { tool: "cfn-lint", rule: "E3004", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3004", relation: "equivalent" },
  ],
  EXT001: [
    { tool: "cfn-lint", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/cfn-schema-specification.md#extending-the-schemas-with-new-keywords", relation: "equivalent" },
    { tool: "cfn-lint", rule: "E3014", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3014", relation: "equivalent" },
    { tool: "cfn-lint", rule: "E3021", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3021", relation: "equivalent" },
  ],
  NGX001: [
    { tool: "gixy-ng", rule: "weak_ssl_tls", url: "https://gixy.getpagespeed.com/plugins/weak_ssl_tls/", relation: "overlaps" },
  ],
  NGX002: [
    { tool: "gixy-ng", rule: "weak_ssl_tls", url: "https://gixy.getpagespeed.com/plugins/weak_ssl_tls/", relation: "overlaps" },
  ],
  NGX004: [
    { tool: "gixy", rule: "alias_traversal", url: "https://github.com/yandex/gixy", relation: "equivalent" },
    { tool: "gixy-ng", rule: "alias_traversal", url: "https://gixy.getpagespeed.com/plugins/aliastraversal/", relation: "equivalent" },
  ],
  NGX005: [
    { tool: "gixy-ng", rule: "status_page_exposed", url: "https://gixy.getpagespeed.com/checks/status-page-exposed/", relation: "overlaps" },
  ],
  NGX006: [
    { tool: "gixy-ng", rule: "version_disclosure", url: "https://gixy.getpagespeed.com/plugins/version_disclosure/", relation: "equivalent" },
  ],
  SEC001: [
    { tool: "gitleaks", rule: "aws-access-token", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "equivalent" },
    { tool: "trufflehog", rule: "aws", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/aws/access_keys/accesskey.go", relation: "overlaps" },
    { tool: "detect-secrets", rule: "AWSKeyDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/aws.py", relation: "equivalent" },
  ],
  SEC002: [
    { tool: "gitleaks", rule: "generic-api-key", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
    { tool: "trufflehog", rule: "aws", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/aws/access_keys/accesskey.go", relation: "overlaps" },
    { tool: "detect-secrets", rule: "AWSKeyDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/aws.py", relation: "overlaps" },
  ],
  SEC003: [
    { tool: "gitleaks", rule: "github-pat", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
    { tool: "trufflehog", rule: "github", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/github/v2/github.go", relation: "equivalent" },
    { tool: "detect-secrets", rule: "GitHubTokenDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/github_token.py", relation: "overlaps" },
  ],
  SEC004: [
    { tool: "gitleaks", rule: "slack-bot-token", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
    { tool: "trufflehog", rule: "slack", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/slack/slack.go", relation: "overlaps" },
    { tool: "detect-secrets", rule: "SlackDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/slack.py", relation: "overlaps" },
  ],
  SEC005: [
    { tool: "gitleaks", rule: "gcp-api-key", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "equivalent" },
    { tool: "trufflehog", rule: "googlegemini", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/googlegemini/googlegemini.go", relation: "overlaps" },
  ],
  SEC006: [
    { tool: "gitleaks", rule: "stripe-access-token", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
    { tool: "trufflehog", rule: "stripe", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/stripe/stripe.go", relation: "overlaps" },
    { tool: "detect-secrets", rule: "StripeDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/stripe.py", relation: "overlaps" },
  ],
  SEC007: [
    { tool: "gitleaks", rule: "private-key", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "equivalent" },
    { tool: "trufflehog", rule: "privatekey", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/privatekey/privatekey.go", relation: "equivalent" },
    { tool: "detect-secrets", rule: "PrivateKeyDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/private_key.py", relation: "equivalent" },
  ],
  SEC008: [
    { tool: "gitleaks", rule: "curl-auth-header", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
  ],
  SEC009: [
    { tool: "detect-secrets", rule: "BasicAuthDetector", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/basic_auth.py", relation: "equivalent" },
    { tool: "trufflehog", rule: "uri", url: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/uri/uri.go", relation: "overlaps" },
    { tool: "gitleaks", rule: "curl-auth-user", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
  ],
  SEC010: [
    { tool: "detect-secrets", rule: "Base64HighEntropyString", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py", relation: "overlaps" },
    { tool: "detect-secrets", rule: "HexHighEntropyString", url: "https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py", relation: "overlaps" },
    { tool: "gitleaks", rule: "generic-api-key", url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml", relation: "overlaps" },
  ],
};
