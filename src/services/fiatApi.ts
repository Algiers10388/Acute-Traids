import { FiatAccount, FiatTransaction, BotSecuritySettings } from '../types';

// Resilient JSON response parser preventing HTML gateway responses from breaking UI state
async function safeParseJson<T = any>(res: Response, fallbackError = 'Request failed'): Promise<T> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new Error('Network error reading response from banking gateway.');
  }

  let data: any = null;
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      if (text.includes('__cookie_check') || text.includes('Action required to load your app')) {
        throw new Error('Browser blocked security cookies in the iframe. Please allow third-party cookies or open the app in a new window.');
      }
      throw new Error(
        res.status >= 500
          ? 'Banking gateway service is temporarily synchronizing. Please retry in a moment.'
          : res.status === 200
            ? 'Banking gateway session is synchronizing. Please retry in a moment.'
            : `Banking gateway returned an unexpected response (HTTP ${res.status}).`
      );
    }
  }

  if (!res.ok || (data && data.success === false)) {
    const errorMsg = (data && data.error) || (data && data.message) || `${fallbackError} (HTTP ${res.status})`;
    const err: any = new Error(errorMsg);
    if (data && typeof data === 'object') {
      err.requires2FA = Boolean(data.requires2FA);
      err.twoFactorSetupRequired = Boolean(data.twoFactorSetupRequired);
      err.code = data.code;
      err.paypal = data.paypal;
    }
    err.status = res.status;
    throw err;
  }

  return (data || {}) as T;
}

export function fiatFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });
}

export async function fetchFiatAccount(): Promise<{
  account: FiatAccount;
  botSecurity?: BotSecuritySettings;
  security: any;
}> {
  const res = await fiatFetch('/api/fiat/account');
  const data = await safeParseJson(res, 'Failed to retrieve live currency account');
  return { account: data.account, botSecurity: data.botSecurity, security: data.security };
}

export async function syncBotCapital(
  botCash: number
): Promise<{ success: boolean; allocatedToTrading: number; account: FiatAccount }> {
  try {
    const res = await fiatFetch('/api/fiat/sync-bot-capital', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botCash }),
    });
    return await safeParseJson(res, 'Could not sync bot capital');
  } catch (err: any) {
    console.warn('Could not sync bot capital with treasury:', err);
    return { success: false, allocatedToTrading: botCash, account: {} as any };
  }
}

export async function removeBankAccount(
  bankId: string
): Promise<{ success: boolean; account: FiatAccount; message: string }> {
  const res = await fiatFetch(`/api/fiat/bank/${encodeURIComponent(bankId)}`, {
    method: 'DELETE',
  });
  return safeParseJson(res, 'Failed to remove bank account');
}

export async function transferBetweenFiatAndBot(
  direction: 'TO_BOT' | 'FROM_BOT',
  amount: number,
  twoFactorCode?: string
): Promise<{ account: FiatAccount; transaction: FiatTransaction; message: string }> {
  const res = await fiatFetch('/api/fiat/transfer-bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, amount, ...(twoFactorCode ? { twoFactorCode } : {}) }),
  });
  return safeParseJson(res, 'Transfer failed');
}

export async function fetchFiatTransactions(): Promise<FiatTransaction[]> {
  const res = await fiatFetch('/api/fiat/transactions');
  if (!res.ok) return [];
  const data = await safeParseJson(res, 'Failed to fetch transactions').catch(() => ({ transactions: [] }));
  return data.transactions || [];
}

export async function fetchSecurityAudit(): Promise<any | null> {
  try {
    const res = await fiatFetch('/api/fiat/security/audit');
    const data = await safeParseJson(res, 'Failed to fetch security audit');
    return data.report;
  } catch {
    return null;
  }
}

export async function updateBotProtection(
  settings: any
): Promise<{ success: boolean; message: string; botSecurity: BotSecuritySettings; account: FiatAccount }> {
  const res = await fiatFetch('/api/fiat/security/update-bot-protection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return safeParseJson(res, 'Failed to update bot protection');
}

export async function setupTotp2FA(twoFactorCode?: string): Promise<{
  success: boolean;
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountLabel: string;
  message: string;
}> {
  const res = await fiatFetch('/api/fiat/security/totp/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(twoFactorCode ? { twoFactorCode } : {}),
  });
  return safeParseJson(res, 'Failed to start 2FA setup');
}

export async function confirmTotp2FA(code: string): Promise<{
  success: boolean;
  twoFactorConfigured: boolean;
  account: FiatAccount;
  botSecurity: BotSecuritySettings;
  message: string;
}> {
  const res = await fiatFetch('/api/fiat/security/totp/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return safeParseJson(res, 'Failed to verify 2FA code');
}

export async function fetchCheckDeposits(): Promise<any[]> {
  const res = await fiatFetch('/api/fiat/check-deposits');
  if (!res.ok) return [];
  const data = await safeParseJson(res, 'Failed to load check deposits').catch(() => ({ checks: [] }));
  return data.checks || [];
}

export async function submitCheckDeposit(payload: {
  amount: number;
  checkNumber: string;
  payerName: string;
  issuingBank?: string;
  routingNumber?: string;
  accountNumber?: string;
  endorsementConfirmed: boolean;
  destination: 'BOT_MARGIN' | 'TREASURY_VAULT';
  frontImage: string;
  backImage: string;
  idempotencyKey: string;
}): Promise<{
  success: boolean;
  processing?: boolean;
  check: any;
  transaction: FiatTransaction;
  account: FiatAccount;
  message: string;
}> {
  const res = await fiatFetch('/api/fiat/deposit/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return safeParseJson(res, 'Check deposit submission failed');
}

export async function reconcileCheckDeposits(): Promise<{
  success: boolean;
  checks: any[];
  account: FiatAccount;
  transactions: FiatTransaction[];
}> {
  const res = await fiatFetch('/api/fiat/check-deposits/reconcile', {
    method: 'POST',
  });
  return safeParseJson(res, 'Failed to refresh check clearing status');
}

export interface CryptoToCashQuote {
  exchange: 'KRAKEN' | 'COINBASE' | 'BINANCE' | 'NONKYC' | 'OKX';
  symbol: string;
  baseAsset: string;
  quantity: number;
  unitPriceUsd: number;
  grossUsd: number;
  feeRate: number;
  estimatedFeeUsd: number;
  netUsd: number;
  exchangeConfigured: boolean;
  liveTradingEnabled: boolean;
  paypalReady: boolean;
  withinSingleOrderCap: boolean;
  withinDailyWithdrawalLimit: boolean;
  dailyLimitUsd: number;
  remainingDailyUsd: number;
  meetsPaypalMinimum: boolean;
}

export async function quoteCryptoToCash(payload: {
  exchange: string;
  symbol: string;
  quantity: number;
}): Promise<{ success: boolean; quote: CryptoToCashQuote }> {
  const res = await fiatFetch('/api/fiat/crypto-to-cash/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return safeParseJson(res, 'Failed to quote crypto position');
}

export async function executeCryptoToCash(payload: {
  exchange: string;
  symbol: string;
  quantity: number;
  positionId?: string;
  recipientId: number;
  twoFactorCode: string;
  idempotencyKey: string;
}): Promise<{
  success: boolean;
  processing?: boolean;
  duplicate?: boolean;
  unknownOutcome?: boolean;
  sellCompleted?: boolean;
  sellResult?: {
    exchangeOrderId: string;
    exchange: string;
    symbol: string;
    quantity: number;
    unitPriceUsd: number;
    grossUsd: number;
    exchangeFeeUsd: number;
    netProceedsUsd: number;
    cryptographicReceipt: string;
    note: string;
  };
  liquidationTransaction?: FiatTransaction | null;
  payoutTransaction?: FiatTransaction | null;
  account: FiatAccount;
  message: string;
}> {
  const res = await fiatFetch('/api/fiat/crypto-to-cash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return safeParseJson(res, 'Crypto-to-Cash payout failed');
}

export async function reconcilePaypalPayouts(): Promise<{
  success: boolean;
  account: FiatAccount;
  transactions: FiatTransaction[];
}> {
  const res = await fiatFetch('/api/fiat/withdraw/paypal/reconcile', {
    method: 'POST',
  });
  return safeParseJson(res, 'Failed to refresh PayPal payout status');
}

export async function verifyPaypalAuth(forceRefresh = true): Promise<{
  success: boolean;
  configured: boolean;
  env: 'sandbox' | 'live';
  oauthOk: boolean;
  payoutScopePresent: boolean;
  readProbeOk: boolean;
  authorizationWarning: string | null;
  lastAuthorizationIssue: {
    status: number;
    name: string;
    debugId?: string;
    env: 'sandbox' | 'live';
    oauthPayoutScope: boolean;
    message: string;
    actionRequired: string;
    timestamp: number;
  } | null;
  message: string;
}> {
  const res = await fiatFetch('/api/fiat/paypal/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRefresh }),
  });
  return safeParseJson(res, 'PayPal authorization verification failed');
}


