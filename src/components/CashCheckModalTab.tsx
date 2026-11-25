import React, { useCallback, useEffect, useState } from 'react';
import {
  FileCheck,
  AlertTriangle,
  CreditCard,
  Landmark,
  Upload,
  CheckCircle2,
  RefreshCw,
  Loader2,
  Zap,
  Clock,
  ShieldCheck,
  X,
  Camera,
} from 'lucide-react';
import { CheckDepositRecord, FiatAccount } from '../types';
import {
  fiatFetch,
  fetchCheckDeposits,
  reconcileCheckDeposits,
  submitCheckDeposit,
} from '../services/fiatApi';
import { formatCurrency } from '../utils/cryptoMath';

interface CashCheckModalTabProps {
  fiatAccount: FiatAccount;
  onAccountUpdated: (newAccount: FiatAccount, notificationMsg?: string) => void;
  onBotCashAdjusted?: (amountDelta: number) => void;
  botCash: number;
  onSwitchToDeposit?: (method: 'CARD' | 'BANK') => void;
}

const MAX_RAW_FILE_BYTES = 20 * 1024 * 1024;
const TARGET_MAX_DATA_URL_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION_PX = 1600;
const DIRECT_ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Failed to read check image file.'));
    };
    reader.onerror = () => reject(new Error('Failed to read check image file.'));
    reader.readAsDataURL(file);
  });
}

function estimateBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

async function prepareCheckImage(file: File): Promise<{ dataUrl: string; byteSize: number }> {
  const mime = (file.type || '').toLowerCase();
  const isImage = mime.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(file.name);
  if (!isImage) {
    throw new Error('Check image must be a JPEG, PNG, or WebP photo.');
  }
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error('Selected image exceeds the 20 MB maximum file size.');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const rawBytes = estimateBase64Bytes(rawDataUrl);

  // Convert/downscale large or non-JPEG images via canvas into crisp JPEG for Check 21 compatibility
  const needsCanvasNormalize =
    rawBytes > TARGET_MAX_DATA_URL_BYTES ||
    (mime !== 'image/jpeg' && mime !== 'image/jpg') ||
    !DIRECT_ALLOWED_MIME.has(mime);

  if (needsCanvasNormalize && typeof document !== 'undefined') {
    try {
      const optimized = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const longest = Math.max(img.width || 1, img.height || 1);
          const scale = longest > MAX_DIMENSION_PX ? MAX_DIMENSION_PX / longest : 1;
          const width = Math.max(1, Math.round((img.width || 1) * scale));
          const height = Math.max(1, Math.round((img.height || 1) * scale));

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas unavailable'));
            return;
          }
          // White backdrop avoids black background when converting transparent PNGs to JPEG
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        };
        img.onerror = () => reject(new Error('Image decode failed'));
        img.src = rawDataUrl;
      });
      return { dataUrl: optimized, byteSize: estimateBase64Bytes(optimized) };
    } catch {
      // Fallback to raw dataUrl if it's already a supported MIME and within 8 MB
      if (DIRECT_ALLOWED_MIME.has(mime) && rawBytes <= 8 * 1024 * 1024) {
        return { dataUrl: rawDataUrl, byteSize: rawBytes };
      }
      throw new Error('Could not process check image. Please upload a standard JPEG or PNG photo.');
    }
  }

  if (rawBytes > 8 * 1024 * 1024) {
    throw new Error('Check image exceeds the 8 MB upload limit.');
  }

  return { dataUrl: rawDataUrl, byteSize: rawBytes };
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const CashCheckModalTab: React.FC<CashCheckModalTabProps> = ({
  fiatAccount,
  onAccountUpdated,
  onBotCashAdjusted,
  onSwitchToDeposit,
}) => {
  const [checkEnabled, setCheckEnabled] = useState<boolean | null>(null);
  const [increaseEnv, setIncreaseEnv] = useState<'sandbox' | 'production' | null>(null);
  const [increaseEnvNotice, setIncreaseEnvNotice] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckDepositRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(true);
  const [reconciling, setReconciling] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [processingSide, setProcessingSide] = useState<'front' | 'back' | null>(null);
  const [dragSide, setDragSide] = useState<'front' | 'back' | null>(null);

  const [amount, setAmount] = useState<string>('');
  const [checkNumber, setCheckNumber] = useState<string>('');
  const [payerName, setPayerName] = useState<string>('');
  const [issuingBank, setIssuingBank] = useState<string>('');
  const [destination, setDestination] = useState<'TREASURY_VAULT' | 'BOT_MARGIN'>('TREASURY_VAULT');
  const [frontImage, setFrontImage] = useState<string>('');
  const [frontMeta, setFrontMeta] = useState<string>('');
  const [backImage, setBackImage] = useState<string>('');
  const [backMeta, setBackMeta] = useState<string>('');
  const [endorsementConfirmed, setEndorsementConfirmed] = useState<boolean>(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadConfigAndHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const [cfgRes, list] = await Promise.all([
        fiatFetch('/api/fiat/config')
          .then((r) => r.json())
          .catch(() => null),
        fetchCheckDeposits(),
      ]);
      setCheckEnabled(Boolean(cfgRes?.rails?.check));
      setIncreaseEnv(cfgRes?.rails?.increase?.env ?? null);
      setIncreaseEnvNotice(cfgRes?.rails?.increase?.envNotice ?? null);
      setChecks(list);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadConfigAndHistory();
  }, [loadConfigAndHistory]);

  const applySelectedFile = async (side: 'front' | 'back', file: File) => {
    setError(null);
    setProcessingSide(side);
    try {
      const { dataUrl, byteSize } = await prepareCheckImage(file);
      const label = `${file.name} (${formatKb(byteSize)})`;
      if (side === 'front') {
        setFrontImage(dataUrl);
        setFrontMeta(label);
      } else {
        setBackImage(dataUrl);
        setBackMeta(label);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not process check image.');
    } finally {
      setProcessingSide(null);
    }
  };

  const handleImagePick = async (side: 'front' | 'back', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await applySelectedFile(side, file);
  };

  const handleDrop = async (side: 'front' | 'back', e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragSide(null);
    if (!checkEnabled || submitting) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await applySelectedFile(side, file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!checkEnabled) {
      setError('Increase Check 21 credentials are not active on the server yet.');
      return;
    }

    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount < 1 || numAmount > 25000) {
      setError('Enter a valid check amount between $1.00 and $25,000.00 USD.');
      return;
    }
    const cleanNum = checkNumber.trim();
    if (!/^[A-Za-z0-9-]{1,32}$/.test(cleanNum)) {
      setError('Enter a valid check number (1–32 letters, numbers, or hyphens).');
      return;
    }
    if (payerName.trim().length < 2) {
      setError('Enter the payer / drawer name printed on the check.');
      return;
    }
    if (!frontImage || !backImage) {
      setError('Upload clear photos of both the front and endorsed back of the check.');
      return;
    }
    if (!endorsementConfirmed) {
      setError("Sign the back and write 'For Mobile Deposit Only', then confirm the endorsement box.");
      return;
    }

    setSubmitting(true);
    try {
      const prevBotAlloc = fiatAccount.allocatedToTrading || 0;
      const res = await submitCheckDeposit({
        amount: numAmount,
        checkNumber: cleanNum,
        payerName: payerName.trim(),
        issuingBank: issuingBank.trim() || undefined,
        endorsementConfirmed,
        destination,
        frontImage,
        backImage,
        idempotencyKey:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `chk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });

      onAccountUpdated(res.account, res.message);
      const deltaBot = (res.account?.allocatedToTrading || 0) - prevBotAlloc;
      if (deltaBot > 0 && onBotCashAdjusted) {
        onBotCashAdjusted(deltaBot);
      }

      setChecks((prev) => [res.check, ...prev.filter((c) => c.id !== res.check.id)]);
      setNotice(res.message);
      setAmount('');
      setCheckNumber('');
      setPayerName('');
      setIssuingBank('');
      setFrontImage('');
      setFrontMeta('');
      setBackImage('');
      setBackMeta('');
      setEndorsementConfirmed(false);
    } catch (err: any) {
      setError(err?.message || 'Check deposit submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReconcile = async () => {
    setError(null);
    setNotice(null);
    setReconciling(true);
    try {
      const prevBotAlloc = fiatAccount.allocatedToTrading || 0;
      const res = await reconcileCheckDeposits();
      setChecks(res.checks || []);
      onAccountUpdated(res.account, 'Check clearing statuses refreshed from Increase.');
      const deltaBot = (res.account?.allocatedToTrading || 0) - prevBotAlloc;
      if (deltaBot !== 0 && onBotCashAdjusted) {
        onBotCashAdjusted(deltaBot);
      }
      setNotice('Refreshed live Check 21 clearing statuses from Increase.');
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh check clearing status.');
    } finally {
      setReconciling(false);
    }
  };

  const dailyRemaining = Math.max(0, fiatAccount.dailyDepositLimit - fiatAccount.dailyDepositUsed);
  const canInteract = checkEnabled === true && !submitting;

  return (
    <div className="max-w-4xl mx-auto space-y-5 animate-in fade-in duration-200">
      {/* Processor Status Banner */}
      <div
        className={`p-5 rounded-2xl border shadow-xl space-y-3 ${
          checkEnabled === true
            ? 'bg-emerald-950/30 border-emerald-500/40'
            : checkEnabled === false
              ? 'bg-slate-900/90 border-amber-500/40'
              : 'bg-slate-900/90 border-slate-700/60'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`p-2.5 rounded-xl border shrink-0 ${
                checkEnabled === true
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                  : checkEnabled === false
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                    : 'bg-slate-800 border-slate-700 text-cyan-400'
              }`}
            >
              {checkEnabled === null ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileCheck className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold text-white">Remote Check Deposit (Check 21 RDC)</h3>
                {checkEnabled === true ? (
                  <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    Increase {increaseEnv?.toUpperCase() || 'ACTIVE'}
                  </span>
                ) : checkEnabled === false ? (
                  <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    Processor Keys Required
                  </span>
                ) : (
                  <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                    Checking Gateway...
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                {checkEnabled === true
                  ? 'Capture or upload front and endorsed back check photos to submit directly via Increase Check 21 clearing. Funds are held in Pending Clearing until Increase confirms settlement.'
                  : checkEnabled === false
                    ? 'Simulated/fake check credits remain disabled (live currency only). Configure Increase credentials in server .env to enable Remote Check Deposit.'
                    : 'Verifying Increase Check 21 gateway configuration...'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {checkEnabled === false && (
              <button
                type="button"
                onClick={loadConfigAndHistory}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-bold text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Re-check Gateway</span>
              </button>
            )}
            {onSwitchToDeposit && checkEnabled === false && (
              <>
                <button
                  type="button"
                  onClick={() => onSwitchToDeposit('CARD')}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  <span>Card (Stripe)</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSwitchToDeposit('BANK')}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Landmark className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Bank (Plaid ACH)</span>
                </button>
              </>
            )}
          </div>
        </div>

        {checkEnabled === true && increaseEnvNotice && (
          <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-500/40 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <span>{increaseEnvNotice}</span>
          </div>
        )}

        {checkEnabled === false && (
          <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2 text-xs text-slate-300">
            <div className="flex items-center gap-2 font-semibold text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Required `.env` variables for live check cashing:</span>
            </div>
            <pre className="text-[11px] font-mono bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-cyan-300 overflow-x-auto">
{`INCREASE_API_KEY=...
INCREASE_ACCOUNT_ID=...
INCREASE_ENV=sandbox   # or production`}
            </pre>
          </div>
        )}
      </div>

      {/* Live Check Balance Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
        <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800">
          <div className="text-[10px] uppercase tracking-wider text-slate-400">Available Settled USD</div>
          <div className="text-lg font-black text-emerald-400 mt-0.5">{formatCurrency(fiatAccount.availableBalance)}</div>
        </div>
        <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800">
          <div className="text-[10px] uppercase tracking-wider text-slate-400">Pending Check Clearing</div>
          <div className={`text-lg font-black mt-0.5 ${fiatAccount.pendingBalance > 0 ? 'text-amber-300' : 'text-slate-300'}`}>
            {formatCurrency(fiatAccount.pendingBalance)}
          </div>
        </div>
        <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800">
          <div className="text-[10px] uppercase tracking-wider text-slate-400">Daily Deposit Remaining</div>
          <div className="text-lg font-black text-cyan-300 mt-0.5">{formatCurrency(dailyRemaining)}</div>
        </div>
      </div>

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

      {/* Check Deposit Capture Form */}
      <form onSubmit={handleSubmit} className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <h4 className="text-sm font-bold text-white">Submit Check Images</h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Photos are automatically optimized to Check 21 JPEG format before upload.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="h-4 w-4 text-cyan-400" />
            <span>Check 21 Verified</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Check Amount (USD)</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-slate-400 font-mono text-sm">$</span>
              <input
                type="number"
                min="1"
                max="25000"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={!canInteract}
                className="w-full bg-slate-900 border border-slate-700 text-white pl-8 pr-4 py-2 rounded-xl font-mono text-sm font-bold focus:outline-none focus:border-cyan-500 disabled:opacity-50"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Check Number</label>
            <input
              type="text"
              maxLength={32}
              value={checkNumber}
              onChange={(e) => setCheckNumber(e.target.value)}
              placeholder="e.g. 1042"
              disabled={!canInteract}
              className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2 rounded-xl font-mono text-sm focus:outline-none focus:border-cyan-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Payer / Drawer Name</label>
            <input
              type="text"
              maxLength={120}
              value={payerName}
              onChange={(e) => setPayerName(e.target.value)}
              placeholder="Name printed on check"
              disabled={!canInteract}
              className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-cyan-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Issuing Bank (Optional)</label>
            <input
              type="text"
              maxLength={120}
              value={issuingBank}
              onChange={(e) => setIssuingBank(e.target.value)}
              placeholder="e.g. Chase, Bank of America"
              disabled={!canInteract}
              className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-cyan-500 disabled:opacity-50"
            />
          </div>
        </div>

        {/* Settlement Destination */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            disabled={!canInteract}
            onClick={() => setDestination('TREASURY_VAULT')}
            className={`p-3 rounded-xl border text-left transition-all cursor-pointer disabled:opacity-50 ${
              destination === 'TREASURY_VAULT'
                ? 'bg-cyan-500/15 border-cyan-500/60 text-white'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-bold">
              <Landmark className="h-4 w-4 text-cyan-400" />
              <span>Settle to Live USD Ledger</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">Available for withdrawals or later bot transfers</div>
          </button>

          <button
            type="button"
            disabled={!canInteract}
            onClick={() => setDestination('BOT_MARGIN')}
            className={`p-3 rounded-xl border text-left transition-all cursor-pointer disabled:opacity-50 ${
              destination === 'BOT_MARGIN'
                ? 'bg-emerald-500/15 border-emerald-500/60 text-white'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-bold">
              <Zap className="h-4 w-4 text-emerald-400" />
              <span>Settle to Bot Trading Cash</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">Credits Bot Active Margin once clearing completes</div>
          </button>
        </div>

        {/* Front / Back Image Uploads with Drag & Drop */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5 text-cyan-400" />
                <span>Front of Check</span>
              </span>
              {frontImage && (
                <button
                  type="button"
                  onClick={() => {
                    setFrontImage('');
                    setFrontMeta('');
                  }}
                  className="text-[11px] text-rose-400 hover:text-rose-300 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                if (canInteract) setDragSide('front');
              }}
              onDragLeave={() => setDragSide(null)}
              onDrop={(e) => handleDrop('front', e)}
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-4 text-center transition-colors min-h-[140px] ${
                !canInteract
                  ? 'border-slate-800 opacity-50 cursor-not-allowed'
                  : dragSide === 'front'
                    ? 'border-cyan-400 bg-cyan-500/10 cursor-pointer'
                    : frontImage
                      ? 'border-emerald-500/50 bg-emerald-950/15 cursor-pointer'
                      : 'border-slate-700 hover:border-cyan-500/60 cursor-pointer'
              }`}
            >
              {processingSide === 'front' ? (
                <Loader2 className="h-6 w-6 text-cyan-400 animate-spin mb-1.5" />
              ) : frontImage ? (
                <img src={frontImage} alt="Front of check" className="max-h-28 rounded-lg object-contain mb-1.5" />
              ) : (
                <Upload className="h-5 w-5 text-slate-400 mb-1.5" />
              )}
              <span className="text-[11px] text-slate-300 font-medium break-all">
                {processingSide === 'front' ? 'Optimizing image...' : frontMeta || 'Click, drop, or take front check photo'}
              </span>
              <span className="text-[10px] text-slate-500 mt-0.5">JPEG, PNG, WebP · Auto-sized for Check 21</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                capture="environment"
                disabled={!canInteract}
                onChange={(e) => handleImagePick('front', e)}
                className="hidden"
              />
            </label>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5 text-emerald-400" />
                <span>Back of Check (Endorsed)</span>
              </span>
              {backImage && (
                <button
                  type="button"
                  onClick={() => {
                    setBackImage('');
                    setBackMeta('');
                  }}
                  className="text-[11px] text-rose-400 hover:text-rose-300 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                if (canInteract) setDragSide('back');
              }}
              onDragLeave={() => setDragSide(null)}
              onDrop={(e) => handleDrop('back', e)}
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-4 text-center transition-colors min-h-[140px] ${
                !canInteract
                  ? 'border-slate-800 opacity-50 cursor-not-allowed'
                  : dragSide === 'back'
                    ? 'border-cyan-400 bg-cyan-500/10 cursor-pointer'
                    : backImage
                      ? 'border-emerald-500/50 bg-emerald-950/15 cursor-pointer'
                      : 'border-slate-700 hover:border-cyan-500/60 cursor-pointer'
              }`}
            >
              {processingSide === 'back' ? (
                <Loader2 className="h-6 w-6 text-cyan-400 animate-spin mb-1.5" />
              ) : backImage ? (
                <img src={backImage} alt="Back of check" className="max-h-28 rounded-lg object-contain mb-1.5" />
              ) : (
                <Upload className="h-5 w-5 text-slate-400 mb-1.5" />
              )}
              <span className="text-[11px] text-slate-300 font-medium break-all">
                {processingSide === 'back' ? 'Optimizing image...' : backMeta || 'Click, drop, or take endorsed back photo'}
              </span>
              <span className="text-[10px] text-slate-500 mt-0.5">Sign + write &quot;For Mobile Deposit Only&quot;</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                capture="environment"
                disabled={!canInteract}
                onChange={(e) => handleImagePick('back', e)}
                className="hidden"
              />
            </label>
          </div>
        </div>

        <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={endorsementConfirmed}
            disabled={!canInteract}
            onChange={(e) => setEndorsementConfirmed(e.target.checked)}
            className="mt-0.5 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500"
          />
          <span>
            I confirm this check is payable to the account holder, endorsed on the back with{' '}
            <strong>&quot;For Mobile Deposit Only&quot;</strong>, and has not been deposited elsewhere.
          </span>
        </label>

        <button
          type="submit"
          disabled={!canInteract}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-all"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Uploading &amp; Submitting to Increase...</span>
            </>
          ) : checkEnabled ? (
            <>
              <FileCheck className="h-4 w-4" />
              <span>Submit Check for Live Clearing</span>
            </>
          ) : checkEnabled === null ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking Increase Gateway...</span>
            </>
          ) : (
            <span>Configure Increase API Keys in .env to Enable Submission</span>
          )}
        </button>
      </form>

      {/* Check Deposit History */}
      <div className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <Clock className="h-4 w-4 text-cyan-400" />
            <span>Submitted Checks ({checks.length})</span>
          </h4>
          {checkEnabled && (
            <button
              type="button"
              onClick={handleReconcile}
              disabled={reconciling}
              className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-cyan-300 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reconciling ? 'animate-spin' : ''}`} />
              <span>{reconciling ? 'Checking...' : 'Refresh Clearing Status'}</span>
            </button>
          )}
        </div>

        {loadingHistory ? (
          <div className="py-6 text-center text-xs text-slate-500">Loading check history...</div>
        ) : checks.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">No checks submitted yet.</div>
        ) : (
          <div className="space-y-2">
            {checks.map((chk) => (
              <div
                key={chk.id}
                className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs"
              >
                <div>
                  <div className="font-bold text-white flex items-center gap-2">
                    <span>Check #{chk.checkNumber}</span>
                    <span className="text-slate-400 font-normal">from {chk.payerName}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {new Date(chk.submittedAt).toLocaleString()} · {chk.destination === 'BOT_MARGIN' ? 'Bot Margin' : 'USD Ledger'}
                    {chk.issuingBank ? ` · ${chk.issuingBank}` : ''}
                    {chk.externalId ? ` · Ref: ${chk.externalId}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono font-bold text-white">{formatCurrency(chk.amount)}</span>
                  <span
                    className={`text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full border ${
                      chk.status === 'CLEARED_INSTANT'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : chk.status === 'REJECTED'
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                          : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    }`}
                  >
                    {chk.status === 'CLEARED_INSTANT'
                      ? 'CLEARED'
                      : chk.status === 'PENDING_CLEARING'
                        ? 'PENDING CLEARING'
                        : chk.status}
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
