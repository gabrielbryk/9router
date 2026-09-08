/**
 * Codex (OpenAI) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: U("codex").url,
  resetCreditsUrl: U("codex").resetCreditsUrl,
  resetCreditsConsumeUrl: U("codex").resetCreditsConsumeUrl,
};

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function errorMessage(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

function getCodexAccountId(providerSpecificData) {
  return providerSpecificData?.workspaceId || providerSpecificData?.accountId || providerSpecificData?.chatgptAccountId || null;
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

/**
 * OpenAI exposes two Codex quota horizons: a short rolling window (5h) and a
 * long one (7d). Which SLOT each lands in is plan-dependent — Pro accounts put
 * the 7-day window in `primary_window` and leave `secondary_window` null — so
 * windows must be classified by their real `limit_window_seconds`, never by
 * slot position. The thresholds below are deliberately loose bands around the
 * documented 5h/7d durations so minor upstream tweaks still classify sanely.
 */
const CODEX_WINDOW_SECONDS = {
  // <= 6h: the short rolling window the dashboard labels "5h".
  SESSION_MAX: 6 * 60 * 60,
  // >= 24h: a long-horizon window the dashboard labels "Weekly".
  WEEKLY_MIN: 24 * 60 * 60,
};

// Quota keys consumed by ProviderLimits/utils.js (optionally prefixed with a family).
const CODEX_WINDOW_KEY = {
  SESSION: "session",
  WEEKLY: "weekly",
};

// Unexpected durations get surfaced under `window_<seconds>` rather than being mislabeled.
const CODEX_UNKNOWN_WINDOW_KEY_PREFIX = "window_";

/**
 * Read a window's true duration in seconds.
 * @param {object|null|undefined} window Raw window payload.
 * @returns {number|null} Positive finite seconds, or null when the payload omits it.
 */
function getCodexWindowSeconds(window) {
  const raw = window?.limit_window_seconds ?? window?.window_seconds ?? window?.windowSeconds ?? null;
  const seconds = toFiniteNumber(raw, null);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Classify a raw window into a quota key by its actual duration.
 * Falls back to the legacy positional key when the payload has no duration.
 * @param {object|null|undefined} window Raw window payload.
 * @param {string} positionalKey Legacy slot-derived key ("session" | "weekly").
 * @returns {string} Unprefixed quota key.
 */
function classifyCodexWindowKey(window, positionalKey) {
  const seconds = getCodexWindowSeconds(window);
  if (seconds === null) return positionalKey;
  if (seconds <= CODEX_WINDOW_SECONDS.SESSION_MAX) return CODEX_WINDOW_KEY.SESSION;
  if (seconds >= CODEX_WINDOW_SECONDS.WEEKLY_MIN) return CODEX_WINDOW_KEY.WEEKLY;
  return `${CODEX_UNKNOWN_WINDOW_KEY_PREFIX}${Math.round(seconds)}`;
}

/**
 * Normalize one rate-limit window into the dashboard quota shape.
 * @param {object|null|undefined} window Raw window payload.
 * @returns {{used:number,total:number,remaining:number,resetAt:string|null,unlimited:boolean,windowSeconds:number|null}}
 */
function formatCodexWindow(window) {
  const used = Math.max(0, Math.min(100, toFiniteNumber(window?.used_percent ?? window?.percent_used, 0)));
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt: parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null),
    unlimited: false,
    // Finite seconds when the payload provides a duration, otherwise null.
    windowSeconds: getCodexWindowSeconds(window),
  };
}

/**
 * Store one classified window under `<prefix>_<key>`.
 *
 * INVARIANT: a window NEVER overwrites a window a previous slot already stored.
 * Two slots can legitimately classify to the same key (e.g. a 7d primary and a
 * 30d secondary are both "weekly"), so the key is resolved through a chain that
 * is guaranteed to terminate on a free slot: classified key → positional key →
 * duration-derived `window_<seconds>` key → that key with a numeric suffix.
 * Surfacing a window under an odd key is always preferable to dropping it.
 */
function assignCodexQuotaWindow(quotas, prefix, window, positionalKey) {
  const withPrefix = (key) => (prefix ? `${prefix}_${key}` : key);
  const seconds = getCodexWindowSeconds(window);
  const candidates = [
    classifyCodexWindowKey(window, positionalKey),
    positionalKey,
  ];
  if (seconds !== null) {
    candidates.push(`${CODEX_UNKNOWN_WINDOW_KEY_PREFIX}${Math.round(seconds)}`);
  }

  let key = candidates.map(withPrefix).find((candidate) => !(candidate in quotas));
  if (!key) {
    // Every preferred key is taken — disambiguate rather than drop the window.
    const base = withPrefix(candidates[candidates.length - 1]);
    let suffix = 2;
    while (`${base}_${suffix}` in quotas) suffix += 1;
    key = `${base}_${suffix}`;
  }

  quotas[key] = formatCodexWindow(window);
}

/**
 * Append a rate-limit family's windows to the quota map.
 * Shared by the main, `spark_` and `review_` families.
 * @returns {boolean} Whether any window was added.
 */
function appendCodexQuotaWindows(quotas, prefix, snapshot) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  let added = false;

  if (primary) {
    assignCodexQuotaWindow(quotas, prefix, primary, CODEX_WINDOW_KEY.SESSION);
    added = true;
  }
  if (secondary) {
    assignCodexQuotaWindow(quotas, prefix, secondary, CODEX_WINDOW_KEY.WEEKLY);
    added = true;
  }

  return added;
}

/**
 * Normalize `model_usage` (model id -> availability).
 * DISPLAY/DATA ONLY: this is not consumed by routing or dispatch today —
 * wiring model availability into model selection is a deliberate follow-up.
 * @returns {Record<string,{available:boolean,availableAt:string|null,creditsWouldEnable:boolean}>|null}
 */
function normalizeCodexModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;

  const normalized = {};
  for (const [modelId, entry] of Object.entries(modelUsage)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    normalized[modelId] = {
      available: entry.available === true,
      availableAt: toIsoDate(entry.available_at ?? entry.availableAt),
      creditsWouldEnable: entry.credits_would_enable === true,
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Normalize `spend_control.individual_limit` (money fields arrive as strings).
 */
function normalizeCodexSpendLimit(limit) {
  if (!limit || typeof limit !== "object" || Array.isArray(limit)) return null;
  return {
    source: typeof limit.source === "string" ? limit.source : null,
    limit: toFiniteNumber(limit.limit, null),
    used: toFiniteNumber(limit.used, null),
    remaining: toFiniteNumber(limit.remaining, null),
    usedPercent: toFiniteNumber(limit.used_percent, null),
    remainingPercent: toFiniteNumber(limit.remaining_percent, null),
    resetAfterSeconds: toFiniteNumber(limit.reset_after_seconds, null),
    resetAt: toIsoDate(limit.reset_at ?? limit.resetAt),
  };
}

/**
 * Normalize `spend_control`.
 */
function normalizeCodexSpendControl(spendControl) {
  if (!spendControl || typeof spendControl !== "object" || Array.isArray(spendControl)) return null;
  return {
    reached: spendControl.reached === true,
    individualLimit: normalizeCodexSpendLimit(spendControl.individual_limit ?? spendControl.individualLimit),
  };
}

/**
 * Normalize the `credits` block (balance arrives as a numeric string or null).
 */
function normalizeCodexCredits(credits) {
  if (!credits || typeof credits !== "object" || Array.isArray(credits)) return null;
  return {
    hasCredits: credits.has_credits === true,
    unlimited: credits.unlimited === true,
    overageLimitReached: credits.overage_limit_reached === true,
    balance: toFiniteNumber(credits.balance, null),
  };
}

function getCodexReviewRateLimit(data) {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

function getCodexSparkRateLimit(data) {
  if (data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit) {
    return data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId["gpt-5.3-codex-spark"] || byLimitId.gpt_5_3_codex_spark || byLimitId.spark || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id.includes("spark") || id.includes("5.3-codex-spark");
  }) || null;
}

export async function getCodexUsage(accessToken, proxyOptions = null) {
  try {
    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(data);
    const sparkRateLimit = getCodexSparkRateLimit(data);
    const resetCreditsPayload = data.rate_limit_reset_credits || null;
    const availableResetCredits = Math.max(0, toFiniteNumber(resetCreditsPayload?.available_count, 0));
    // Credits can exist yet be non-redeemable against the current windows.
    const applicableResetCredits = Math.max(0, toFiniteNumber(resetCreditsPayload?.applicable_available_count, 0));
    const quotas = {};

    appendCodexQuotaWindows(quotas, "", normalRateLimit);
    appendCodexQuotaWindows(quotas, "review", reviewRateLimit);
    appendCodexQuotaWindows(quotas, "spark", sparkRateLimit);

    return {
      plan: data.plan_type || data.summary?.plan || "unknown",
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      sparkLimitReached: getCodexRateLimitBody(sparkRateLimit)?.limit_reached || false,
      resetCredits: {
        availableCount: availableResetCredits,
        applicableCount: applicableResetCredits,
      },
      quotas,
      modelUsage: normalizeCodexModelUsage(data.model_usage),
      spendControl: normalizeCodexSpendControl(data.spend_control),
      credits: normalizeCodexCredits(data.credits),
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

export async function getCodexRateLimitResetCredits(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }

  const accountId = getCodexAccountId(providerSpecificData);
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "codex_cli_rs",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  const response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsUrl, {
    method: "GET",
    headers,
  }, proxyOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = errorMessage(data?.message || data?.error || data?.detail, `Codex reset credits API unavailable (${response.status}).`);
    throw new Error(message);
  }

  const credits = Array.isArray(data?.credits) ? data.credits : [];
  return {
    availableCount: Math.max(0, toFiniteNumber(data?.available_count ?? data?.availableCount, 0)),
    credits: credits.map((credit) => ({
      status: String(credit?.status || "unknown"),
      grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
      expiresAt: toIsoDate(credit?.expires_at ?? credit?.expiresAt),
    })),
  };
}

// Consume one Codex rate-limit reset credit (irreversible, spends 1 credit)
export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (!redeemRequestId || typeof redeemRequestId !== "string") {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to consume Codex reset credit: ${error.message}`);
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  const success = response.ok && (code === "reset" || windowsReset > 0);

  return {
    ok: success,
    noCredit: response.ok && code === "no_credit",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}
