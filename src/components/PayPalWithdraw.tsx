import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { FiatAccount, FiatTransaction } from '../types';
import { confirmTotp2FA, setupTotp2FA, transferBetweenFiatAndBot, verifyPaypalAuth } from '../services/fiatApi';

/**
 * Withdraw from the live USD ledger to PayPal (PayPal Payouts API).
 *
 * - Only PayPal emails registered on the server (PAYPAL_PAYOUT_RECIPIENTS) can receive money.
 * - Every withdrawal requires a fresh single-use 6-digit TOTP 2FA code.
 * - If no TOTP secret is enrolled yet on the server, an inline 2FA setup flow lets the user enroll an authenticator app.
 * - The server reserves the amount on the ledger first, then asks PayPal. Status comes directly from PayPal.
 */

interface Props {
  availableBalance: number;
  allocatedToTrading?: number;
  onAccountUpdated: (account: FiatAccount, message: string) => void;
  onBotCashAdjusted?: (amountDelta: number) => void;
  onSwitchToDeposit?: () => void;
  onSwitchToCryptoToCash?: () => void;
  onError?: (message: string) => void;
}

interface PaypalRails {
  withdrawals: boolean;
  paypal: {
    env: 'sandbox' | 'live';
    recipients: { id: number; label: string }[];
    dailyLimitUsd: number;
    withdrawnTodayUsd: number;
    diagnostics?: {
      configured: boolean;
      env: 'sandbox' | 'live' | null;
      oauthPayoutScope: boolean | null;
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
    };
  } | null;
  security: {
    twoFactorConfigured: boolean;
    twoFactorEnforced: boolean;
    managedByEnv: boolean;
  };
}

async function api(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; data: any }> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = {};
    if (text && text.trim().length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (text.includes('__cookie_check') || text.includes('Action required to load your app')) {
          return {
            status: 403,
            data: { success: false, error: 'Browser security cookie blocked in iframe. Please allow third-party cookies or open in a direct tab.' },
          };
        }
        return {
          status: res.status,
          data: {
            success: false,
            error:
              res.status === 200
                ? 'Preview gateway session refreshing. Please retry.'
                : `Server returned an unexpected response (HTTP ${res.status}).`,
          },
        };
      }
    }
    return { status: res.status, data };
  } catch (err: any) {
    return { status: 500, data: { success: false, error: err?.message || 'Network request failed' } };
  }
}

const statusStyle: Record<string, string> = {
  COMPLETED: 'text-emerald-300',
  PROCESSING: 'text-amber-300',
  PENDING: 'text-amber-300',
  FAILED: 'text-rose-300',
};

export const PayPalWithdraw: React.FC<Props> = ({
  availableBalance,
  allocatedToTrading = 0,
  onAccountUpdated,
  onBotCashAdjusted,
  onSwitchToDeposit,
  onSwitchToCryptoToCash,
  onError,
}) => {
  const [rails, setRails] = useState<PaypalRails | null>(null);
  const [recipientId, setRecipientId] = useState(0);
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [payouts, setPayouts] = useState<FiatTransaction[]>([]);
  const keyRef = useRef<string>(crypto.randomUUID());

  // Bot-to-ledger bridge quick-move state
  const [movingFromBot, setMovingFromBot] = useState(false);

  // Inline TOTP enrollment state when no 2FA secret is configured yet
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpConfirmCode, setTotpConfirmCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Inline confirmation for resolving ambiguous payouts (avoids window.confirm in iframe)
  const [confirmResolve, setConfirmResolve] = useState<{ txId: string; action: 'refund' | 'complete' } | null>(null);
  const [verifyingAuth, setVerifyingAuth] = useState(false);
  const [authDiagMessage, setAuthDiagMessage] = useState<string | null>(null);

  const fail = useCallback(
    (m: string) => {
      setError(m);
      onError?.(m);
    },
    [onError]
  );

  const loadRails = useCallback(async () => {
    try {
      const { data } = await api('GET', '/api/fiat/config');
      setRails({
        withdrawals: Boolean(data?.rails?.withdrawals),
        paypal: data?.rails?.paypal ?? null,
        security: {
          twoFactorConfigured: Boolean(data?.security?.twoFactorConfigured),
          twoFactorEnforced: data?.security?.twoFactorEnforced !== false,
          managedByEnv: Boolean(data?.security?.managedByEnv),
        },
      });
    } catch {
      setRails({
        withdrawals: false,
        paypal: null,
        security: { twoFactorConfigured: false, twoFactorEnforced: true, managedByEnv: false },
      });
    }
  }, []);

  const loadPayouts = useCallback(async () => {
    try {
      const { data } = await api('GET', '/api/fiat/transactions');
      setPayouts((data?.transactions || []).filter((t: FiatTransaction) => t.type === 'WITHDRAW_TO_PAYPAL').slice(0, 10));
    } catch {
      /* informational list */
    }
  }, []);

  useEffect(() => {
    loadRails();
    loadPayouts();
  }, [loadRails, loadPayouts]);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) {
        setRefreshing(true);
        setError(null);
      }
      try {
        const { data } = await api('POST', '/api/fiat/withdraw/paypal/reconcile');
        if (!data?.success) {
          if (!silent) throw new Error(data?.error || 'Could not refresh payout status.');
          return;
        }
        if (data.account) onAccountUpdated(data.account, silent ? '' : 'Payout status refreshed from PayPal.');
        setPayouts((data.transactions || []).filter((t: FiatTransaction) => t.type === 'WITHDRAW_TO_PAYPAL').slice(0, 10));
        loadRails();
      } catch (e: any) {
        if (!silent) fail(e?.message || 'Could not refresh payout status.');
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [fail, loadRails, onAccountUpdated]
  );

  // Automatically check PayPal while any payout with a PayPal batch id is PROCESSING
  useEffect(() => {
    const hasInFlight = payouts.some((t) => t.status === 'PROCESSING' && Boolean(t.externalId));
    if (!hasInFlight) return;
    const t1 = setTimeout(() => refresh(true), 3500);
    const t2 = setTimeout(() => refresh(true), 9000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [payouts, refresh]);

  const startTotpSetup = async () => {
    setError(null);
    setInfo(null);
    setTotpBusy(true);
    try {
      const res = await setupTotp2FA();
      const qrDataUrl = await QRCode.toDataURL(res.otpauthUri, { width: 180, margin: 1 });
      setTotpSetupData({ secret: res.secret, otpauthUri: res.otpauthUri, qrDataUrl });
      setInfo(res.message);
    } catch (e: any) {
      fail(e?.message || 'Could not start 2FA setup.');
    } finally {
      setTotpBusy(false);
    }
  };

  const completeTotpSetup = async () => {
    setError(null);
    setInfo(null);
    if (!/^\d{6}$/.test(totpConfirmCode)) return fail('Enter the 6-digit code shown in your authenticator app.');
    setTotpBusy(true);
    try {
      const res = await confirmTotp2FA(totpConfirmCode);
      setTotpSetupData(null);
      setTotpConfirmCode('');
      setInfo(res.message);
      onAccountUpdated(res.account, res.message);
      await loadRails();
    } catch (e: any) {
      fail(e?.message || '2FA verification failed.');
    } finally {
      setTotpBusy(false);
    }
  };

  const handleMoveBotToLedger = async (moveAmt: number) => {
    setError(null);
    setInfo(null);
    if (!Number.isFinite(moveAmt) || moveAmt < 0.01) return;
    if (moveAmt >= 2000 && rails?.security.twoFactorEnforced && !/^\d{6}$/.test(code)) {
      return fail('Moving $2,000+ from Bot Margin requires your 6-digit 2FA code below.');
    }
    setMovingFromBot(true);
    try {
      const res = await transferBetweenFiatAndBot('FROM_BOT', moveAmt, code.trim() || undefined);
      onAccountUpdated(res.account, res.message);
      onBotCashAdjusted?.(-moveAmt);
      setInfo(res.message);
      if (moveAmt >= 2000) setCode('');
    } catch (e: any) {
      fail(e?.message || 'Could not move funds from Bot Margin to USD Ledger.');
    } finally {
      setMovingFromBot(false);
    }
  };

  const submit = async () => {
    setError(null);
    setInfo(null);
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 1) return fail('Minimum withdrawal is $1.00.');
    if (amt > availableBalance) {
      if (allocatedToTrading > 0 && availableBalance + allocatedToTrading >= amt) {
        return fail(`Only $${availableBalance.toFixed(2)} is in the USD Ledger. Move funds from Bot Margin below first.`);
      }
      return fail(`Only $${availableBalance.toFixed(2)} is available in the USD ledger.`);
    }
    if (rails?.security.twoFactorEnforced && !/^\d{6}$/.test(code)) {
      return fail('Enter the current 6-digit 2FA code.');
    }
    setBusy(true);
    try {
      const { status, data } = await api('POST', '/api/fiat/withdraw/paypal', {
        amount: amt,
        recipientId,
        twoFactorCode: code,
        idempotencyKey: keyRef.current,
      });
      if (!data?.success) {
        // Definitive answer ends this attempt so next try gets a fresh idempotency key; 502/504 preserves key against double-pay
        if (status !== 502 && status !== 504) keyRef.current = crypto.randomUUID();
        if (status === 403 || data?.code === 'AUTHORIZATION_ERROR' || data?.paypal?.actionRequired) {
          setAuthDiagMessage(data?.paypal?.actionRequired || data?.error);
          loadRails();
        }
        throw new Error(data?.error || `Withdrawal failed (HTTP ${status}).`);
      }
      keyRef.current = crypto.randomUUID();
      setAuthDiagMessage(null);
      setAmount('');
      setCode('');
      setInfo(data.message);
      if (data.account) onAccountUpdated(data.account, data.message);
      loadPayouts();
      loadRails();
    } catch (e: any) {
      fail(e?.message || 'Withdrawal failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyPaypalAuth = async () => {
    setVerifyingAuth(true);
    setError(null);
    setInfo(null);
    try {
      const res = await verifyPaypalAuth(true);
      setAuthDiagMessage(res.authorizationWarning || null);
      setInfo(res.message);
      await loadRails();
    } catch (e: any) {
      setAuthDiagMessage(e?.paypal?.actionRequired || e?.message || null);
      fail(e?.message || 'PayPal authorization probe failed.');
    } finally {
      setVerifyingAuth(false);
    }
  };

  const resolve = async (tx: FiatTransaction, action: 'refund' | 'complete') => {
    if (rails?.security.twoFactorEnforced && !/^\d{6}$/.test(code)) {
      return fail('Enter a fresh 6-digit 2FA code above first.');
    }
    const { data } = await api('POST', `/api/fiat/withdraw/paypal/${encodeURIComponent(tx.id)}/resolve`, {
      action,
      twoFactorCode: code,
    });
    setConfirmResolve(null);
    if (!data?.success) return fail(data?.error || 'Could not resolve.');
    setCode('');
    setInfo(data.message);
    onAccountUpdated(data.account, data.message);
    loadPayouts();
  };

  if (!rails) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Checking withdrawal setup…</span>
      </div>
    );
  }

  if (!rails.withdrawals || !rails.paypal) {
    return (
      <div className="text-xs text-amber-200 bg-amber-950/30 border border-amber-900/60 rounded-xl px-4 py-4 space-y-1.5">
        <div className="font-bold">Withdrawals are not configured</div>
        <p>
          Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV (sandbox or live) and PAYPAL_PAYOUT_RECIPIENTS (the PayPal email(s) allowed to receive money) on the
          server. Your PayPal Business account must have Payouts enabled.
        </p>
      </div>
    );
  }

  const p = rails.paypal;
  const remainingToday = Math.max(0, p.dailyLimitUsd - p.withdrawnTodayUsd);
  const needsTotpEnrollment = rails.security.twoFactorEnforced && !rails.security.twoFactorConfigured;

  return (
    <div className="space-y-4">
      {p.env === 'sandbox' && (
        <div className="text-[11px] text-cyan-200 bg-cyan-950/30 border border-cyan-900/60 rounded-lg px-3 py-2">
          PayPal <b>sandbox</b>: no real money moves.
        </div>
      )}

      {(p.diagnostics?.lastAuthorizationIssue || authDiagMessage) && (
        <div className="p-3.5 bg-amber-950/40 border border-amber-500/50 rounded-xl text-xs text-amber-200 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-bold text-amber-100">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                PayPal {p.env.toUpperCase()} Authorization Check
                {p.diagnostics?.lastAuthorizationIssue?.debugId ? ` (debug_id: ${p.diagnostics.lastAuthorizationIssue.debugId})` : ''}
              </span>
            </div>
            <button
              type="button"
              onClick={handleVerifyPaypalAuth}
              disabled={verifyingAuth}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-100 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${verifyingAuth ? 'animate-spin' : ''}`} />
              <span>{verifyingAuth ? 'Re-checking...' : 'Refresh Auth & Verify'}</span>
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-amber-100/90">
            {authDiagMessage || p.diagnostics?.lastAuthorizationIssue?.actionRequired}
          </p>
        </div>
      )}

      {/* 2FA Enrollment Card if 2FA is enforced but no TOTP secret has been set up yet */}
      {needsTotpEnrollment && (
        <div className="p-4 bg-cyan-950/25 border border-cyan-500/40 rounded-2xl space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <KeyRound className="h-5 w-5 text-cyan-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-bold text-white">Set Up 2FA Authenticator to Enable Withdrawals</div>
                <p className="text-xs text-slate-300 mt-0.5">
                  Every live PayPal withdrawal verifies a single-use 6-digit authenticator code. Pair your authenticator app once below to unlock withdrawals.
                </p>
              </div>
            </div>
          </div>

          {!totpSetupData ? (
            <button
              type="button"
              onClick={startTotpSetup}
              disabled={totpBusy}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-2 cursor-pointer disabled:opacity-40"
            >
              {totpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span>Generate 2FA Authenticator Key</span>
            </button>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-center bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
              <img
                src={totpSetupData.qrDataUrl}
                alt="2FA QR Code"
                className="w-36 h-36 rounded-lg bg-white p-1.5 mx-auto sm:mx-0"
              />
              <div className="space-y-3 text-xs">
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">1. Scan QR or Copy Manual Secret Key</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-cyan-300 break-all select-all">
                      {totpSetupData.secret}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(totpSetupData.secret);
                        setCopiedSecret(true);
                        setTimeout(() => setCopiedSecret(false), 2000);
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      {copiedSecret ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedSecret ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">2. Enter 6-Digit Code from Authenticator App</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={totpConfirmCode}
                      onChange={(e) => setTotpConfirmCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      className="w-36 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-500"
                    />
                    <button
                      type="button"
                      onClick={completeTotpSetup}
                      disabled={totpBusy || totpConfirmCode.length !== 6}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs cursor-pointer disabled:opacity-40"
                    >
                      {totpBusy ? 'Verifying…' : 'Verify & Activate 2FA'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bot Margin bridge helper if user's live funds are currently sitting in allocatedToTrading */}
      {allocatedToTrading > 0 && (
        <div className="p-3.5 bg-slate-900/70 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
          <div>
            <div className="font-semibold text-white">Funds in Bot Trading Margin: ${allocatedToTrading.toFixed(2)}</div>
            <div className="text-[11px] text-slate-400">Withdrawals draw from the USD Ledger. Move bot cash to the USD Ledger first to withdraw it.</div>
          </div>
          <button
            type="button"
            disabled={movingFromBot}
            onClick={() => handleMoveBotToLedger(allocatedToTrading)}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
          >
            {movingFromBot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
            <span>Move ${allocatedToTrading.toFixed(2)} to USD Ledger</span>
          </button>
        </div>
      )}

      <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <ArrowUpRight className="h-4 w-4 text-emerald-400" />
            <span>Withdraw to PayPal ({p.env === 'live' ? 'Live' : 'Sandbox'})</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            Available ${availableBalance.toFixed(2)} · Left today ${remainingToday.toFixed(2)}
          </div>
        </div>

        {availableBalance < 1 && allocatedToTrading < 1 && (
          <div className="text-xs text-slate-300 bg-slate-900/70 border border-slate-800 rounded-xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <span>No settled USD in the ledger yet. Deposit live USD or convert a spot crypto position directly to PayPal.</span>
            <div className="flex items-center gap-2">
              {onSwitchToCryptoToCash && (
                <button
                  type="button"
                  onClick={onSwitchToCryptoToCash}
                  className="px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 font-bold text-[11px] cursor-pointer"
                >
                  Crypto-to-Cash
                </button>
              )}
              {onSwitchToDeposit && (
                <button
                  type="button"
                  onClick={onSwitchToDeposit}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-[11px] cursor-pointer"
                >
                  Go to Deposit
                </button>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Send to</label>
          <select
            value={recipientId}
            onChange={(e) => setRecipientId(Number(e.target.value))}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            {p.recipients.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-slate-500 mt-1">Only PayPal accounts registered on the server can receive withdrawals.</p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[10px] font-bold text-slate-400 uppercase">Amount (USD)</label>
            {availableBalance >= 1 && (
              <button
                type="button"
                onClick={() => setAmount(Math.min(availableBalance, remainingToday).toFixed(2))}
                className="text-[10px] font-mono text-emerald-400 hover:text-emerald-300 cursor-pointer"
              >
                Max (${Math.min(availableBalance, remainingToday).toFixed(2)})
              </button>
            )}
          </div>
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-slate-400 font-mono text-sm">$</span>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25.00"
              className="w-full bg-slate-900 border border-slate-700 text-white pl-8 pr-4 py-2.5 rounded-xl font-mono text-base font-bold focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        {rails.security.twoFactorEnforced && (
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> 2FA code (required for every withdrawal)
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-40 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || needsTotpEnrollment}
          className="w-full px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
          <span>{busy ? 'Sending to PayPal…' : `Withdraw ${parseFloat(amount) >= 1 ? '$' + parseFloat(amount).toFixed(2) : ''} to PayPal`}</span>
        </button>
        <p className="text-[10px] text-slate-500">
          The amount leaves your ledger immediately and returns automatically if PayPal blocks, fails or returns the payout. PayPal may charge a payout fee to your
          PayPal business balance.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">{error}</div>}
      {info && <div className="text-xs text-emerald-200 bg-emerald-950/30 border border-emerald-900/60 rounded-lg px-3 py-2">{info}</div>}

      <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white">Recent PayPal withdrawals</span>
          <button
            type="button"
            onClick={() => refresh(false)}
            disabled={refreshing}
            className="text-xs text-cyan-300 hover:text-cyan-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh status</span>
          </button>
        </div>
        {payouts.length === 0 ? (
          <div className="text-[11px] text-slate-500">No PayPal withdrawals yet.</div>
        ) : (
          <div className="space-y-2">
            {payouts.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 text-[11px] bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-slate-200 font-mono truncate">
                    ${t.amount.toFixed(2)} → {t.destinationName.replace(/^PayPal\s+/i, '')}
                  </div>
                  <div className="text-slate-500">
                    {new Date(t.timestamp).toLocaleString()}
                    {t.externalId ? ` · Batch ${t.externalId}` : ''}
                    {t.fee > 0 ? ` · PayPal fee $${t.fee.toFixed(2)}` : ''}
                  </div>
                  {t.status === 'PROCESSING' && !t.externalId && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-amber-300">PayPal did not return a batch confirmation. Check PayPal activity first:</span>
                      {confirmResolve?.txId === t.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-semibold">
                            Confirm {confirmResolve.action === 'refund' ? 'NOT sent (refund)' : 'WAS sent (complete)'}?
                          </span>
                          <button
                            type="button"
                            onClick={() => resolve(t, confirmResolve.action)}
                            className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmResolve(null)}
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setConfirmResolve({ txId: t.id, action: 'refund' })}
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                          >
                            Not sent: refund
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmResolve({ txId: t.id, action: 'complete' })}
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                          >
                            Was sent
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <span className={`font-bold shrink-0 ${statusStyle[t.status] || 'text-slate-300'}`}>{t.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default PayPalWithdraw;
