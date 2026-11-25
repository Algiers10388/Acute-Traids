/**
 * Minimal PayPal REST client (no SDK) for the Payouts API.
 * Docs: developer.paypal.com/api/payouts  (POST /v1/payments/payouts, GET /v1/payments/payouts/{id})
 *
 * Errors carry `ambiguous: true` when the outcome of a request is unknown (network failure, timeout, HTTP 5xx).
 * Callers must NOT assume such a request failed: money may have moved.
 */

export interface PaypalConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "live";
  baseUrl: string;
}

export interface PaypalAuthorizationIssue {
  status: number;
  name: string;
  debugId?: string;
  env: "sandbox" | "live";
  oauthPayoutScope: boolean;
  message: string;
  actionRequired: string;
  timestamp: number;
}

export function paypalConfig(): PaypalConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !secret) return null;
  const env = (process.env.PAYPAL_ENV || "sandbox").trim().toLowerCase();
  if (env !== "sandbox" && env !== "live") return null;
  return { clientId, secret, env, baseUrl: env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com" };
}

let tokenCache: { key: string; token: string; scope: string; expiresAt: number } | null = null;
let lastAuthorizationIssue: PaypalAuthorizationIssue | null = null;

export function resetPaypalTokenCache() {
  tokenCache = null;
}

export function clearPaypalAuthorizationIssue() {
  lastAuthorizationIssue = null;
}

const TIMEOUT_MS = 20_000;

async function timedFetch(url: string, init: any): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err: any) {
    throw Object.assign(new Error(`PayPal request did not complete (${err?.name === "AbortError" ? "timed out" : err?.message || "network error"}). The outcome is unknown.`), {
      ambiguous: true,
      status: 502,
    });
  } finally {
    clearTimeout(timer);
  }
}

function hasPayoutsScope(scopeStr: string): boolean {
  return scopeStr.toLowerCase().includes("payments/payouts");
}

function buildAuthRemediation(cfg: PaypalConfig, oauthPayoutScope: boolean, debugId?: string): string {
  const steps: string[] = [];
  if (!oauthPayoutScope) {
    steps.push("1) Enable the Payouts feature checkbox on your PayPal Developer App (Apps & Credentials) for this environment, then re-try to mint a new OAuth token.");
  }
  if (cfg.env === "live") {
    steps.push(
      `${steps.length + 1}) Activate Payouts (Mass Pay) on your LIVE PayPal Business account (PayPal Business Account -> Business Tools / Account Settings -> Payouts). PayPal returns 403 AUTHORIZATION_ERROR on Live until the Business account itself is approved for Payouts—even when the Developer App shows Payouts checked.`
    );
    steps.push(
      `${steps.length + 1}) Verify PAYPAL_ENV=live matches Live Client ID/Secret (not Sandbox credentials) and ensure your PayPal Business USD balance is funded.`
    );
  } else {
    steps.push("Verify PAYPAL_ENV=sandbox matches your Sandbox Business REST app and the Sandbox Business facilitator has Payouts enabled.");
  }
  if (debugId) {
    steps.push(`PayPal debug_id: ${debugId}.`);
  }
  return steps.join(" ");
}

async function accessToken(cfg: PaypalConfig): Promise<{ token: string; scope: string }> {
  const key = `${cfg.env}:${cfg.clientId}`;
  if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expiresAt - 60_000) {
    return { token: tokenCache.token, scope: tokenCache.scope };
  }
  const res = await timedFetch(`${cfg.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // Authentication happens before any money request, so this failure is definitive.
    throw Object.assign(
      new Error(json?.error_description || `PayPal authentication failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV.`),
      { status: res.status === 401 || res.status === 403 ? 403 : 502, ambiguous: false }
    );
  }
  const scope = String(json.scope || "");
  tokenCache = {
    key,
    token: json.access_token,
    scope,
    expiresAt: Date.now() + Number(json.expires_in || 300) * 1000,
  };
  return { token: tokenCache.token, scope };
}

export async function paypalRequest(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<any> {
  const cfg = paypalConfig();
  if (!cfg) {
    throw Object.assign(new Error("PayPal is not configured: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV (sandbox|live)."), { status: 503, ambiguous: false });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, scope } = await accessToken(cfg);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await timedFetch(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));

    // Auto-refresh token once on HTTP 401 or 403 in case Payouts entitlement/scopes were just enabled or token expired early.
    // Safe because PayPal-Request-Id enforces idempotency on POST /v1/payments/payouts.
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      resetPaypalTokenCache();
      continue;
    }

    if (!res.ok) {
      const detailIssue = json?.details?.[0]?.issue || json?.name;
      const detailDesc = json?.details?.[0]?.description;
      const rawMsg = json?.message || `PayPal returned HTTP ${res.status}`;
      const isAuthErr = res.status === 401 || res.status === 403 || String(json?.name || "").toUpperCase() === "AUTHORIZATION_ERROR";
      const oauthPayoutScope = hasPayoutsScope(scope);

      if (isAuthErr) {
        const remediation = buildAuthRemediation(cfg, oauthPayoutScope, json?.debug_id);
        const fullAuthMsg = `PayPal ${cfg.env.toUpperCase()} Authorization Error (HTTP ${res.status}, ${json?.name || "AUTHORIZATION_ERROR"}${json?.debug_id ? `, debug_id: ${json.debug_id}` : ""}): ${rawMsg}. ${remediation}`;
        lastAuthorizationIssue = {
          status: res.status,
          name: String(json?.name || "AUTHORIZATION_ERROR"),
          debugId: json?.debug_id,
          env: cfg.env,
          oauthPayoutScope,
          message: rawMsg,
          actionRequired: remediation,
          timestamp: Date.now(),
        };
        throw Object.assign(new Error(fullAuthMsg), {
          status: 403,
          ambiguous: false,
          paypal: {
            name: json?.name || "AUTHORIZATION_ERROR",
            debugId: json?.debug_id,
            env: cfg.env,
            oauthPayoutScope,
            actionRequired: remediation,
          },
        });
      }

      const fullMsg = [rawMsg, detailDesc && !rawMsg.includes(detailDesc) ? detailDesc : null, detailIssue && !rawMsg.includes(detailIssue) ? `(${detailIssue})` : null]
        .filter(Boolean)
        .join(" ");
      throw Object.assign(new Error(fullMsg), {
        status: res.status >= 500 ? 502 : 400,
        ambiguous: res.status >= 500, // a 5xx may have been processed
        paypal: { name: json?.name, debugId: json?.debug_id },
      });
    }

    lastAuthorizationIssue = null;
    return json;
  }
}

export function getPaypalDiagnostics() {
  const cfg = paypalConfig();
  return {
    configured: Boolean(cfg),
    env: cfg?.env ?? null,
    oauthPayoutScope: tokenCache ? hasPayoutsScope(tokenCache.scope) : null,
    lastAuthorizationIssue,
  };
}

/**
 * Verifies live PayPal OAuth authentication, payments/payouts scope, and Payouts endpoint access
 * without sending any money (safe read probe GET /v1/payments/payouts/VERIFYPROBE000000).
 */
export async function verifyPaypalPayoutAuth(forceRefresh = false): Promise<{
  configured: boolean;
  env: "sandbox" | "live";
  oauthOk: boolean;
  payoutScopePresent: boolean;
  readProbeOk: boolean;
  authorizationWarning: string | null;
  lastAuthorizationIssue: PaypalAuthorizationIssue | null;
  message: string;
}> {
  const cfg = paypalConfig();
  if (!cfg) {
    throw Object.assign(new Error("PayPal is not configured: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV."), {
      status: 503,
      ambiguous: false,
    });
  }

  if (forceRefresh) resetPaypalTokenCache();
  const { token, scope } = await accessToken(cfg);
  const payoutScopePresent = hasPayoutsScope(scope);

  const probeRes = await timedFetch(`${cfg.baseUrl}/v1/payments/payouts/VERIFYPROBE000000`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const probeJson: any = await probeRes.json().catch(() => ({}));

  if (probeRes.status === 401 || probeRes.status === 403) {
    const remediation = buildAuthRemediation(cfg, payoutScopePresent, probeJson?.debug_id);
    lastAuthorizationIssue = {
      status: probeRes.status,
      name: String(probeJson?.name || "AUTHORIZATION_ERROR"),
      debugId: probeJson?.debug_id,
      env: cfg.env,
      oauthPayoutScope: payoutScopePresent,
      message: probeJson?.message || "Authorization error occurred.",
      actionRequired: remediation,
      timestamp: Date.now(),
    };
    return {
      configured: true,
      env: cfg.env,
      oauthOk: true,
      payoutScopePresent,
      readProbeOk: false,
      authorizationWarning: remediation,
      lastAuthorizationIssue,
      message: `PayPal ${cfg.env.toUpperCase()} rejected Payouts access (HTTP ${probeRes.status}). ${remediation}`,
    };
  }

  // Note: 404 INVALID_RESOURCE_ID is expected on the non-existent batch id and confirms OAuth bearer + read access work.
  const readProbeOk = probeRes.ok || probeRes.status === 404;
  if (readProbeOk && !lastAuthorizationIssue) {
    return {
      configured: true,
      env: cfg.env,
      oauthOk: true,
      payoutScopePresent,
      readProbeOk: true,
      authorizationWarning: !payoutScopePresent ? buildAuthRemediation(cfg, false) : null,
      lastAuthorizationIssue: null,
      message: payoutScopePresent
        ? `PayPal ${cfg.env.toUpperCase()} OAuth token and Payouts scope verified. Note: Live POST payouts also require Payouts (Mass Pay) to be active on your PayPal Business account.`
        : `PayPal ${cfg.env.toUpperCase()} OAuth succeeded, but the payments/payouts scope is missing from your Developer App.`,
    };
  }

  return {
    configured: true,
    env: cfg.env,
    oauthOk: true,
    payoutScopePresent,
    readProbeOk,
    authorizationWarning: lastAuthorizationIssue?.actionRequired || (!payoutScopePresent ? buildAuthRemediation(cfg, false) : null),
    lastAuthorizationIssue,
    message: lastAuthorizationIssue
      ? `PayPal ${cfg.env.toUpperCase()} OAuth is valid, but a recent payout attempt failed with ${lastAuthorizationIssue.name} (debug_id: ${lastAuthorizationIssue.debugId || "n/a"}). ${lastAuthorizationIssue.actionRequired}`
      : `PayPal ${cfg.env.toUpperCase()} Payouts verification completed (probe HTTP ${probeRes.status}).`,
  };
}

