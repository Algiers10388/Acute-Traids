/**
 * Minimal Increase Banking REST client (no SDK) for Remote Deposit Capture (Check 21).
 *
 * Docs: increase.com/documentation/api
 *   1. POST /files          (purpose: "check_image_front" | "check_image_back")
 *   2. POST /check_deposits (account_id, amount in cents, front_image_file_id, back_image_file_id)
 *   3. GET  /check_deposits/{id} (authoritative status: pending | submitted | rejected | returned)
 */

export interface IncreaseConfig {
  apiKey: string;
  accountId: string;
  env: "sandbox" | "production";
  baseUrl: string;
  envNotice?: string;
}

const TIMEOUT_MS = 20_000;
const resolvedAccountCache = new Map<string, string>();

export function increaseConfig(): IncreaseConfig | null {
  const apiKey = process.env.INCREASE_API_KEY?.trim();
  const accountId = process.env.INCREASE_ACCOUNT_ID?.trim();
  if (!apiKey || !accountId) return null;

  const isSandboxKey = apiKey.startsWith("increase_sandbox_key_") || apiKey.startsWith("sandbox_");
  const rawEnvInput = (process.env.INCREASE_ENV || (isSandboxKey ? "sandbox" : "production")).trim().toLowerCase();
  const normalizedRequested = rawEnvInput === "live" ? "production" : rawEnvInput;
  if (normalizedRequested !== "sandbox" && normalizedRequested !== "production") return null;

  // Increase rejects sandbox keys sent to https://api.increase.com (HTTP 401 wrong_environment).
  // If a sandbox key is supplied while INCREASE_ENV=live|production, route to sandbox cleanly and surface an explicit notice.
  const effectiveEnv: "sandbox" | "production" = isSandboxKey ? "sandbox" : normalizedRequested;
  const envNotice =
    isSandboxKey && normalizedRequested === "production"
      ? "INCREASE_API_KEY is a sandbox key (increase_sandbox_key_...), so requests route to sandbox.increase.com. Supply a live production key to settle real USD checks."
      : undefined;

  return {
    apiKey,
    accountId,
    env: effectiveEnv,
    baseUrl: effectiveEnv === "production" ? "https://api.increase.com" : "https://sandbox.increase.com",
    envNotice,
  };
}

async function timedFetch(url: string, init: RequestInit): Promise<globalThis.Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err: any) {
    throw Object.assign(
      new Error(
        `Increase API request did not complete (${err?.name === "AbortError" ? "timed out" : err?.message || "network error"}).`
      ),
      { status: 502, ambiguous: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseIncreaseError(json: any, status: number): { message: string; code?: string } {
  const detail = json?.detail || json?.title || json?.error?.message || json?.message;
  const code = json?.type || json?.code || json?.status?.toString();
  return {
    message: typeof detail === "string" && detail.trim() ? detail : `Increase returned HTTP ${status}`,
    code: typeof code === "string" ? code : undefined,
  };
}

/**
 * Resolves an Increase `account_...` / `sandbox_account_...` ID.
 * If INCREASE_ACCOUNT_ID is already an Increase account id, returns it directly.
 * If it is an email/label (e.g. Look2thesky88@gmail.com), looks up GET /accounts
 * and in sandbox provisions a checking account under the active entity/program if none exists yet.
 */
export async function resolveIncreaseAccountId(): Promise<string> {
  const cfg = increaseConfig();
  if (!cfg) {
    throw Object.assign(
      new Error("Check clearing is not configured: set INCREASE_API_KEY, INCREASE_ACCOUNT_ID, and INCREASE_ENV."),
      { status: 503, ambiguous: false }
    );
  }

  if (/^(sandbox_)?account_[a-z0-9_]+$/i.test(cfg.accountId)) {
    return cfg.accountId;
  }

  const cacheKey = `${cfg.env}:${cfg.apiKey.slice(-12)}:${cfg.accountId}`;
  const cached = resolvedAccountCache.get(cacheKey);
  if (cached) return cached;

  const list = await increaseRequest("GET", "/accounts");
  const accounts: any[] = Array.isArray(list?.data) ? list.data : [];
  const openAccounts = accounts.filter((a) => a && a.status !== "closed");
  const match =
    openAccounts.find((a) => String(a.name || "").toLowerCase() === cfg.accountId.toLowerCase()) ||
    openAccounts[0];
  if (match?.id) {
    resolvedAccountCache.set(cacheKey, match.id);
    return match.id;
  }

  if (cfg.env === "sandbox") {
    const [entitiesRes, programsRes] = await Promise.all([
      increaseRequest("GET", "/entities"),
      increaseRequest("GET", "/programs"),
    ]);
    const entity = (entitiesRes?.data || []).find((e: any) => e?.status === "active") || entitiesRes?.data?.[0];
    const program = programsRes?.data?.[0];
    if (entity?.id && program?.id) {
      const created = await increaseRequest("POST", "/accounts", {
        name: cfg.accountId,
        entity_id: entity.id,
        program_id: program.id,
      });
      if (created?.id) {
        resolvedAccountCache.set(cacheKey, created.id);
        return created.id;
      }
    }
  }

  throw Object.assign(
    new Error(
      `Increase account '${cfg.accountId}' could not be resolved to an Increase account_id. Create an account in Increase and set INCREASE_ACCOUNT_ID to its account_... id.`
    ),
    { status: 400, ambiguous: false }
  );
}

export async function uploadIncreaseCheckFile(
  purpose: "check_image_front" | "check_image_back",
  imageBuffer: Buffer,
  mimeType: string,
  filename: string
): Promise<{ id: string }> {
  const cfg = increaseConfig();
  if (!cfg) {
    throw Object.assign(
      new Error("Check clearing is not configured: set INCREASE_API_KEY, INCREASE_ACCOUNT_ID, and INCREASE_ENV."),
      { status: 503, ambiguous: false }
    );
  }

  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), filename);

  const res = await timedFetch(`${cfg.baseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: form,
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.id) {
    const parsed = parseIncreaseError(json, res.status);
    throw Object.assign(new Error(parsed.message), {
      status: res.status >= 500 ? 502 : 400,
      ambiguous: false,
      increase: { code: parsed.code },
    });
  }

  return json as { id: string };
}

export async function increaseRequest(
  method: "GET" | "POST",
  apiPath: string,
  body?: unknown,
  idempotencyKey?: string
): Promise<any> {
  const cfg = increaseConfig();
  if (!cfg) {
    throw Object.assign(
      new Error("Check clearing is not configured: set INCREASE_API_KEY, INCREASE_ACCOUNT_ID, and INCREASE_ENV."),
      { status: 503, ambiguous: false }
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const res = await timedFetch(`${cfg.baseUrl}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parsed = parseIncreaseError(json, res.status);
    throw Object.assign(new Error(parsed.message), {
      status: res.status >= 500 ? 502 : 400,
      ambiguous: res.status >= 500,
      increase: { code: parsed.code },
    });
  }

  return json;
}
