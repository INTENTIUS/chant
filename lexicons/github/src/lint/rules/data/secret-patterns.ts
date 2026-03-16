/**
 * Regex patterns for detecting hardcoded secrets in source code.
 */

export const secretPatterns: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/, description: "AWS Access Key ID" },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, description: "Private Key" },
  { pattern: /sk_live_[a-zA-Z0-9]{20,}/, description: "Stripe Live Secret Key" },
  { pattern: /xox[bpors]-[a-zA-Z0-9-]{10,}/, description: "Slack Token" },
  { pattern: /AIza[0-9A-Za-z_-]{35}/, description: "Google API Key" },
  { pattern: /AC[a-z0-9]{32}/, description: "Twilio Account SID" },
  { pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/, description: "SendGrid API Key" },
  { pattern: /key-[a-zA-Z0-9]{32}/, description: "Mailgun API Key" },
  { pattern: /npm_[a-zA-Z0-9]{36}/, description: "NPM Token" },
  { pattern: /pypi-[a-zA-Z0-9_-]{50,}/, description: "PyPI Token" },
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, description: "JWT Token" },
  { pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, description: "Heroku API Key (UUID)" },
  { pattern: /dop_v1_[a-f0-9]{64}/, description: "DigitalOcean Personal Access Token" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, description: "GitHub Personal Access Token" },
  { pattern: /ghs_[a-zA-Z0-9]{36}/, description: "GitHub Server-to-Server Token" },
  { pattern: /ghu_[a-zA-Z0-9]{36}/, description: "GitHub User-to-Server Token" },
  { pattern: /ghr_[a-zA-Z0-9]{36}/, description: "GitHub Refresh Token" },
  { pattern: /gho_[a-zA-Z0-9]{36}/, description: "GitHub OAuth Token" },
  { pattern: /github_pat_[a-zA-Z0-9_]{22,}/, description: "GitHub Fine-grained PAT" },
  { pattern: /glpat-[a-zA-Z0-9_-]{20,}/, description: "GitLab Personal Access Token" },
  { pattern: /sk-[a-zA-Z0-9]{48}/, description: "OpenAI API Key" },
  { pattern: /r8_[a-zA-Z0-9]{37}/, description: "Replicate API Token" },
  { pattern: /sq0atp-[a-zA-Z0-9_-]{22}/, description: "Square Access Token" },
  { pattern: /shpat_[a-fA-F0-9]{32}/, description: "Shopify Admin API Token" },
  { pattern: /shr[a-z]{2}_[a-f0-9]{32}/, description: "Shopify Shared Secret" },
];
