import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  ShieldCheck,
  Lock,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Flame,
  SlidersHorizontal,
  KeyRound,
  Copy,
  Check,
  Loader2,
} from 'lucide-react';
import { FiatAccount, SecurityAuditReport } from '../types';
import {
  confirmTotp2FA,
  fetchFiatAccount,
  fetchSecurityAudit,
  setupTotp2FA,
  updateBotProtection,
} from '../services/fiatApi';

interface BankBotSecurityTabProps {
  fiatAccount: FiatAccount;
  onAccountUpdated: (newAccount: FiatAccount, notificationMsg?: string) => void;
}

export const BankBotSecurityTab: React.FC<BankBotSecurityTabProps> = ({
  fiatAccount,
  onAccountUpdated,
}) => {
  const [auditReport, setAuditReport] = useState<SecurityAuditReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Server-backed 2FA status
  const [twoFactorConfigured, setTwoFactorConfigured] = useState<boolean>(fiatAccount.twoFactorEnabled);
  const [twoFactorManagedByEnv, setTwoFactorManagedByEnv] = useState<boolean>(false);

  // Editable Protection Parameters
  const [emergencyFreeze, setEmergencyFreeze] = useState<boolean>(false);
  const [twoFactorEnforced, setTwoFactorEnforced] = useState<boolean>(true);
  const [threeDsEnforced, setThreeDsEnforced] = useState<boolean>(true);
  const [maxSingleOrder, setMaxSingleOrder] = useState<string>('5000');
  const [maxDailyLoss, setMaxDailyLoss] = useState<string>('250');
  const [slippageTol, setSlippageTol] = useState<string>('0.5');
  const [twoFactorCode, setTwoFactorCode] = useState<string>('');

  // TOTP enrollment UI state
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpConfirmCode, setTotpConfirmCode] = useState<string>('');
  const [totpBusy, setTotpBusy] = useState<boolean>(false);
  const [copiedSecret, setCopiedSecret] = useState<boolean>(false);

  const loadAudit = async () => {
    setIsLoading(true);
    try {
      const [report, acctRes] = await Promise.all([fetchSecurityAudit(), fetchFiatAccount().catch(() => null)]);
      if (report) {
        setAuditReport(report);
        setEmergencyFreeze(report.emergencyFreezeActive);
        setMaxSingleOrder(String(report.botOrderCapUsd || '5000'));
        setMaxDailyLoss(String(report.dailyLossLimitUsd || '250'));
      }
      if (acctRes?.botSecurity) {
        setEmergencyFreeze(acctRes.botSecurity.emergencyFreezeActive);
        setTwoFactorEnforced(acctRes.botSecurity.twoFactorEnforced);
        setThreeDsEnforced(acctRes.botSecurity.threeDsEnforced !== false);
        setMaxSingleOrder(String(acctRes.botSecurity.maxSingleOrderUsd));
        setMaxDailyLoss(String(acctRes.botSecurity.maxDailyLossUsd));
        setSlippageTol(String(acctRes.botSecurity.slippageTolerancePercent));
      }
      if (acctRes?.security) {
        setTwoFactorConfigured(Boolean(acctRes.security.twoFactorConfigured));
        setTwoFactorManagedByEnv(Boolean(acctRes.security.twoFactorManagedByEnv));
      }
    } catch {
      // handled cleanly by state
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
  }, []);

  const handleSaveSecurity = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdating(true);
    setStatusMsg(null);
    try {
      const res = await updateBotProtection({
        emergencyFreezeActive: emergencyFreeze,
        twoFactorEnforced,
        threeDsEnforced,
        maxSingleOrderUsd: parseFloat(maxSingleOrder) || 5000,
        maxDailyLossUsd: parseFloat(maxDailyLoss) || 250,
        slippageTolerancePercent: parseFloat(slippageTol) || 0.5,
        twoFactorCode: twoFactorCode.trim() || undefined,
      });

      onAccountUpdated(res.account, res.message);
      setTwoFactorCode('');
      setStatusMsg({ type: 'success', text: res.message });
      await loadAudit();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to update security parameters.' });
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleEmergencyFreezeNow = async () => {
    const nextState = !emergencyFreeze;
    setIsUpdating(true);
    setStatusMsg(null);
    try {
      const res = await updateBotProtection({
        emergencyFreezeActive: nextState,
        twoFactorCode: !nextState ? twoFactorCode.trim() || undefined : undefined,
      });
      setEmergencyFreeze(nextState);
      if (!nextState) setTwoFactorCode('');
      onAccountUpdated(res.account, res.message);
      setStatusMsg({ type: 'success', text: res.message });
      await loadAudit();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Could not update freeze state.' });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleStartTotpSetup = async () => {
    setStatusMsg(null);
    setTotpBusy(true);
    try {
      const res = await setupTotp2FA();
      const qrDataUrl = await QRCode.toDataURL(res.otpauthUri, { width: 180, margin: 1 });
      setTotpSetupData({ secret: res.secret, otpauthUri: res.otpauthUri, qrDataUrl });
      setStatusMsg({ type: 'success', text: res.message });
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to initialize 2FA setup.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const handleConfirmTotpSetup = async () => {
    setStatusMsg(null);
    if (!/^\d{6}$/.test(totpConfirmCode)) {
      setStatusMsg({ type: 'error', text: 'Enter the 6-digit code from your authenticator app.' });
      return;
    }
    setTotpBusy(true);
    try {
      const res = await confirmTotp2FA(totpConfirmCode);
      setTotpSetupData(null);
      setTotpConfirmCode('');
      onAccountUpdated(res.account, res.message);
      setStatusMsg({ type: 'success', text: res.message });
      await loadAudit();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || '2FA verification failed.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const checks = auditReport?.verifiedChecks || [];
  const passedCount = checks.filter((c) => c.status === 'PASSED').length;

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-200">
      {/* Live Security Score Banner (computed by server audit) */}
      <div className="p-5 rounded-2xl bg-gradient-to-r from-cyan-950/60 via-slate-900 to-slate-950 border border-cyan-500/40 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-cyan-400 font-bold uppercase tracking-wider">
            <ShieldCheck className="h-4 w-4" />
            <span>Bank & Bot Security Status</span>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-[10px] border border-slate-700">
              {auditReport?.vaultEncryption || 'Mode 0600 Local Ledger'}
            </span>
          </div>
          <h3 className="text-xl font-bold text-white mt-1">Bank Rails & Bot Account Protection</h3>
          <p className="text-xs text-slate-300 max-w-xl mt-1">
            Live audit derived directly from active Stripe, PayPal, TOTP 2FA, and exchange risk-cap server configuration.
          </p>
        </div>

        <div className="flex items-center gap-3 bg-slate-950/80 px-4 py-3 rounded-xl border border-slate-800 text-xs font-mono shrink-0">
          <div>
            <div className="text-[10px] text-slate-400 uppercase">Audit Score</div>
            <div className={`text-xl font-black ${(auditReport?.overallScore ?? 0) >= 80 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {auditReport ? `${auditReport.overallScore} / 100` : '—'}
            </div>
          </div>
          <div className="h-8 w-px bg-slate-800" />
          <div>
            <div className="text-[10px] text-slate-400 uppercase">Server Grade</div>
            <div className="text-xs font-bold text-cyan-300">{auditReport?.securityGrade || '—'}</div>
          </div>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`p-3.5 rounded-xl text-xs font-mono flex items-center gap-2 border ${
            statusMsg.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
          }`}
        >
          {statusMsg.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
          )}
          <div className="flex-1">{statusMsg.text}</div>
        </div>
      )}

      {/* TOTP Authenticator Enrollment Status / Setup */}
      <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-cyan-400" />
            <h4 className="text-sm font-bold text-white">Two-Factor Authentication (TOTP)</h4>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold border ${
                twoFactorConfigured
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              }`}
            >
              {twoFactorConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}
            </span>
          </div>
          {!twoFactorConfigured && !twoFactorManagedByEnv && !totpSetupData && (
            <button
              type="button"
              onClick={handleStartTotpSetup}
              disabled={totpBusy}
              className="px-3.5 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              {totpBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span>Set Up 2FA Authenticator</span>
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          {twoFactorConfigured
            ? twoFactorManagedByEnv
              ? 'Active via server FIAT_TOTP_SECRET environment variable. Single-use 6-digit codes are verified on every withdrawal and limit relaxation.'
              : 'Active via enrolled authenticator secret on the server. Single-use 6-digit codes are verified on every withdrawal and limit relaxation.'
            : 'Enroll an authenticator app (Google Authenticator, Authy, 1Password) to authorize live PayPal withdrawals and security changes.'}
        </p>

        {totpSetupData && (
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-center bg-slate-950 border border-slate-800 rounded-xl p-4 mt-2">
            <img src={totpSetupData.qrDataUrl} alt="2FA QR Code" className="w-36 h-36 rounded-lg bg-white p-1.5 mx-auto sm:mx-0" />
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">1. Scan QR Code or Copy Secret Key</div>
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
                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">2. Enter 6-Digit Authenticator Code</div>
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
                    onClick={handleConfirmTotpSetup}
                    disabled={totpBusy || totpConfirmCode.length !== 6}
                    className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs cursor-pointer disabled:opacity-40"
                  >
                    {totpBusy ? 'Verifying…' : 'Verify & Activate'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Emergency Kill-Switch Banner */}
      <div
        className={`p-5 rounded-2xl border transition-all ${
          emergencyFreeze
            ? 'bg-rose-950/40 border-rose-500/80 text-rose-200 shadow-2xl shadow-rose-950/40'
            : 'bg-slate-900/80 border-slate-800 text-slate-200'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`p-2.5 rounded-xl border shrink-0 ${
                emergencyFreeze
                  ? 'bg-rose-500/20 text-rose-400 border-rose-500/40 animate-pulse'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <Flame className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-white">Trading Bot Emergency Kill-Switch</h4>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold border ${
                    emergencyFreeze
                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  }`}
                >
                  {emergencyFreeze ? 'KILL-SWITCH ENGAGED (FROZEN)' : 'ARMED & MONITORING'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1 max-w-lg">
                Instantly pauses all automated order executions, PayPal withdrawals, and bot funding. Unfreezing requires a fresh 6-digit 2FA code when 2FA is enforced.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleEmergencyFreezeNow}
            disabled={isUpdating}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 shadow-md ${
              emergencyFreeze
                ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                : 'bg-rose-600 hover:bg-rose-500 text-white'
            }`}
          >
            {emergencyFreeze ? 'Unfreeze Trading Bot' : 'Engage Emergency Freeze'}
          </button>
        </div>
      </div>

      {/* Security Guardrails Form */}
      <form onSubmit={handleSaveSecurity} className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-cyan-400" />
            <span>Configurable Bot Protection Guardrails</span>
          </h4>
          <button
            type="button"
            onClick={loadAudit}
            className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1 font-mono transition-colors cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Re-verify</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Max Single Order Allocation Ceiling ($ USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-mono font-bold">$</span>
              <input
                type="number"
                min="50"
                max="50000"
                value={maxSingleOrder}
                onChange={(e) => setMaxSingleOrder(e.target.value)}
                className="w-full pl-7 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Enforced server-side by the exchange execution gateway
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Daily Loss Circuit Breaker ($ USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-mono font-bold">$</span>
              <input
                type="number"
                min="25"
                max="10000"
                value={maxDailyLoss}
                onChange={(e) => setMaxDailyLoss(e.target.value)}
                className="w-full pl-7 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Daily realized loss stop threshold
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Max Allowable Slippage Tolerance (%)
            </label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="5.0"
              value={slippageTol}
              onChange={(e) => setSlippageTol(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-sm focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div className="flex flex-col justify-end">
            <label className="flex items-center gap-2.5 text-xs text-slate-300 bg-slate-950 p-2.5 rounded-xl border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={twoFactorEnforced}
                onChange={(e) => setTwoFactorEnforced(e.target.checked)}
                className="rounded text-cyan-500 focus:ring-cyan-500 bg-slate-900 border-slate-700 h-4 w-4"
              />
              <div>
                <span className="font-bold text-white block">Enforce 2FA for Transfers & Payouts</span>
                <span className="text-[10px] text-slate-400">Requires 6-digit TOTP on PayPal payouts & large transfers</span>
              </div>
            </label>
          </div>
        </div>

        <div className="pt-1">
          <label className="flex items-center gap-2.5 text-xs text-slate-300 bg-slate-950 p-3 rounded-xl border border-cyan-500/30 cursor-pointer hover:border-cyan-500/50 transition-colors">
            <input
              type="checkbox"
              checked={threeDsEnforced}
              onChange={(e) => setThreeDsEnforced(e.target.checked)}
              className="rounded text-cyan-500 focus:ring-cyan-500 bg-slate-900 border-slate-700 h-4 w-4"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white block">Stripe 3-D Secure Strong Customer Authentication</span>
                <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-mono border border-cyan-500/40">
                  Stripe Elements SCA
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">
                Card deposits requiring 3-D Secure present the issuing bank&apos;s live Stripe challenge before funds are credited.
              </span>
            </div>
          </label>
        </div>

        <div className="pt-2 flex flex-wrap items-end justify-between gap-3 border-t border-slate-800">
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
              6-Digit 2FA Code (required to loosen caps, unfreeze, or disable 2FA)
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={twoFactorCode}
              onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-40 px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-sm focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={isUpdating}
            className="py-2.5 px-5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs tracking-wider transition-all cursor-pointer disabled:opacity-50"
          >
            {isUpdating ? 'Applying Guardrails...' : 'Save Security Parameters'}
          </button>
        </div>
      </form>

      {/* Live Server Audit Assertions */}
      <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-emerald-400" />
            <h4 className="text-sm font-bold text-white">Live Server Security Audit Checks</h4>
          </div>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              checks.length > 0 && passedCount === checks.length
                ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30'
                : 'text-amber-300 bg-amber-500/15 border-amber-500/30'
            }`}
          >
            {checks.length > 0 ? `${passedCount} / ${checks.length} PASSED` : 'CHECKING...'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {checks.map((chk, i) => (
            <div key={i} className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-bold text-white truncate">{chk.title}</span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-bold shrink-0 ml-2 ${
                    chk.status === 'PASSED'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-amber-500/20 text-amber-300'
                  }`}
                >
                  {chk.status}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">{chk.description}</p>
            </div>
          )) || (
            <div className="text-slate-400 text-xs col-span-2 text-center py-4">
              Loading security assertions...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
