import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../config/errorConfig.js";
import REGISTRY from "../providers/registry/index.js";
import { modelKind, modelQuotaFamily, normalizeModelId, QUOTA_SCOPE_FAMILY } from "../providers/models/schema.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

// provider id / alias -> registry entry, built once on first quota-scope lookup
let providerEntryIndex = null;
function findProviderEntry(provider) {
  if (!provider) return null;
  if (!providerEntryIndex) {
    providerEntryIndex = new Map();
    for (const entry of REGISTRY) {
      if (entry?.id) providerEntryIndex.set(entry.id, entry);
    }
    for (const entry of REGISTRY) {
      for (const alias of [entry?.alias, entry?.uiAlias]) {
        if (alias && !providerEntryIndex.has(alias)) providerEntryIndex.set(alias, entry);
      }
    }
  }
  return providerEntryIndex.get(provider) || null;
}

/**
 * Resolve the quota scope a rate-limit lock belongs to — the single source of truth for
 * what a `modelLock_*` key is keyed on.
 *
 * Most providers meter per model, so the scope IS the model id and locking stays per model.
 * Some providers meter per quota FAMILY: several model ids draw down one shared upstream
 * window. OpenAI Codex is the case this exists for — `gpt-6-astra`, `gpt-5.6-sol/terra/luna`,
 * `gpt-5.5`, `gpt-5.4*` all consume the same `rate_limit.primary_window`, while
 * `gpt-5.3-codex-spark` reports its own window (`additional_rate_limits[].metered_feature`)
 * and code review has yet another (`code_review_rate_limit`). Locking such a provider per
 * model id means every sibling has to independently burn a request and eat its own 429
 * against a window that is already known to be exhausted, and account fallback rotates
 * through those siblings before it rotates to the next account.
 *
 * A provider opts in with `quotaScope: QUOTA_SCOPE_FAMILY` in its registry entry; the
 * family per model comes from the registry's `quotaFamily` field. Anything without that
 * opt-in — or any non-chat model, whose usage is not part of the reported chat windows —
 * falls back to the raw model id, i.e. exactly the pre-existing per-model behavior.
 *
 * @param {string|null} provider - provider id or alias (e.g. "codex", "cx")
 * @param {string|null} model - model id, or null for an account-wide lock
 * @returns {string|null} lock scope ("codex:normal", "codex:spark", "gpt-4o", …), or null when model is null
 */
export function resolveQuotaScope(provider, model) {
  if (!model) return null;
  const entry = findProviderEntry(provider);
  if (entry?.quotaScope !== QUOTA_SCOPE_FAMILY) return model;
  const wanted = normalizeModelId(model);
  const modelEntry = (entry.models || [])
    .find(m => normalizeModelId(typeof m === "string" ? m : m?.id) === wanted);
  if (!modelEntry || modelKind(modelEntry) !== "llm") return model;
  return `${entry.id}:${modelQuotaFamily(modelEntry)}`;
}

/**
 * Human-readable label for a lock scope, for UI that lists cooling-down entries.
 * Family scopes ("codex:spark") read as "spark quota"; per-model scopes stay the
 * model id. The raw scope remains the identifier — only the display text changes.
 * @param {string} scope - value from a modelLock_* key
 * @returns {string}
 */
export function formatQuotaScopeLabel(scope) {
  if (!scope || scope === "__all") return "all models";
  const separator = scope.indexOf(":");
  return separator === -1 ? scope : `${scope.slice(separator + 1)} quota`;
}

/**
 * Build the flat field key for a model lock.
 * @param {string|null} model
 * @param {string|null} provider - provider id/alias; enables family-scoped locks
 */
export function getModelLockKey(model, provider = null) {
  const scope = resolveQuotaScope(provider, model);
  return scope ? `${MODEL_LOCK_PREFIX}${scope}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${scope}` (or `modelLock___all` when model=null),
 * where scope comes from resolveQuotaScope — the same resolver the write path uses.
 */
export function isModelLockActive(connection, model, provider = null) {
  const key = getModelLockKey(model, provider ?? connection?.provider ?? null);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 * @param {string|null} model
 * @param {number} cooldownMs
 * @param {string|null} provider - provider id/alias; enables family-scoped locks
 */
export function buildModelLockUpdate(model, cooldownMs, provider = null) {
  const key = getModelLockKey(model, provider);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
