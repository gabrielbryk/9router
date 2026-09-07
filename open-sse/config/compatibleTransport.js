import { DEFAULT_RETRY_CONFIG } from "./runtimeConfig.js";

// Persisted only on explicitly configured compatible nodes. Absence preserves
// stock provider behavior; validation rejects typoed or unbounded policies.
export function validateCompatibleTransportPolicy(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("transportPolicy must be an object or null");
  for (const key of Object.keys(value)) {
    if (!["maxRetries", "timeoutMs"].includes(key)) throw new TypeError(`Unknown transportPolicy field: ${key}`);
  }
  const result = {};
  if (Object.hasOwn(value, "maxRetries")) {
    if (!Number.isInteger(value.maxRetries) || value.maxRetries < 0 || value.maxRetries > 3) throw new TypeError("transportPolicy.maxRetries must be an integer from 0 to 3");
    result.maxRetries = value.maxRetries;
  }
  if (Object.hasOwn(value, "timeoutMs")) {
    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000) throw new TypeError("transportPolicy.timeoutMs must be an integer from 1000 to 600000");
    result.timeoutMs = value.timeoutMs;
  }
  return result;
}

export function resolveCompatibleTransportPolicy(provider, credentials) {
  if (!/^(openai|anthropic)-compatible-/.test(provider || "")) return {};
  const policy = validateCompatibleTransportPolicy(credentials?.providerSpecificData?.transportPolicy);
  if (!policy) return {};
  const result = {};
  if (policy.maxRetries !== undefined) {
    result.retry = Object.fromEntries(Object.entries(DEFAULT_RETRY_CONFIG).map(([code, entry]) => [code, { attempts: policy.maxRetries, delayMs: entry.delayMs }]));
  }
  if (policy.timeoutMs !== undefined) result.timeoutMs = policy.timeoutMs;
  return result;
}
