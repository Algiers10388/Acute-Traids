import React, { useState } from 'react';
import {
  Landmark,
  CreditCard,
  ShieldCheck,
  Zap,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  FileCheck,
  Coins,
} from 'lucide-react';
import { FiatAccount } from '../types';
import { formatCurrency } from '../utils/cryptoMath';

interface LiveCurrencyTreasuryCardProps {
  fiatAccount: FiatAccount;
  onOpenModal: () => void;
  onOpenDebitLoad: () => void;
  onOpenBankConnect: () => void;
  onOpenWithdraw: () => void;
  onOpenCryptoToCash?: () => void;
  onOpenFundBot?: (method?: 'BANK' | 'CARD') => void;
  onOpenCashCheck?: () => void;
  onOpenSecurity?: () => void;
}

export const LiveCurrencyTreasuryCard: React.FC<LiveCurrencyTreasuryCardProps> = ({
  fiatAccount,
  onOpenModal,
  onOpenDebitLoad,
  onOpenBankConnect,
  onOpenWithdraw,
  onOpenCryptoToCash,
  onOpenFundBot,
  onOpenCashCheck,
  onOpenSecurity,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-slate-900/80 border border-slate-800/90 rounded-xl p-2.5 sm:p-3 shadow-md transition-all font-mono">
      {/* Compact Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <Landmark className="h-4 w-4" />
          </div>

          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-slate-400 font-semibold">Live USD Ledger:</span>
            <span className="text-base font-bold text-white tracking-tight">
              {formatCurrency(fiatAccount.availableBalance)}
            </span>
            <span className="text-[11px] text-emerald-400 font-medium hidden sm:inline">
              ({formatCurrency(fiatAccount.allocatedToTrading)} in Bot Margin)
            </span>
            {fiatAccount.pendingBalance > 0 && (
              <span className="text-[11px] text-amber-300 font-medium">
                · {formatCurrency(fiatAccount.pendingBalance)} Pending
              </span>
            )}
          </div>

          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-500 pl-2 border-l border-slate-800">
            <span>{fiatAccount.linkedBanks.length} Linked Banks</span>
            <span>·</span>
            <span>{fiatAccount.twoFactorEnabled ? '2FA Active' : '2FA Setup Needed'}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {onOpenFundBot && (
            <button
              onClick={() => onOpenFundBot('CARD')}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 font-bold transition-all cursor-pointer text-xs"
              title="Fund trading bot via Stripe card or Vault"
            >
              <Zap className="h-3 w-3 text-amber-400" />
              <span>Fund Bot</span>
            </button>
          )}

          {onOpenCashCheck && (
            <button
              onClick={onOpenCashCheck}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/40 text-teal-300 font-semibold transition-all cursor-pointer text-xs"
              title="Deposit a paper check via Increase Check 21"
            >
              <FileCheck className="h-3 w-3 text-teal-400" />
              <span>Cash Check</span>
            </button>
          )}

          <button
            onClick={onOpenBankConnect}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-semibold transition-all cursor-pointer text-xs"
            title="Connect a bank account via Plaid"
          >
            <Landmark className="h-3 w-3 text-emerald-400" />
            <span>Link Bank</span>
          </button>

          <button
            onClick={onOpenDebitLoad}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 font-semibold transition-all cursor-pointer text-xs"
            title="Deposit USD with a card via Stripe"
          >
            <CreditCard className="h-3 w-3 text-cyan-400" />
            <span>Card Deposit</span>
          </button>

          {onOpenCryptoToCash && (
            <button
              onClick={onOpenCryptoToCash}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-semibold transition-all cursor-pointer text-xs"
              title="Convert spot crypto positions directly to a PayPal payout"
            >
              <Coins className="h-3 w-3 text-emerald-400" />
              <span>Crypto-to-Cash</span>
            </button>
          )}

          <button
            onClick={onOpenWithdraw}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-medium transition-all cursor-pointer text-xs"
            title="Withdraw USD to PayPal"
          >
            <ArrowUpFromLine className="h-3 w-3 text-rose-400" />
            <span className="hidden sm:inline">Withdraw</span>
          </button>

          <button
            onClick={onOpenModal}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-medium transition-all cursor-pointer text-xs"
          >
            Manage
          </button>

          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer text-xs"
            title={expanded ? 'Collapse panel' : 'Expand live rail details'}
          >
            <span className="hidden sm:inline text-[11px]">{expanded ? 'Less' : 'Details'}</span>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded Live Rail Drawer */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="flex items-center gap-1 text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              Live Settlement Rails
            </span>
            <span>·</span>
            <span>Stripe Card Deposits · Increase Check 21 · PayPal Payouts</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {onOpenSecurity && (
              <button
                onClick={onOpenSecurity}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 font-medium transition-all cursor-pointer text-xs"
                title="View Security Audit, 2FA & Kill-Switch"
              >
                <ShieldCheck className="h-3 w-3 text-cyan-400" />
                <span>Security &amp; 2FA</span>
              </button>
            )}

            {onOpenCashCheck && (
              <button
                onClick={onOpenCashCheck}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 text-teal-300 font-medium transition-all cursor-pointer text-xs"
              >
                <FileCheck className="h-3 w-3 text-teal-400" />
                <span>Check Deposit (Check 21)</span>
              </button>
            )}

            <button
              onClick={onOpenDebitLoad}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 font-medium transition-all cursor-pointer text-xs"
            >
              <CreditCard className="h-3 w-3 text-cyan-400" />
              <span>Stripe Card Deposit</span>
            </button>

            <button
              onClick={onOpenBankConnect}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-medium transition-all cursor-pointer text-xs"
            >
              <Landmark className="h-3 w-3 text-emerald-400" />
              <span>Connect Bank (Plaid ACH)</span>
            </button>

            <button
              onClick={onOpenModal}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition-all cursor-pointer text-xs"
            >
              Full Account View
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
