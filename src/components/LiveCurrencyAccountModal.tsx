import React, { useState, useEffect } from 'react';
import {
  X,
  CreditCard,
  Landmark,
  ShieldCheck,
  Lock,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  CheckCircle2,
  AlertCircle,
  Clock,
  Copy,
  Check,
  Zap,
  Building2,
  Receipt,
  RefreshCw,
  Download,
  Search,
  FileCheck,
  Coins,
  Vault,
} from 'lucide-react';
import {
  CryptoAsset,
  FiatAccount,
  FiatTransaction,
  Position,
} from '../types';
import {
  fiatFetch,
  transferBetweenFiatAndBot,
} from '../services/fiatApi';
import { formatCurrency } from '../utils/cryptoMath';
import { CashCheckModalTab } from './CashCheckModalTab';
import { BankBotSecurityTab } from './BankBotSecurityTab';
import { StripeCardDeposit, type StripeDepositResult } from './StripeCardDeposit';
import { PlaidBankDeposit } from './PlaidBankDeposit';
import { PayPalWithdraw } from './PayPalWithdraw';
import { CryptoToCashTab, type PositionLiquidatedSummary } from './CryptoToCashTab';
import { VaultToExchangeTransfer } from './VaultToExchangeTransfer';

export type TabType =
  | 'FUND_BOT'
  | 'CASH_CHECK'
  | 'SECURITY'
  | 'WITHDRAW'
  | 'CRYPTO_TO_CASH'
  | 'VAULT_TRANSFER'
  | 'ADD_BANK'
  | 'ADD_CARD'
  | 'DEPOSIT'
  | 'DEBIT_CARD'
  | 'BANK_TRANSFER'
  | 'TRANSFER_BOT'
  | 'LEDGER';

interface LiveCurrencyAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  fiatAccount: FiatAccount;
  transactions: FiatTransaction[];
  positions?: Position[];
  assets?: CryptoAsset[];
  onAccountUpdated: (newAccount: FiatAccount, notificationMsg?: string) => void;
  onBotCashAdjusted?: (amountDelta: number) => void;
  onPositionLiquidated?: (summary: PositionLiquidatedSummary) => void;
  botCash: number;
  initialTab?: TabType;
}

export const LiveCurrencyAccountModal: React.FC<LiveCurrencyAccountModalProps> = ({
  isOpen,
  onClose,
  fiatAccount,
  transactions,
  positions = [],
  assets = [],
  onAccountUpdated,
  onBotCashAdjusted,
  onPositionLiquidated,
  botCash,
  initialTab,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab || 'FUND_BOT');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Dedicated Tab: Fund Trading Bot State
  const [fundBotSourceType, setFundBotSourceType] = useState<'BANK' | 'CARD' | 'VAULT'>('CARD');
  const [fundBotAmount, setFundBotAmount] = useState<string>('500');
  const [fundSuccessReceipt, setFundSuccessReceipt] = useState<FiatTransaction | null>(null);

  // Sub-toggle for deposit method
  const [depositMethod, setDepositMethod] = useState<'CARD' | 'BANK'>('CARD');
  // Target destination for deposits: directly fund bot cash or store in live USD ledger
  const [depositTarget, setDepositTarget] = useState<'BOT' | 'VAULT'>('BOT');

  // Interactive ledger filters
  const [ledgerFilter, setLedgerFilter] = useState<'ALL' | 'WITHDRAW' | 'DEPOSIT' | 'BOT_TRANSFER'>('ALL');
  const [ledgerSearch, setLedgerSearch] = useState<string>('');

  // Card deposit amount
  const [cardDepositAmount, setCardDepositAmount] = useState<string>('');

  // Tab: Bot Transfer State
  const [botTransferDirection, setBotTransferDirection] = useState<'TO_BOT' | 'FROM_BOT'>('TO_BOT');
  const [botTransferAmount, setBotTransferAmount] = useState<string>('100');
  const [transfer2FaNeeded, setTransfer2FaNeeded] = useState<boolean>(false);
  const [transfer2FaCode, setTransfer2FaCode] = useState<string>('');
  const [checkRailInfo, setCheckRailInfo] = useState<{ active: boolean; env?: string | null }>({ active: false });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fiatFetch('/api/fiat/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (!cancelled && cfg?.rails) {
          setCheckRailInfo({ active: Boolean(cfg.rails.check), env: cfg.rails.increase?.env ?? null });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (initialTab && isOpen) {
      if (initialTab === 'FUND_BOT') {
        setActiveTab('FUND_BOT');
        setDepositTarget('BOT');
      } else if (initialTab === 'DEBIT_CARD' || initialTab === 'ADD_CARD') {
        setActiveTab('DEPOSIT');
        setDepositMethod('CARD');
        setDepositTarget('BOT');
      } else if (initialTab === 'BANK_TRANSFER') {
        setActiveTab('DEPOSIT');
        setDepositMethod('BANK');
        setDepositTarget('VAULT');
      } else {
        setActiveTab(initialTab);
      }
    } else if (isOpen && !initialTab) {
      setActiveTab('FUND_BOT');
      setDepositTarget('BOT');
    }
  }, [initialTab, isOpen]);

  const downloadReceiptText = (tx: FiatTransaction) => {
    const receiptContent = `========================================================
USD LEDGER TRANSACTION RECORD
========================================================
Transaction ID:     ${tx.id}${tx.externalId ? `\nProcessor Ref:      ${tx.externalId}` : ''}
Reference Hash:     ${tx.referenceHash}
Timestamp:          ${new Date(tx.timestamp).toISOString()} (${new Date(tx.timestamp).toLocaleString()})
Transaction Type:   ${tx.type}
Settlement Rail:    ${tx.rail}
Source:             ${tx.sourceName}
Destination:        ${tx.destinationName || 'USD Ledger'}
Gross Amount:       $${tx.amount.toFixed(2)} USD
Processor Fee:      $${(tx.fee || 0).toFixed(2)} USD
Net Credited/Paid:  $${(tx.netAmount ?? tx.amount).toFixed(2)} USD
Status:             ${tx.status}
========================================================`;
    const blob = new Blob([receiptContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Transaction-Record-${tx.referenceHash.slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const showFeedback = (type: 'success' | 'error', text: string) => {
    setFeedbackMessage({ type, text });
    setTimeout(() => {
      setFeedbackMessage(null);
    }, 6000);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(text);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  // Real card deposit finished (Stripe confirmed it and the server credited the ledger)
  const handleStripeDeposited = (result: StripeDepositResult, fallbackAmount: number) => {
    onAccountUpdated(result.account, result.message);
    if (result.directToBot && onBotCashAdjusted) {
      onBotCashAdjusted(result.botCreditAmount ?? result.transaction?.netAmount ?? fallbackAmount);
    }
    if (result.transaction) setFundSuccessReceipt(result.transaction);
    showFeedback('success', result.message);
  };

  // Primary: Handle Direct Transfer from USD Ledger to Trading Bot
  const handleFundBotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(fundBotAmount);
    if (isNaN(amt) || amt < 0.01) {
      showFeedback('error', 'Minimum funding amount is $0.01 USD.');
      return;
    }

    setIsLoading(true);
    try {
      if (fundBotSourceType === 'BANK') {
        throw new Error('Bank (ACH) deposits go to the USD ledger first. Use the Deposit / Bank tab, then Transfer to Bot after the funds settle.');
      } else if (fundBotSourceType === 'CARD') {
        throw new Error('Use the "Charge card" button inside the Stripe card form to pay.');
      } else if (fundBotSourceType === 'VAULT') {
        if (amt > fiatAccount.availableBalance) {
          throw new Error(`Insufficient funds in USD Ledger ($${fiatAccount.availableBalance.toFixed(2)} available).`);
        }
        const res = await transferBetweenFiatAndBot('TO_BOT', amt, transfer2FaCode.trim() || undefined);
        onAccountUpdated(res.account, res.message);
        if (onBotCashAdjusted) {
          onBotCashAdjusted(amt);
        }
        setTransfer2FaNeeded(false);
        setTransfer2FaCode('');
        setFundSuccessReceipt(res.transaction);
        showFeedback('success', res.message);
      }
    } catch (err: any) {
      if (err?.requires2FA) {
        setTransfer2FaNeeded(true);
      }
      showFeedback('error', err.message || 'Bot funding transfer failed.');
    } finally {
      setIsLoading(false);
    }
  };

  // 5. Handle Transfer Between Live Fiat and Bot Capital
  const handleBotTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(botTransferAmount);
    if (isNaN(amt) || amt < 0.01) {
      showFeedback('error', 'Minimum transfer amount is $0.01 USD.');
      return;
    }

    if (botTransferDirection === 'FROM_BOT' && amt > botCash) {
      showFeedback('error', `Cannot withdraw more than current bot margin cash balance ($${botCash.toFixed(2)}).`);
      return;
    }

    setIsLoading(true);
    try {
      const res = await transferBetweenFiatAndBot(botTransferDirection, amt, transfer2FaCode.trim() || undefined);
      onAccountUpdated(res.account, res.message);
      if (onBotCashAdjusted) {
        onBotCashAdjusted(botTransferDirection === 'TO_BOT' ? amt : -amt);
      }
      setTransfer2FaNeeded(false);
      setTransfer2FaCode('');
      showFeedback('success', res.message);
    } catch (err: any) {
      if (err?.requires2FA) {
        setTransfer2FaNeeded(true);
      }
      showFeedback('error', err.message || 'Capital transfer failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700/80 w-full max-w-6xl xl:max-w-7xl rounded-2xl shadow-2xl overflow-hidden flex flex-col my-auto max-h-[94vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-emerald-500/20 via-teal-500/20 to-cyan-500/20 border border-emerald-500/30 text-emerald-400">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-white tracking-tight">Live Currency Account & Banking Rail</h2>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase flex items-center gap-1 border ${
                  fiatAccount.twoFactorEnabled
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                }`}>
                  <ShieldCheck className="h-3 w-3" />
                  {fiatAccount.twoFactorEnabled ? '2FA Active' : '2FA Setup Needed'}
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-cyan-300 bg-cyan-500/10 border border-cyan-500/30">
                  Live Stripe & PayPal
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Live USD ledger with Stripe card deposits, Plaid + Stripe ACH bank linking, and PayPal payouts.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Balance Overview Banner */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border-b border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Available Fiat Cash</div>
            <div className="text-xl font-black text-emerald-400 font-mono mt-0.5">
              {formatCurrency(fiatAccount.availableBalance)}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              {fiatAccount.pendingBalance > 0
                ? <span className="text-amber-300 font-mono">Pending: {formatCurrency(fiatAccount.pendingBalance)}</span>
                : 'USD Ledger (Settled)'}
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Allocated to Bot</div>
            <div className="text-xl font-black text-cyan-400 font-mono mt-0.5">
              {formatCurrency(fiatAccount.allocatedToTrading)}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Active Trading Margin</div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Connected Banks</div>
            <div className="text-xl font-black text-white font-mono mt-0.5">
              {fiatAccount.linkedBanks.length} <span className="text-xs font-normal text-slate-400">Linked</span>
            </div>
            <div className="text-[10px] text-emerald-400/80 mt-0.5 flex items-center gap-1">
              <CheckCircle2 className="h-2.5 w-2.5" /> {fiatAccount.linkedBanks.length > 0 ? 'Plaid + Stripe ACH' : 'No bank linked'}
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">Daily Limit Remaining</div>
            <div className="text-xl font-black text-slate-200 font-mono mt-0.5">
              ${Math.max(0, fiatAccount.dailyDepositLimit - fiatAccount.dailyDepositUsed).toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Limit: ${fiatAccount.dailyDepositLimit.toLocaleString()}/day</div>
          </div>
        </div>

        {/* Feedback Alert */}
        {feedbackMessage && (
          <div
            className={`mx-6 mt-4 p-3 rounded-xl text-xs flex items-center gap-2.5 border ${
              feedbackMessage.type === 'success'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
            }`}
          >
            {feedbackMessage.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
            )}
            <div className="flex-1">{feedbackMessage.text}</div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-800 px-6 bg-slate-950/70 overflow-x-auto text-xs font-semibold gap-2 py-3 scrollbar-thin">
          <button
            type="button"
            onClick={() => setActiveTab('FUND_BOT')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'FUND_BOT'
                ? 'bg-amber-500/25 text-amber-200 border border-amber-500/60 shadow-md font-bold ring-1 ring-amber-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <Zap className="h-4 w-4 text-amber-400" />
            <span className="text-xs">Fund Trading Bot</span>
            <span className="text-[9px] bg-amber-500/30 text-amber-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Stripe &amp; Ledger
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('CASH_CHECK')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'CASH_CHECK'
                ? 'bg-emerald-500/20 text-white border border-emerald-500/60 shadow-md font-bold ring-1 ring-emerald-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <FileCheck className="h-4 w-4 text-emerald-400" />
            <span className="text-xs">Check Deposit</span>
            <span
              className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-bold ${
                checkRailInfo.active
                  ? 'bg-emerald-500/30 text-emerald-200'
                  : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {checkRailInfo.active ? `Check 21 (${checkRailInfo.env || 'live'})` : 'Setup Required'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('SECURITY')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'SECURITY'
                ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/60 shadow-md font-bold ring-1 ring-cyan-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <ShieldCheck className="h-4 w-4 text-cyan-400" />
            <span className="text-xs">Bank &amp; Bot Security</span>
            <span className="text-[9px] bg-cyan-500/30 text-cyan-200 px-2 py-0.5 rounded-full font-mono font-bold">
              {fiatAccount.twoFactorEnabled ? '2FA Active' : 'Setup 2FA'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('WITHDRAW')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'WITHDRAW'
                ? 'bg-rose-500/25 text-rose-200 border border-rose-500/60 shadow-md font-bold ring-1 ring-rose-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <ArrowUpFromLine className="h-4 w-4 text-rose-400" />
            <span className="text-xs">Withdraw Funds</span>
            <span className="text-[9px] bg-rose-500/30 text-rose-200 px-2 py-0.5 rounded-full font-mono font-bold">
              PayPal Payouts
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('CRYPTO_TO_CASH')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'CRYPTO_TO_CASH'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/60 shadow-md font-bold ring-1 ring-emerald-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <Coins className="h-4 w-4 text-emerald-400" />
            <span className="text-xs">Crypto-to-Cash</span>
            <span className="text-[9px] bg-emerald-500/30 text-emerald-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Spot → PayPal
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('VAULT_TRANSFER')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'VAULT_TRANSFER'
                ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/60 shadow-md font-bold ring-1 ring-cyan-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <Vault className="h-4 w-4 text-cyan-400" />
            <span className="text-xs">Vault → Exchange</span>
            <span className="text-[9px] bg-cyan-500/30 text-cyan-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Kraken / CEX
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('ADD_BANK')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'ADD_BANK'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/60 shadow-md font-bold ring-1 ring-emerald-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <Landmark className="h-4 w-4 text-emerald-400" />
            <span className="text-xs">+ Link Bank</span>
            <span className="text-[9px] bg-emerald-500/30 text-emerald-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Plaid
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('DEPOSIT')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'DEPOSIT' || activeTab === 'DEBIT_CARD' || activeTab === 'BANK_TRANSFER'
                ? 'bg-amber-500/25 text-amber-200 border border-amber-500/60 shadow-md font-bold ring-1 ring-amber-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <ArrowDownToLine className="h-4 w-4 text-amber-400" />
            <span className="text-xs">Deposit to Ledger</span>
            <span className="text-[9px] bg-amber-500/30 text-amber-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Card &amp; Bank
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('TRANSFER_BOT')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'TRANSFER_BOT'
                ? 'bg-purple-500/25 text-purple-200 border border-purple-500/60 shadow-md font-bold ring-1 ring-purple-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <ArrowLeftRight className="h-4 w-4 text-purple-400" />
            <span className="text-xs">Ledger ⇄ Bot Bridge</span>
            <span className="text-[9px] bg-purple-500/30 text-purple-200 px-2 py-0.5 rounded-full font-mono font-bold">
              Margin Move
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('LEDGER')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'LEDGER'
                ? 'bg-blue-500/25 text-blue-200 border border-blue-500/60 shadow-md font-bold ring-1 ring-blue-500/40'
                : 'text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent'
            }`}
          >
            <Clock className="h-4 w-4 text-blue-400" />
            <span className="text-xs">Audit Ledger</span>
            <span className="text-[9px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full font-mono">
              {transactions.length}
            </span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* TAB: CHECK DEPOSIT NOTICE */}
          {activeTab === 'CASH_CHECK' && (
            <CashCheckModalTab
              fiatAccount={fiatAccount}
              onAccountUpdated={onAccountUpdated}
              onBotCashAdjusted={onBotCashAdjusted}
              botCash={botCash}
              onSwitchToDeposit={(m) => {
                setDepositMethod(m);
                setActiveTab('DEPOSIT');
              }}
            />
          )}

          {/* TAB: BANK & BOT SECURITY ENGINE */}
          {activeTab === 'SECURITY' && (
            <BankBotSecurityTab
              fiatAccount={fiatAccount}
              onAccountUpdated={onAccountUpdated}
            />
          )}

          {/* TAB: FUND TRADING BOT */}
          {activeTab === 'FUND_BOT' && (
            <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-200">
              {/* Receipt Banner if just completed */}
              {fundSuccessReceipt && (
                <div className="p-5 rounded-2xl bg-emerald-950/40 border border-emerald-500/60 shadow-2xl space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                        <CheckCircle2 className="h-6 w-6" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white flex items-center gap-2">
                          <span>Trading Bot Successfully Funded</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                            {fundSuccessReceipt.status}
                          </span>
                        </h4>
                        <p className="text-xs text-slate-300 mt-0.5">
                          ${(fundSuccessReceipt.netAmount ?? fundSuccessReceipt.amount).toFixed(2)} USD credited into Bot Active Margin.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setFundSuccessReceipt(null)}
                      className="text-slate-400 hover:text-white p-1 rounded-lg text-xs"
                      title="Dismiss receipt"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-800/80 text-xs">
                    <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
                      <div className="text-[10px] text-slate-400 font-mono uppercase">Net Credited</div>
                      <div className="text-base font-black text-emerald-400 font-mono mt-0.5">
                        +{formatCurrency(fundSuccessReceipt.netAmount ?? fundSuccessReceipt.amount)}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
                      <div className="text-[10px] text-slate-400 font-mono uppercase">Source</div>
                      <div className="text-xs font-bold text-white truncate mt-0.5">
                        {fundSuccessReceipt.sourceName}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">{fundSuccessReceipt.rail}</div>
                    </div>

                    <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
                      <div className="text-[10px] text-slate-400 font-mono uppercase">Processor Fee</div>
                      <div className="text-xs font-bold text-cyan-300 mt-0.5 font-mono">
                        {formatCurrency(fundSuccessReceipt.fee || 0)}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">Gross: {formatCurrency(fundSuccessReceipt.amount)}</div>
                    </div>

                    <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
                      <div className="text-[10px] text-slate-400 font-mono uppercase">Current Bot Margin</div>
                      <div className="text-base font-black text-cyan-400 font-mono mt-0.5">
                        {formatCurrency(botCash)}
                      </div>
                      <div className="text-[10px] text-slate-500">Live balance</div>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="text-[10px] text-slate-500 uppercase font-semibold">Audit Hash:</span>
                      <span className="text-cyan-400 truncate text-[11px] select-all">
                        {fundSuccessReceipt.referenceHash}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(fundSuccessReceipt.referenceHash)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] shrink-0 ml-2 transition-all cursor-pointer"
                    >
                      {copiedHash === fundSuccessReceipt.referenceHash ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 text-slate-400" />
                          <span>Copy Hash</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => downloadReceiptText(fundSuccessReceipt)}
                      className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 hover:text-emerald-300 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 border border-emerald-500/30"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Record (.txt)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFundSuccessReceipt(null)}
                      className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all cursor-pointer"
                    >
                      Fund More Capital
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-black text-xs transition-all cursor-pointer flex items-center gap-1.5 shadow-md shadow-emerald-500/20"
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span>Return to Desk</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Main Fund Bot Configuration Card */}
              <div className="p-6 bg-slate-900/90 border border-amber-500/30 rounded-2xl shadow-xl space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-gradient-to-br from-amber-500/20 via-orange-500/20 to-yellow-500/20 border border-amber-500/40 text-amber-400">
                      <Zap className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="text-base sm:text-lg font-bold text-white tracking-wide flex items-center gap-2">
                        <span>Fund Trading Bot (Live USD Only)</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          Direct to Margin
                        </span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Fund Bot Active Margin via live Stripe card payments or transfer settled USD from your ledger.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 self-start sm:self-auto font-mono">
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400 uppercase tracking-wider">Current Bot Margin</div>
                      <div className="text-base sm:text-lg font-black text-emerald-400">
                        {formatCurrency(botCash)}
                      </div>
                    </div>
                  </div>
                </div>

                <form onSubmit={handleFundBotSubmit} className="space-y-6">
                  {/* STEP 1: SELECT TRANSFER SOURCE */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5">
                      1. Select Funding Source
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* Option A: Card via Stripe */}
                      <div
                        onClick={() => setFundBotSourceType('CARD')}
                        className={`p-4 rounded-xl border cursor-pointer transition-all ${
                          fundBotSourceType === 'CARD'
                            ? 'bg-cyan-950/30 border-cyan-500/80 ring-2 ring-cyan-500/40 shadow-lg shadow-cyan-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="p-2 rounded-lg bg-cyan-500/20 text-cyan-300">
                              <CreditCard className="h-4 w-4" />
                            </div>
                            <span className="text-sm font-bold text-white">Debit / Credit Card</span>
                          </div>
                          <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-bold">
                            Stripe
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-2">
                          Pay with Stripe Elements. Net settled USD is credited directly to Bot Margin.
                        </div>
                      </div>

                      {/* Option B: Bank Account */}
                      <div
                        onClick={() => setFundBotSourceType('BANK')}
                        className={`p-4 rounded-xl border cursor-pointer transition-all ${
                          fundBotSourceType === 'BANK'
                            ? 'bg-amber-950/30 border-amber-500/80 ring-2 ring-amber-500/40 shadow-lg shadow-amber-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-300">
                              <Building2 className="h-4 w-4" />
                            </div>
                            <span className="text-sm font-bold text-white">Bank Account</span>
                          </div>
                          <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                            Plaid ACH
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-2">
                          US bank via Plaid + Stripe ACH. Settles into USD Ledger first (~4 business days).
                        </div>
                        {fiatAccount.linkedBanks.length > 0 && (
                          <div className="text-[10px] text-cyan-300 font-mono mt-2">
                            {fiatAccount.linkedBanks.length} linked bank{fiatAccount.linkedBanks.length > 1 ? 's' : ''}
                          </div>
                        )}
                      </div>

                      {/* Option C: USD Ledger */}
                      <div
                        onClick={() => setFundBotSourceType('VAULT')}
                        className={`p-4 rounded-xl border cursor-pointer transition-all ${
                          fundBotSourceType === 'VAULT'
                            ? 'bg-purple-950/30 border-purple-500/80 ring-2 ring-purple-500/40 shadow-lg shadow-purple-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="p-2 rounded-lg bg-purple-500/20 text-purple-300">
                              <Landmark className="h-4 w-4" />
                            </div>
                            <span className="text-sm font-bold text-white">USD Ledger</span>
                          </div>
                          <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-bold">
                            Internal
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-2">
                          Move settled USD from your Live Ledger balance into Bot Active Margin.
                        </div>
                        <div className="text-[10px] text-emerald-400 font-mono mt-2">
                          {formatCurrency(fiatAccount.availableBalance)} available
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* STEP 2: FUNDING AMOUNT (for CARD and VAULT) */}
                  {fundBotSourceType !== 'BANK' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                          2. Amount (USD)
                        </label>
                        <span className="text-xs text-slate-400 font-mono">
                          {fundBotSourceType === 'CARD' ? 'Min: $0.50 (Stripe fee applies)' : 'Min: $0.01 · No internal fee'}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2 mb-2.5">
                        {[25, 100, 250, 500, 1000, 2500].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setFundBotAmount(String(preset))}
                            className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold cursor-pointer transition-all ${
                              fundBotAmount === String(preset)
                                ? 'bg-amber-500/20 border-amber-500 text-amber-200 shadow-sm'
                                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                            }`}
                          >
                            +${preset.toLocaleString()}
                          </button>
                        ))}
                      </div>

                      <div className="relative">
                        <span className="absolute left-4 top-2.5 text-slate-400 font-mono text-xl font-bold">$</span>
                        <input
                          type="number"
                          min={fundBotSourceType === 'CARD' ? '0.50' : '0.01'}
                          step="0.01"
                          value={fundBotAmount}
                          onChange={(e) => setFundBotAmount(e.target.value)}
                          placeholder="500.00"
                          className="w-full bg-slate-950 border border-slate-700 text-white pl-9 pr-4 py-2.5 rounded-xl font-mono text-2xl font-black focus:outline-none focus:border-amber-500"
                          required
                        />
                      </div>
                    </div>
                  )}

                  {/* STEP 3: SOURCE ACTION */}
                  {fundBotSourceType === 'BANK' && (
                    <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-2xl space-y-3 text-xs text-slate-300">
                      <div className="font-bold text-white">Bank (ACH) deposits go to your USD ledger first</div>
                      <p>
                        ACH takes about 4 business days and can be returned by the bank after it settles, so it cannot fund the bot directly. Deposit from your bank
                        on the Bank tab, then transfer to Bot once settled.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setDepositMethod('BANK');
                          setActiveTab('DEPOSIT');
                        }}
                        className="px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold cursor-pointer"
                      >
                        Go to Bank Deposit
                      </button>
                    </div>
                  )}

                  {fundBotSourceType === 'CARD' && (
                    <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-2xl space-y-3">
                      <StripeCardDeposit
                        amount={parseFloat(fundBotAmount) || 0}
                        directToBot
                        buttonLabel="Charge card and fund bot"
                        onDeposited={(r) => handleStripeDeposited(r, parseFloat(fundBotAmount) || 0)}
                        onError={(m) => showFeedback('error', m)}
                      />
                    </div>
                  )}

                  {fundBotSourceType === 'VAULT' && (
                    <>
                      <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-2xl space-y-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-300 font-bold">Live USD Ledger Available:</span>
                          <span className="font-mono text-base font-black text-emerald-400">
                            {formatCurrency(fiatAccount.availableBalance)}
                          </span>
                        </div>
                        <div className="flex gap-2 pt-1">
                          {[0.25, 0.5, 0.75, 1].map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => setFundBotAmount(String(Math.floor(fiatAccount.availableBalance * pct * 100) / 100))}
                              className="flex-1 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800/80 border border-slate-800 hover:border-purple-500/40 text-slate-300 font-mono text-xs font-bold cursor-pointer transition-all"
                            >
                              {pct === 1 ? 'MAX (100%)' : `${pct * 100}%`}
                            </button>
                          ))}
                        </div>

                        {(transfer2FaNeeded || (parseFloat(fundBotAmount) || 0) >= 2000) && (
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                              6-digit 2FA Code (required for transfers ≥ $2,000)
                            </label>
                            <input
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              maxLength={6}
                              value={transfer2FaCode}
                              onChange={(e) => setTransfer2FaCode(e.target.value.replace(/\D/g, ''))}
                              placeholder="123456"
                              className="w-40 bg-slate-900 border border-slate-700 text-white px-3 py-2 rounded-lg font-mono text-sm focus:outline-none focus:border-purple-500"
                            />
                          </div>
                        )}
                      </div>

                      <button
                        type="submit"
                        disabled={isLoading || parseFloat(fundBotAmount || '0') <= 0 || parseFloat(fundBotAmount || '0') > fiatAccount.availableBalance}
                        className="w-full py-4 rounded-xl bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer shadow-xl shadow-amber-500/20 transition-all disabled:opacity-50 active:scale-[0.99]"
                      >
                        {isLoading ? (
                          <div className="flex items-center gap-2">
                            <RefreshCw className="h-4 w-4 animate-spin" />
                            <span>Updating Live Ledger...</span>
                          </div>
                        ) : (
                          <>
                            <Zap className="h-5 w-5" />
                            <span>
                              {`Transfer Settled USD to Bot: $${(parseFloat(fundBotAmount || '0') || 0).toFixed(2)} USD`}
                            </span>
                          </>
                        )}
                      </button>
                    </>
                  )}
                </form>
              </div>
            </div>
          )}

          {/* TAB: LINK A BANK ACCOUNT (Plaid Link) */}
          {activeTab === 'ADD_BANK' && (
            <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-200">
              <div className="p-6 bg-slate-900/90 border border-cyan-500/30 rounded-2xl shadow-xl space-y-5">
                <div className="flex items-center gap-3 border-b border-slate-800 pb-4">
                  <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                    <Landmark className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white tracking-wide">Link a bank account</h3>
                    <p className="text-xs text-slate-400">Verified through Plaid and used for ACH deposits through Stripe. Withdrawals use PayPal Payouts.</p>
                  </div>
                </div>
                <PlaidBankDeposit
                  linkedBanks={fiatAccount.linkedBanks}
                  onAccountUpdated={(account, message) => {
                    onAccountUpdated(account, message);
                    showFeedback('success', message);
                  }}
                  onError={(m) => showFeedback('error', m)}
                />
              </div>
            </div>
          )}

          {/* UNIFIED DEPOSIT HEADER & RAIL SELECTOR */}
          {(activeTab === 'DEPOSIT' || activeTab === 'DEBIT_CARD' || activeTab === 'BANK_TRANSFER' || activeTab === 'ADD_CARD') && (
            <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-2xl space-y-4 mb-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
                    <span>Deposit Live USD Funds</span>
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Deposit USD via Stripe card checkout or Plaid + Stripe ACH bank debit.
                  </p>
                </div>

                {/* Rail Selector */}
                <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('DEPOSIT');
                      setDepositMethod('CARD');
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                      depositMethod === 'CARD'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <CreditCard className="h-3.5 w-3.5" />
                    <span>Card Payment (Stripe)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('DEPOSIT');
                      setDepositMethod('BANK');
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                      depositMethod === 'BANK'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Building2 className="h-3.5 w-3.5" />
                    <span>Connected Bank (Plaid ACH)</span>
                  </button>
                </div>
              </div>

              {/* Destination Target: Direct to Bot vs Live USD Ledger */}
              {depositMethod === 'CARD' && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-slate-900/60 border border-slate-800 rounded-xl">
                  <div>
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-400" />
                      <span>Deposit Destination Target:</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {depositTarget === 'BOT'
                        ? 'Net Stripe proceeds credit Bot Active Margin so orders can run immediately.'
                        : 'Net Stripe proceeds stay in your Live USD Ledger until you transfer them.'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDepositTarget('BOT')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all flex items-center gap-1.5 ${
                        depositTarget === 'BOT'
                          ? 'bg-emerald-500 text-slate-950 shadow-md ring-2 ring-emerald-400/40 font-extrabold'
                          : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span>Direct to Bot Trading Cash</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDepositTarget('VAULT')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all flex items-center gap-1.5 ${
                        depositTarget === 'VAULT'
                          ? 'bg-cyan-500 text-slate-950 shadow-md ring-2 ring-cyan-400/40 font-extrabold'
                          : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Landmark className="h-3.5 w-3.5" />
                      <span>Live USD Ledger</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 1: STRIPE CARD DEPOSIT */}
          {(((activeTab === 'DEPOSIT' || activeTab === 'ADD_CARD') && depositMethod === 'CARD') || activeTab === 'DEBIT_CARD') && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* Left Column: Honest Stripe Settlement Details */}
              <div className="md:col-span-5 flex flex-col justify-between space-y-4">
                <div className="p-5 rounded-2xl bg-slate-950/80 border border-cyan-500/30 space-y-3">
                  <div className="flex items-center gap-2 text-cyan-300 font-bold text-sm">
                    <Lock className="h-4 w-4 text-cyan-400" />
                    <span>Live Stripe Card Settlement</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Card numbers, expiry dates, and CVCs are collected directly inside Stripe Elements. This server never sees or stores raw card details.
                  </p>
                  <ul className="text-[11px] text-slate-400 space-y-1.5 list-disc pl-4">
                    <li>Minimum deposit: $0.50 USD</li>
                    <li>3-D Secure authentication is triggered automatically when required by your issuing bank</li>
                    <li>Net settlement (after Stripe processing fees) is credited only after Stripe confirms settlement</li>
                  </ul>
                </div>
              </div>

              {/* Right Column: Loading Controls */}
              <div className="md:col-span-7">
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">Deposit amount (USD)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-slate-400 font-mono text-sm">$</span>
                      <input
                        type="number"
                        min="0.5"
                        step="0.01"
                        value={cardDepositAmount}
                        onChange={(e) => setCardDepositAmount(e.target.value)}
                        placeholder="0.50"
                        className="w-full bg-slate-900 border border-slate-700 text-white pl-8 pr-4 py-2.5 rounded-xl font-mono text-base font-bold focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">Minimum $0.50 (Stripe). Credits to {depositTarget === 'BOT' ? 'the trading bot cash balance' : 'your USD ledger'}.</p>
                  </div>

                  <StripeCardDeposit
                    amount={parseFloat(cardDepositAmount) || 0}
                    directToBot={depositTarget === 'BOT'}
                    onDeposited={(r) => handleStripeDeposited(r, parseFloat(cardDepositAmount) || 0)}
                    onError={(m) => showFeedback('error', m)}
                  />
                </div>
                </div>
              </div>
          )}

          {/* TAB 2: BANK DEPOSIT (Plaid Link + Stripe ACH) */}
          {((activeTab === 'DEPOSIT' && depositMethod === 'BANK') || activeTab === 'BANK_TRANSFER') && (
            <div className="space-y-6">
              <PlaidBankDeposit
                linkedBanks={fiatAccount.linkedBanks}
                onAccountUpdated={(account, message) => {
                  onAccountUpdated(account, message);
                  showFeedback('success', message);
                }}
                onError={(m) => showFeedback('error', m)}
              />
            </div>
          )}

          {/* TAB 3: WITHDRAW TO PAYPAL (PayPal Payouts) */}
          {activeTab === 'WITHDRAW' && (
            <div className="max-w-3xl mx-auto space-y-4">
              <PayPalWithdraw
                availableBalance={fiatAccount.availableBalance}
                allocatedToTrading={fiatAccount.allocatedToTrading}
                onAccountUpdated={(account, message) => {
                  onAccountUpdated(account, message);
                  showFeedback('success', message);
                }}
                onBotCashAdjusted={onBotCashAdjusted}
                onSwitchToDeposit={() => {
                  setDepositMethod('CARD');
                  setActiveTab('DEPOSIT');
                }}
                onSwitchToCryptoToCash={() => setActiveTab('CRYPTO_TO_CASH')}
                onError={(m) => showFeedback('error', m)}
              />
            </div>
          )}

          {/* TAB 3B: CRYPTO-TO-CASH PAYOUTS (SPOT SELL -> PAYPAL PAYOUTS) */}
          {activeTab === 'CRYPTO_TO_CASH' && (
            <CryptoToCashTab
              fiatAccount={fiatAccount}
              transactions={transactions}
              positions={positions}
              assets={assets}
              onAccountUpdated={(account, message) => {
                onAccountUpdated(account, message);
                if (message) showFeedback('success', message);
              }}
              onPositionLiquidated={onPositionLiquidated}
              onError={(m) => showFeedback('error', m)}
            />
          )}

          {/* TAB 3C: PROFIT VAULT -> KRAKEN / EXCHANGE TRANSFER */}
          {activeTab === 'VAULT_TRANSFER' && (
            <div className="max-w-4xl mx-auto">
              <VaultToExchangeTransfer
                defaultExchange="KRAKEN"
                onTransferComplete={(info) => {
                  showFeedback(
                    'success',
                    `Sent ${info.amount} ${info.asset} from Vault to ${info.exchange} (${info.txHash.slice(0, 10)}...)`
                  );
                }}
              />
            </div>
          )}

          {/* TAB 4: BOT CAPITAL TRANSFER */}
          {activeTab === 'TRANSFER_BOT' && (
            <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-2xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-xs font-bold text-white">Bridge Live USD Ledger &amp; Trading Bot</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Move settled USD between your live currency ledger and active bot trading margin.
                  </p>
                </div>
                <div className="text-right font-mono text-xs">
                  <div className="text-slate-400 text-[10px]">Bot Trading Cash</div>
                  <div className="text-cyan-400 font-bold">{formatCurrency(botCash)}</div>
                </div>
              </div>

              <form onSubmit={handleBotTransfer} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setBotTransferDirection('TO_BOT')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                      botTransferDirection === 'TO_BOT'
                        ? 'bg-emerald-500/10 border-emerald-500/50 text-white'
                        : 'bg-slate-900 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="text-xs font-bold flex items-center gap-1.5 text-emerald-400">
                      <ArrowDownToLine className="h-3.5 w-3.5" />
                      <span>Allocate to Trading Bot</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">Live USD Ledger ➔ Bot Trading Cash</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setBotTransferDirection('FROM_BOT')}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                      botTransferDirection === 'FROM_BOT'
                        ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                        : 'bg-slate-900 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="text-xs font-bold flex items-center gap-1.5 text-cyan-400">
                      <ArrowUpFromLine className="h-3.5 w-3.5" />
                      <span>Return Bot Cash to Ledger</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">Bot Trading Cash ➔ Live USD Ledger (for withdrawal)</div>
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] text-slate-400">Transfer Amount (USD)</label>
                    <span className="text-[10px] font-mono text-slate-400">
                      Available to Move:{' '}
                      <strong className="text-white">
                        {formatCurrency(botTransferDirection === 'TO_BOT' ? fiatAccount.availableBalance : botCash)}
                      </strong>
                    </span>
                  </div>

                  {/* Percentage Presets */}
                  <div className="flex gap-2 mb-2">
                    {[0.25, 0.5, 0.75, 1].map((pct) => {
                      const pool = botTransferDirection === 'TO_BOT' ? fiatAccount.availableBalance : botCash;
                      const val = Math.floor(pool * pct * 100) / 100;
                      return (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setBotTransferAmount(String(val))}
                          className="flex-1 py-1 rounded-lg bg-slate-900 border border-slate-800 hover:border-cyan-500/40 text-slate-300 font-mono text-xs font-bold cursor-pointer transition-all hover:text-white"
                        >
                          {pct === 1 ? 'MAX (100%)' : `${pct * 100}%`}
                        </button>
                      );
                    })}
                  </div>

                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-slate-400 font-mono text-sm">$</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0.01"
                      value={botTransferAmount}
                      onChange={(e) => setBotTransferAmount(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 text-white pl-8 pr-4 py-2.5 rounded-xl font-mono text-base font-bold focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                {(transfer2FaNeeded || (parseFloat(botTransferAmount) || 0) >= 2000) && (
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">
                      6-digit 2FA Code (required for transfers ≥ $2,000)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={transfer2FaCode}
                      onChange={(e) => setTransfer2FaCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      className="w-40 bg-slate-900 border border-slate-700 text-white px-3 py-2 rounded-lg font-mono text-sm focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-bold text-xs uppercase tracking-wider rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2"
                >
                  <ArrowLeftRight className="h-4 w-4" />
                  <span>
                    Execute Ledger Transfer (${(parseFloat(botTransferAmount || '0') || 0).toFixed(2)})
                  </span>
                </button>
              </form>
            </div>
          )}

          {/* TAB 5: AUDIT LEDGER */}
          {activeTab === 'LEDGER' && (
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Receipt className="h-4 w-4 text-cyan-400" />
                    USD Ledger Transaction Log
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Recorded Stripe card payments, Plaid ACH bank transfers, Increase Check 21 deposits, PayPal payouts, and bot margin transfers.
                  </p>
                </div>
                <span className="font-mono text-xs text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 rounded-full self-start sm:self-auto">
                  {transactions.length} Entries
                </span>
              </div>

              {/* Interactive Search & Filter Controls */}
              <div className="flex flex-col sm:flex-row items-center gap-2 pt-1">
                <div className="relative w-full sm:flex-1">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={ledgerSearch}
                    onChange={(e) => setLedgerSearch(e.target.value)}
                    placeholder="Search by bank, card, rail, or hash..."
                    className="w-full bg-slate-950 border border-slate-800 text-xs text-white pl-8 pr-3 py-1.5 rounded-xl focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  {ledgerSearch && (
                    <button
                      type="button"
                      onClick={() => setLedgerSearch('')}
                      className="absolute right-2.5 top-2 text-slate-400 hover:text-white text-xs"
                    >
                      ×
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
                  <button
                    type="button"
                    onClick={() => setLedgerFilter('ALL')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                      ledgerFilter === 'ALL'
                        ? 'bg-cyan-500 text-slate-950 font-bold'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    All ({transactions.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLedgerFilter('WITHDRAW')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                      ledgerFilter === 'WITHDRAW'
                        ? 'bg-rose-500 text-white font-bold'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-rose-300'
                    }`}
                  >
                    Withdrawals ({transactions.filter((t) => t.type.includes('WITHDRAW')).length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLedgerFilter('DEPOSIT')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                      ledgerFilter === 'DEPOSIT'
                        ? 'bg-emerald-500 text-slate-950 font-bold'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-emerald-300'
                    }`}
                  >
                    Deposits ({transactions.filter((t) => t.type.includes('DEPOSIT') || t.type.includes('LOAD') || t.type === 'CRYPTO_LIQUIDATION').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLedgerFilter('BOT_TRANSFER')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                      ledgerFilter === 'BOT_TRANSFER'
                        ? 'bg-blue-500 text-white font-bold'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-300'
                    }`}
                  >
                    Bot Bridge ({transactions.filter((t) => t.type.includes('BOT')).length})
                  </button>
                </div>
              </div>

              {/* Transactions List */}
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                {(() => {
                  const filtered = transactions.filter((tx) => {
                    if (ledgerFilter === 'WITHDRAW' && !tx.type.includes('WITHDRAW')) return false;
                    if (ledgerFilter === 'DEPOSIT' && !(tx.type.includes('DEPOSIT') || tx.type.includes('LOAD') || tx.type === 'CRYPTO_LIQUIDATION')) return false;
                    if (ledgerFilter === 'BOT_TRANSFER' && !tx.type.includes('BOT')) return false;
                    if (ledgerSearch.trim()) {
                      const q = ledgerSearch.toLowerCase();
                      const matchSource = tx.sourceName?.toLowerCase().includes(q);
                      const matchDest = tx.destinationName?.toLowerCase().includes(q);
                      const matchHash = tx.referenceHash?.toLowerCase().includes(q);
                      const matchRail = tx.rail?.toLowerCase().includes(q);
                      if (!matchSource && !matchDest && !matchHash && !matchRail) return false;
                    }
                    return true;
                  });

                  if (filtered.length === 0) {
                    return (
                      <div className="p-8 text-center text-slate-500 text-xs bg-slate-950/40 rounded-xl border border-slate-800/60">
                        No transactions found matching the current filter or search criteria.
                      </div>
                    );
                  }

                  return filtered.map((tx) => (
                    <div
                      key={tx.id}
                      className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between hover:border-slate-700 transition-all text-xs group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-cyan-400">
                          {tx.type.includes('DEPOSIT') || tx.type.includes('LOAD') || tx.type === 'CRYPTO_LIQUIDATION' ? (
                            <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <ArrowUpFromLine className="h-4 w-4 text-cyan-400" />
                          )}
                        </div>
                        <div>
                          <div className="font-bold text-white flex items-center gap-2">
                            <span>{tx.sourceName}</span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                              {tx.rail}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
                            <span>{new Date(tx.timestamp).toLocaleString()}</span>
                            <span>•</span>
                            <span className="font-mono text-slate-500">Hash: {tx.referenceHash}</span>
                            <button
                              onClick={() => copyToClipboard(tx.referenceHash)}
                              className="text-slate-400 hover:text-cyan-300"
                              title="Copy transaction hash"
                            >
                              {copiedHash === tx.referenceHash ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                            <button
                              onClick={() => downloadReceiptText(tx)}
                              className="text-slate-400 hover:text-emerald-400 flex items-center gap-1 cursor-pointer"
                              title="Download Proof of Settlement (.txt)"
                            >
                              <Download className="h-3 w-3" />
                              <span>Receipt</span>
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="text-right font-mono">
                        <div
                          className={`font-bold ${
                            tx.type.includes('WITHDRAW') ? 'text-rose-400' : 'text-emerald-400'
                          }`}
                        >
                          {tx.type.includes('WITHDRAW') ? '-' : '+'}
                          {formatCurrency(tx.amount)}
                        </div>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded ${
                            tx.status === 'COMPLETED'
                              ? 'text-emerald-400 bg-emerald-500/10'
                              : tx.status === 'FAILED'
                              ? 'text-rose-400 bg-rose-500/10'
                              : 'text-amber-400 bg-amber-500/10'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Footer Settlement Rail Note */}
        <div className="px-6 py-3 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-slate-300">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>Live Settlement Rails: Stripe (Card &amp; ACH) · Increase Check 21 · PayPal Payouts · Encrypted Ledger</span>
            </span>
          </div>
          <div className="font-mono text-[10px] text-slate-500">
            Account: {fiatAccount.accountNumberMasked}
          </div>
        </div>
      </div>
    </div>
  );
};
