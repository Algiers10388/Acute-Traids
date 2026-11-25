import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import type { CryptoAsset, ExchangeId, FiatAccount, FiatTransaction, Position } from '../types';
import {
  confirmTotp2FA,
  executeCryptoToCash,
  fiatFetch,
  quoteCryptoToCash,
  reconcilePaypalPayouts,
  setupTotp2FA,
  verifyPaypalAuth,
  type CryptoToCashQuote,
} from '../services/fiatApi';
import { formatCurrency } from '../utils/cryptoMath';

type SpotExchange = 'KRAKEN' | 'COINBASE' | 'BINANCE' | 'NONKYC' | 'OKX';

const SPOT_EXCHANGES: { id: SpotExchange; label: string }[] = [
  { id: 'KRAKEN', label: 'Kraken' },
  { id: 'COINBASE', label: 'Coinbase' },
  { id: 'BINANCE', label: 'Binance' },
  { id: 'NONKYC', label: 'NonKYC' },
  { id: 'OKX', label: 'OKX' },
];

const STABLE_ASSETS = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'EUR', 'ZUSD']);

interface ExchangeWalletHolding {
  exchange: SpotExchange;
  asset: string;
  symbol: string;
  balance: number;
}

export interface PositionLiquidatedSummary {
  positionId: string;
  orderId?: string;
  exchange: ExchangeId;
  exchangeName: string;
  symbol: string;
  soldQuantity: number;
  unitPriceUsd: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
}

interface CryptoToCashTabProps {
  fiatAccount: FiatAccount;
  transactions: FiatTransaction[];
  positions?: Position[];
  assets?: CryptoAsset[];
  onAccountUpdated: (newAccount: FiatAccount, notificationMsg?: string) => void;
  onPositionLiquidated?: (summary: PositionLiquidatedSummary) => void;
  onError?: (message: string) => void;
}

interface RailsStatus {
  paypalReady: boolean;
  paypal: {
    env: 'sandbox' | 'live';
    recipients: { id: number; label: string }[];
    dailyLimitUsd: number;
    withdrawnTodayUsd: number;
    diagnostics?: {
      lastAuthorizationIssue?: {
        debugId?: string;
        actionRequired: string;
      } | null;
    };
  } | null;
  liveTradingEnabled: boolean;
  configuredExchanges: SpotExchange[];
  twoFactorConfigured: boolean;
  twoFactorEnforced: boolean;
}

export const CryptoToCashTab: React.FC<CryptoToCashTabProps> = ({
  fiatAccount,
  transactions,
  positions = [],
  assets = [],
  onAccountUpdated,
  onPositionLiquidated,
  onError,
}) => {
  const [rails, setRails] = useState<RailsStatus | null>(null);
  const [walletHoldings, setWalletHoldings] = useState<ExchangeWalletHolding[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);

  const [selectedPositionId, setSelectedPositionId] = useState<string>('');
  const [exchange, setExchange] = useState<SpotExchange>('KRAKEN');
  const [symbol, setSymbol] = useState<string>(positions[0]?.symbol || assets[0]?.symbol || 'BTC/USDT');
  const [quantity, setQuantity] = useState<string>(positions[0] ? String(positions[0].amount) : '');
  const [recipientId, setRecipientId] = useState<number>(0);
  const [twoFactorCode, setTwoFactorCode] = useState<string>('');

  const [quote, setQuote] = useState<CryptoToCashQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [refreshingPayouts, setRefreshingPayouts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    sellNote: string;
    exchangeOrderId: string;
    payoutTx: FiatTransaction | null;
    netUsd: number;
  } | null>(null);

  // Inline 2FA enrollment if needed
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpConfirmCode, setTotpConfirmCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [verifyingPaypal, setVerifyingPaypal] = useState(false);
  const [paypalAuthDiag, setPaypalAuthDiag] = useState<string | null>(null);

  const keyRef = useRef<string>(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ctc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );

  const fail = useCallback(
    (msg: string) => {
      setError(msg);
      onError?.(msg);
    },
    [onError]
  );

  const loadStatusAndWallets = useCallback(async () => {
    setLoadingWallets(true);
    try {
      const [cfgRes, walRes] = await Promise.all([
        fiatFetch('/api/fiat/config')
          .then((r) => r.json())
          .catch(() => null),
        fiatFetch('/api/exchange/wallets')
          .then((r) => r.json())
          .catch(() => null),
      ]);

      const ctc = cfgRes?.rails?.cryptoToCash;
      setRails({
        paypalReady: Boolean(cfgRes?.rails?.withdrawals && cfgRes?.rails?.paypal),
        paypal: cfgRes?.rails?.paypal ?? null,
        liveTradingEnabled: Boolean(ctc?.liveTradingEnabled),
        configuredExchanges: Array.isArray(ctc?.configuredExchanges) ? ctc.configuredExchanges : [],
        twoFactorConfigured: Boolean(cfgRes?.security?.twoFactorConfigured),
        twoFactorEnforced: cfgRes?.security?.twoFactorEnforced !== false,
      });

      if (Array.isArray(ctc?.configuredExchanges) && ctc.configuredExchanges.length > 0 && !selectedPositionId) {
        setExchange(ctc.configuredExchanges[0]);
      }

      const holdings: ExchangeWalletHolding[] = [];
      if (walRes?.wallets && typeof walRes.wallets === 'object') {
        for (const exItem of SPOT_EXCHANGES) {
          const w = walRes.wallets[exItem.id];
          if (!w || !w.isLinked || !w.balances || typeof w.balances !== 'object') continue;
          for (const [asset, rawBal] of Object.entries(w.balances)) {
            const up = asset.toUpperCase();
            if (STABLE_ASSETS.has(up)) continue;
            const bal = parseFloat(String(rawBal));
            if (Number.isFinite(bal) && bal > 0) {
              holdings.push({
                exchange: exItem.id,
                asset: up,
                symbol: `${up}/USDT`,
                balance: bal,
              });
            }
          }
        }
      }
      setWalletHoldings(holdings);
    } finally {
      setLoadingWallets(false);
    }
  }, [selectedPositionId]);

  useEffect(() => {
    loadStatusAndWallets();
  }, [loadStatusAndWallets]);

  // Select first open position automatically if user opens tab with active positions
  useEffect(() => {
    if (!selectedPositionId && positions.length > 0 && !quantity) {
      const first = positions[0];
      const mappedEx: SpotExchange = SPOT_EXCHANGES.some((e) => e.id === first.exchange)
        ? (first.exchange as SpotExchange)
        : 'KRAKEN';
      setSelectedPositionId(first.id);
      setExchange(mappedEx);
      setSymbol(first.symbol);
      setQuantity(String(first.amount));
    }
  }, [positions, selectedPositionId, quantity]);

  const selectedPosition = useMemo(
    () => positions.find((p) => p.id === selectedPositionId) || null,
    [positions, selectedPositionId]
  );

  // Live server quote whenever exchange / symbol / quantity changes
  const refreshQuote = useCallback(async () => {
    const qtyNum = parseFloat(quantity);
    if (!symbol.trim() || !Number.isFinite(qtyNum) || qtyNum <= 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    setQuoting(true);
    setQuoteError(null);
    try {
      const res = await quoteCryptoToCash({ exchange, symbol: symbol.trim(), quantity: qtyNum });
      setQuote(res.quote);
    } catch (err: any) {
      setQuote(null);
      setQuoteError(err?.message || 'Could not compute live USD quote.');
    } finally {
      setQuoting(false);
    }
  }, [exchange, symbol, quantity]);

  useEffect(() => {
    const timer = setTimeout(() => {
      refreshQuote();
    }, 300);
    return () => clearTimeout(timer);
  }, [refreshQuote]);

  const selectOpenPosition = (pos: Position) => {
    setError(null);
    setNotice(null);
    setSelectedPositionId(pos.id);
    const mappedEx: SpotExchange = SPOT_EXCHANGES.some((e) => e.id === pos.exchange)
      ? (pos.exchange as SpotExchange)
      : 'KRAKEN';
    setExchange(mappedEx);
    setSymbol(pos.symbol);
    setQuantity(String(pos.amount));
  };

  const selectWalletHolding = (h: ExchangeWalletHolding) => {
    setError(null);
    setNotice(null);
    setSelectedPositionId('');
    setExchange(h.exchange);
    setSymbol(h.symbol);
    setQuantity(String(h.balance));
  };

  const applyPercentage = (pct: number) => {
    if (selectedPosition) {
      const amt = Number((selectedPosition.amount * pct).toFixed(6));
      setQuantity(String(amt));
      return;
    }
    const base = symbol.split('/')[0]?.toUpperCase();
    const holding = walletHoldings.find((w) => w.exchange === exchange && w.asset === base);
    if (holding) {
      setQuantity(String(Number((holding.balance * pct).toFixed(6))));
    }
  };

  const startTotpSetup = async () => {
    setError(null);
    setTotpBusy(true);
    try {
      const res = await setupTotp2FA();
      const qrDataUrl = await QRCode.toDataURL(res.otpauthUri, { width: 170, margin: 1 });
      setTotpSetupData({ secret: res.secret, otpauthUri: res.otpauthUri, qrDataUrl });
      setNotice(res.message);
    } catch (e: any) {
      fail(e?.message || 'Could not start 2FA setup.');
    } finally {
      setTotpBusy(false);
    }
  };

  const completeTotpSetup = async () => {
    setError(null);
    if (!/^\d{6}$/.test(totpConfirmCode)) return fail('Enter the 6-digit code shown in your authenticator app.');
    setTotpBusy(true);
    try {
      const res = await confirmTotp2FA(totpConfirmCode);
      setTotpSetupData(null);
      setTotpConfirmCode('');
      setNotice(res.message);
      onAccountUpdated(res.account, res.message);
      await loadStatusAndWallets();
    } catch (e: any) {
      fail(e?.message || '2FA verification failed.');
    } finally {
      setTotpBusy(false);
    }
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setReceipt(null);

    if (!rails?.paypalReady) {
      return fail('PayPal Payouts are not configured on the server.');
    }
    if (!rails.liveTradingEnabled) {
      return fail('Live spot liquidation is disabled on the server (set ENABLE_LIVE_TRADING=1 in .env).');
    }
    const qtyNum = parseFloat(quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return fail('Enter a valid positive crypto quantity to sell.');
    }
    if (selectedPosition && qtyNum > selectedPosition.amount * 1.000001) {
      return fail(`Quantity exceeds open ${selectedPosition.symbol} position (${selectedPosition.amount}).`);
    }
    if (rails.twoFactorEnforced && !/^\d{6}$/.test(twoFactorCode)) {
      return fail('Enter the 6-digit 2FA authenticator code before converting crypto to cash.');
    }

    setSubmitting(true);
    try {
      const res = await executeCryptoToCash({
        exchange,
        symbol: symbol.trim(),
        quantity: qtyNum,
        ...(selectedPosition ? { positionId: selectedPosition.id } : {}),
        recipientId,
        twoFactorCode: twoFactorCode.trim(),
        idempotencyKey: keyRef.current,
      });

      keyRef.current =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `ctc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      if (res.account) {
        onAccountUpdated(res.account, res.message);
      }
      if (res.sellCompleted && selectedPosition && onPositionLiquidated && res.sellResult) {
        onPositionLiquidated({
          positionId: selectedPosition.id,
          orderId: res.sellResult.exchangeOrderId,
          exchange: exchange as ExchangeId,
          exchangeName: SPOT_EXCHANGES.find((x) => x.id === exchange)?.label || exchange,
          symbol: res.sellResult.symbol,
          soldQuantity: qtyNum,
          unitPriceUsd: res.sellResult.unitPriceUsd,
          grossUsd: res.sellResult.grossUsd,
          feeUsd: res.sellResult.exchangeFeeUsd,
          netUsd: res.sellResult.netProceedsUsd,
        });
      }

      setReceipt({
        sellNote: res.sellResult?.note || `Sold ${qtyNum} ${symbol} on ${exchange}`,
        exchangeOrderId: res.sellResult?.exchangeOrderId || res.liquidationTransaction?.externalId || 'CONFIRMED',
        payoutTx: res.payoutTransaction || null,
        netUsd: res.sellResult?.netProceedsUsd ?? quote?.netUsd ?? 0,
      });
      setNotice(res.message);
      setTwoFactorCode('');
      setSelectedPositionId('');
      setQuantity('');
      loadStatusAndWallets();
    } catch (err: any) {
      if (err?.status !== 502 && err?.status !== 504) {
        keyRef.current =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `ctc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
      if (err?.status === 403 || err?.code === 'AUTHORIZATION_ERROR' || err?.paypal?.actionRequired) {
        setPaypalAuthDiag(err?.paypal?.actionRequired || err?.message);
        loadStatusAndWallets();
      }
      fail(err?.message || 'Crypto-to-Cash payout failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyPaypalAuth = async () => {
    setVerifyingPaypal(true);
    setError(null);
    setNotice(null);
    try {
      const res = await verifyPaypalAuth(true);
      setPaypalAuthDiag(res.authorizationWarning || null);
      setNotice(res.message);
      await loadStatusAndWallets();
    } catch (err: any) {
      setPaypalAuthDiag(err?.paypal?.actionRequired || err?.message || null);
      fail(err?.message || 'PayPal authorization verification failed.');
    } finally {
      setVerifyingPaypal(false);
    }
  };

  const handleRefreshPayouts = async () => {
    setRefreshingPayouts(true);
    setError(null);
    try {
      const res = await reconcilePaypalPayouts();
      if (res.account) {
        onAccountUpdated(res.account, 'Refreshed PayPal Crypto-to-Cash payout statuses.');
      }
      setNotice('Updated Crypto-to-Cash PayPal payout statuses.');
    } catch (err: any) {
      fail(err?.message || 'Could not refresh PayPal statuses.');
    } finally {
      setRefreshingPayouts(false);
    }
  };

  const cryptoPayoutHistory = useMemo(
    () =>
      transactions
        .filter((t) => {
          if (t.type === 'WITHDRAW_TO_PAYPAL' && (Boolean(t.cryptoLiquidation) || t.sourceName.startsWith('Crypto-to-Cash'))) {
            return true;
          }
          if (t.type === 'CRYPTO_LIQUIDATION') {
            const batchHash = t.referenceHash.replace(/-sell$/, '');
            return !transactions.some((p) => p.type === 'WITHDRAW_TO_PAYPAL' && p.referenceHash === batchHash);
          }
          return false;
        })
        .slice(0, 12),
    [transactions]
  );

  const assetSymbols = useMemo(() => {
    const set = new Set<string>(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'AVAX/USDT']);
    for (const a of assets) set.add(a.symbol);
    for (const p of positions) set.add(p.symbol);
    for (const h of walletHoldings) set.add(h.symbol);
    return Array.from(set);
  }, [assets, positions, walletHoldings]);

  const remainingDaily = rails?.paypal ? Math.max(0, rails.paypal.dailyLimitUsd - rails.paypal.withdrawnTodayUsd) : 0;
  const needsTotpEnrollment = Boolean(rails && rails.twoFactorEnforced && !rails.twoFactorConfigured);
  const currentExchangeConfigured = rails?.configuredExchanges.includes(exchange) ?? false;

  return (
    <div className="max-w-4xl mx-auto space-y-5 animate-in fade-in duration-200">
      {/* Live Rail Readiness Banner */}
      <div className="p-5 rounded-2xl bg-slate-950/80 border border-emerald-500/30 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 shrink-0">
              <Coins className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold text-white">Crypto-to-Cash Instant PayPal Payout</h3>
                {rails?.paypalReady && rails.paypal && (
                  <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    PayPal {rails.paypal.env.toUpperCase()}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Liquidates a live spot crypto position via your authenticated exchange API at current market price and immediately dispatches net USD proceeds via PayPal Payouts.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={loadStatusAndWallets}
            disabled={loadingWallets}
            className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-cyan-300 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingWallets ? 'animate-spin' : ''}`} />
            <span>Sync Wallets</span>
          </button>
        </div>

        {/* Honest Pre-flight Readiness Indicators */}
        {rails && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-[11px] font-mono pt-1">
            <div className={`px-3 py-2 rounded-xl border ${rails.paypalReady ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200' : 'bg-amber-950/30 border-amber-500/40 text-amber-200'}`}>
              <div className="font-bold">1. PayPal Payouts</div>
              <div className="text-[10px] opacity-85 mt-0.5">
                {rails.paypalReady && rails.paypal
                  ? `Ready (${rails.paypal.recipients[0]?.label || 'registered'}) · $${remainingDaily.toFixed(2)} left today`
                  : 'PayPal credentials / recipient required'}
              </div>
            </div>

            <div className={`px-3 py-2 rounded-xl border ${currentExchangeConfigured ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200' : 'bg-amber-950/30 border-amber-500/40 text-amber-200'}`}>
              <div className="font-bold">2. Spot Exchange ({exchange})</div>
              <div className="text-[10px] opacity-85 mt-0.5">
                {currentExchangeConfigured
                  ? 'API credentials loaded on server'
                  : 'Link exchange API keys in Exchange Wallets'}
              </div>
            </div>

            <div className={`px-3 py-2 rounded-xl border ${rails.liveTradingEnabled ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200' : 'bg-amber-950/30 border-amber-500/40 text-amber-200'}`}>
              <div className="font-bold">3. Live Execution Gate</div>
              <div className="text-[10px] opacity-85 mt-0.5">
                {rails.liveTradingEnabled
                  ? 'ENABLE_LIVE_TRADING=1 Active'
                  : 'Set ENABLE_LIVE_TRADING=1 in .env'}
              </div>
            </div>
          </div>
        )}

        {rails && (!rails.liveTradingEnabled || rails.configuredExchanges.length === 0) && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Live Crypto-to-Cash never fabricates spot fills. To execute a real liquidation + PayPal payout, ensure{' '}
              {!rails.liveTradingEnabled && <code className="text-amber-100 font-mono">ENABLE_LIVE_TRADING=1</code>}
              {!rails.liveTradingEnabled && rails.configuredExchanges.length === 0 && ' is enabled and '}
              {rails.configuredExchanges.length === 0 && 'an exchange API key (Kraken, Coinbase, Binance, NonKYC, or OKX) is linked'}.
            </span>
          </div>
        )}

        {(paypalAuthDiag || rails?.paypal?.diagnostics?.lastAuthorizationIssue) && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/50 text-xs text-amber-200 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-amber-100 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                PayPal Payouts Authorization Diagnostic
              </span>
              <button
                type="button"
                onClick={handleVerifyPaypalAuth}
                disabled={verifyingPaypal}
                className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-100 font-bold text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${verifyingPaypal ? 'animate-spin' : ''}`} />
                <span>{verifyingPaypal ? 'Checking...' : 'Refresh PayPal Auth'}</span>
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-100/90">
              {paypalAuthDiag || rails?.paypal?.diagnostics?.lastAuthorizationIssue?.actionRequired}
            </p>
          </div>
        )}
      </div>

      {/* Inline 2FA Enrollment if needed */}
      {needsTotpEnrollment && (
        <div className="p-4 bg-cyan-950/25 border border-cyan-500/40 rounded-2xl space-y-3">
          <div className="flex items-start gap-2.5">
            <KeyRound className="h-5 w-5 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-bold text-white">Enroll 2FA Authenticator to Authorize Crypto-to-Cash Payouts</div>
              <p className="text-xs text-slate-300 mt-0.5">
                PayPal withdrawals verify a single-use 6-digit authenticator code on every payout.
              </p>
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
              <img src={totpSetupData.qrDataUrl} alt="2FA QR Code" className="w-36 h-36 rounded-lg bg-white p-1.5 mx-auto sm:mx-0" />
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
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
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
          )}
        </div>
      )}

      {/* Open Spot Positions & Connected Exchange Wallet Holdings */}
      {(positions.length > 0 || walletHoldings.length > 0) && (
        <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <Wallet className="h-4 w-4 text-cyan-400" />
              <span>Select Spot Crypto Position to Convert</span>
            </h4>
            {selectedPositionId && (
              <button
                type="button"
                onClick={() => setSelectedPositionId('')}
                className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
              >
                Switch to Custom Spot Order
              </button>
            )}
          </div>

          {positions.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {positions.map((pos) => {
                const active = selectedPositionId === pos.id;
                return (
                  <button
                    key={pos.id}
                    type="button"
                    onClick={() => selectOpenPosition(pos)}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      active
                        ? 'bg-emerald-500/15 border-emerald-500/70 ring-1 ring-emerald-500/40'
                        : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white">{pos.symbol}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-300">{pos.exchange}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-300 mt-1.5">
                      <span>{pos.amount} units</span>
                      <span className="font-bold text-emerald-300">{formatCurrency(pos.amount * pos.currentPrice)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {walletHoldings.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] font-mono uppercase text-slate-400">Connected Exchange Spot Balances</div>
              <div className="flex flex-wrap gap-2">
                {walletHoldings.map((h) => (
                  <button
                    key={`${h.exchange}-${h.asset}`}
                    type="button"
                    onClick={() => selectWalletHolding(h)}
                    className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-mono text-white flex items-center gap-2 cursor-pointer"
                  >
                    <span className="text-cyan-300 font-bold">{h.balance} {h.asset}</span>
                    <span className="text-[10px] text-slate-400">on {h.exchange}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-xs text-rose-200 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-rose-300 hover:text-white cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-xs text-emerald-200 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>{notice}</span>
          </span>
          <button type="button" onClick={() => setNotice(null)} className="text-emerald-300 hover:text-white cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {receipt && (
        <div className="p-4 rounded-2xl bg-emerald-950/35 border border-emerald-500/50 space-y-2 text-xs font-mono">
          <div className="font-bold text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            <span>Crypto-to-Cash Settlement Submitted</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-slate-200 pt-1">
            <div>Spot Fill: <span className="text-white font-bold">{receipt.sellNote}</span></div>
            <div>Exchange Ref: <span className="text-cyan-300">{receipt.exchangeOrderId}</span></div>
            <div>Net PayPal Payout: <span className="text-emerald-300 font-bold">{formatCurrency(receipt.netUsd)}</span></div>
          </div>
          {receipt.payoutTx?.externalId && (
            <div className="text-[11px] text-slate-400">PayPal Payout Batch: {receipt.payoutTx.externalId} ({receipt.payoutTx.status})</div>
          )}
        </div>
      )}

      {/* Conversion & PayPal Payout Form */}
      <form onSubmit={handleExecute} className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Exchange</label>
            <select
              value={exchange}
              onChange={(e) => {
                setSelectedPositionId('');
                setExchange(e.target.value as SpotExchange);
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
            >
              {SPOT_EXCHANGES.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.label} {rails?.configuredExchanges.includes(ex.id) ? '(Connected)' : '(Keys Needed)'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Spot Asset Pair</label>
            <select
              value={symbol}
              onChange={(e) => {
                setSelectedPositionId('');
                setSymbol(e.target.value);
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-emerald-500"
            >
              {assetSymbols.map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-300">Quantity to Sell</label>
              {(selectedPosition || walletHoldings.some((h) => h.exchange === exchange && `${h.asset}/USDT` === symbol)) && (
                <div className="flex gap-1">
                  {[0.25, 0.5, 1].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => applyPercentage(pct)}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 cursor-pointer"
                    >
                      {pct === 1 ? 'MAX' : `${pct * 100}%`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              type="number"
              min="0.000001"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.01"
              className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2.5 rounded-xl font-mono text-sm font-bold focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        {/* Live USD Quote Preview */}
        <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-300">Live Conversion Estimate</span>
            <button
              type="button"
              onClick={refreshQuote}
              disabled={quoting}
              className="text-[11px] text-cyan-300 hover:text-cyan-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className={`h-3 w-3 ${quoting ? 'animate-spin' : ''}`} />
              <span>Refresh Price</span>
            </button>
          </div>

          {quoteError && <div className="text-amber-300 text-[11px]">{quoteError}</div>}

          {quote ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 font-mono">
              <div>
                <div className="text-[10px] text-slate-400">Live Spot Price</div>
                <div className="text-white font-bold">{formatCurrency(quote.unitPriceUsd)}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Gross Sale</div>
                <div className="text-white font-bold">{formatCurrency(quote.grossUsd)}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Est. Taker Fee ({(quote.feeRate * 100).toFixed(2)}%)</div>
                <div className="text-amber-300 font-bold">-{formatCurrency(quote.estimatedFeeUsd)}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Net PayPal Payout</div>
                <div className="text-emerald-400 font-black">{formatCurrency(quote.netUsd)}</div>
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-slate-500">Enter a spot quantity to fetch live market pricing and estimated PayPal payout.</div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">PayPal Payout Recipient</label>
            {rails?.paypal && rails.paypal.recipients.length > 0 ? (
              <select
                value={recipientId}
                onChange={(e) => setRecipientId(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              >
                {rails.paypal.recipients.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="px-3 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-amber-300">
                No PayPal recipient configured
              </div>
            )}
          </div>

          {rails?.twoFactorEnforced !== false && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-cyan-400" />
                <span>6-Digit 2FA Code (Required)</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2.5 rounded-xl font-mono text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={
            submitting ||
            needsTotpEnrollment ||
            !rails?.paypalReady ||
            !rails?.liveTradingEnabled ||
            !currentExchangeConfigured ||
            !(parseFloat(quantity) > 0)
          }
          className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-all"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Selling Crypto &amp; Sending PayPal Payout...</span>
            </>
          ) : (
            <>
              <Coins className="h-4 w-4" />
              <span>
                Sell {quantity || '0'} {symbol.split('/')[0]} <ArrowRight className="inline h-3.5 w-3.5 mx-0.5" /> PayPal{' '}
                {quote ? `(${formatCurrency(quote.netUsd)})` : ''}
              </span>
            </>
          )}
        </button>
      </form>

      {/* Crypto-to-Cash History */}
      <div className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Recent Crypto-to-Cash Payouts ({cryptoPayoutHistory.length})
          </h4>
          {rails?.paypalReady && (
            <button
              type="button"
              onClick={handleRefreshPayouts}
              disabled={refreshingPayouts}
              className="text-xs text-cyan-300 hover:text-cyan-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingPayouts ? 'animate-spin' : ''}`} />
              <span>Refresh PayPal Status</span>
            </button>
          )}
        </div>

        {cryptoPayoutHistory.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-500">No Crypto-to-Cash conversions executed yet.</div>
        ) : (
          <div className="space-y-2">
            {cryptoPayoutHistory.map((tx) => (
              <div
                key={tx.id}
                className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div>
                  <div className="font-bold text-white">{tx.sourceName}</div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {new Date(tx.timestamp).toLocaleString()} → {tx.destinationName}
                    {tx.externalId ? ` · Ref: ${tx.externalId}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 font-mono">
                  <span className="font-bold text-emerald-300">{formatCurrency(tx.netAmount ?? tx.amount)}</span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      tx.status === 'COMPLETED'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : tx.status === 'FAILED'
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                          : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    }`}
                  >
                    {tx.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
