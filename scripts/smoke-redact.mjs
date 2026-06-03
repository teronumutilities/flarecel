import { redactSecrets } from "../dist/redact.js";

const cases = [
  ["Authorization: Bearer sk-abc123DEF456._~+/=-", "Bearer <redacted>"],
  ["BETTER_AUTH_SECRET=super-secret-value", "BETTER_AUTH_SECRET=<redacted>"],
  ["CLOUDFLARE_API_TOKEN: tok_live_9f8e7d", "CLOUDFLARE_API_TOKEN: <redacted>"],
  ["MY_PASSWORD = hunter2", "MY_PASSWORD = <redacted>"],
  ["STRIPE_API_KEY=rk_test_xyz", "STRIPE_API_KEY=<redacted>"]
];

for (const [input, expectedFragment] of cases) {
  const output = redactSecrets(input);
  if (!output.includes(expectedFragment)) {
    throw new Error(`Expected redaction to contain "${expectedFragment}", got "${output}"`);
  }
  const secret = input.split(/[:=]\s*/).pop();
  if (output.includes(secret)) {
    throw new Error(`Secret value leaked through redaction: "${output}"`);
  }
}

const safe = "Created database my-app-db with id 1a2b3c";
if (redactSecrets(safe) !== safe) {
  throw new Error(`Non-secret output should be unchanged, got "${redactSecrets(safe)}"`);
}
