import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Fuel,
  Loader2,
  Play,
  Search,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import {
  confirmContractRescueTx,
  executeContractRescueAgent,
  scanContractRescueAgent,
  type ContractRescueScanResult,
} from '../services/exchangeApi';
import { formatCurrency } from '../utils/cryptoMath';

interface ContractRescueAgentPanelProps {
  chain: string;
  activeContractAddress?: string;
  defaultProfitWallet?: string;
  privateKey?: string;
  passphrase?: string;
  onRecoveryComplete?: () => void;
}

export const ContractRescueAgentPanel: React.FC<ContractRescueAgentPanelProps> = ({
  chain,
  activeContractAddress = '',
  defaultProfitWallet = '',
  privateKey = '',
  passphrase = '',
  onRecoveryComplete,
}) => {
  const [contractInput, setContractInput] = useState<string>(activeContractAddress);
  const [destinationInput, setDestinationInput] = useState<string>(defaultProfitWallet);
  const [extraTokensInput, setExtraTokensInput] = useState<string>('');
  const [customAbiInput, setCustomAbiInput] = useState<string>('');
  const [showAbiBox, setShowAbiBox] = useState<boolean>(false);

  const [scanning, setScanning] = useState<boolean>(false);
  const [executing, setExecuting] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<ContractRescueScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [executedTxs, setExecutedTxs] = useState<
    Array<{
      tokenSymbol: string;
      amountFormatted: string;
      functionSignature: string;
      txHash: string;
      explorerUrl: string;
    }>
  >([]);

  useEffect(() => {
    if (activeContractAddress && /^0x[a-fA-F0-9]{40}$/.test(activeContractAddress)) {
      setContractInput(activeContractAddress);
    }
  }, [activeContractAddress, chain]);

  useEffect(() => {
    if (defaultProfitWallet && /^0x[a-fA-F0-9]{40}$/.test(defaultProfitWallet)) {
      setDestinationInput((prev) => prev || defaultProfitWallet);
    }
  }, [defaultProfitWallet]);

  const parseExtraTokens = () =>
    extraTokensInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s));

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await scanContractRescueAgent({
        chain,
        ...(contractInput.trim() ? { contractAddress: contractInput.trim() } : {}),
        ...(destinationInput.trim() ? { destinationWallet: destinationInput.trim() } : {}),
        ...(customAbiInput.trim() ? { abi: customAbiInput.trim() } : {}),
        ...(parseExtraTokens().length > 0 ? { extraTokens: parseExtraTokens() } : {}),
        skipGasNegativeDust: true,
      });
      setScanResult(result);
      if (result.destinationWallet) {
        setDestinationInput(result.destinationWallet);
      }
      if (result.detectedFunctions.length === 0) {
        setNotice(`Scanned ${result.contractAddress} on ${result.chainName}: no rescue/sweep ABI function detected.`);
      } else if (result.plan.executableSteps.length === 0) {
        setNotice(
          result.trappedAssets.length === 0
            ? `Owner ${result.contractOwner || 'none'} & ${result.detectedFunctions.length} rescue/sweep function(s) verified. Contract currently holds 0 trapped tokens on ${result.chainName}.`
            : `Scanned ${result.detectedFunctions.length} rescue/sweep function(s); check skipped items below.`
        );
      } else {
        setNotice(
          `Ready: ${result.plan.executableSteps.length} gas-optimized recovery tx(s) prepared -> FLASH_ARB_PROFIT_WALLET (${result.destinationWallet.slice(0, 6)}...${result.destinationWallet.slice(-4)}).`
        );
      }
    } catch (err: any) {
      setError(err?.message || 'Contract rescue scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const handleExecuteRecovery = async () => {
    setExecuting(true);
    setError(null);
    setNotice(null);
    setExecutedTxs([]);

    try {
      const res = await executeContractRescueAgent({
        chain,
        ...(contractInput.trim() ? { contractAddress: contractInput.trim() } : {}),
        ...(destinationInput.trim() ? { destinationWallet: destinationInput.trim() } : {}),
        ...(customAbiInput.trim() ? { abi: customAbiInput.trim() } : {}),
        ...(parseExtraTokens().length > 0 ? { extraTokens: parseExtraTokens() } : {}),
        skipGasNegativeDust: true,
        ...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
        ...(passphrase ? { passphrase } : {}),
      });

      setScanResult(res.scan);

      if (res.mode === 'BROADCASTED' && res.executedTxs) {
        setExecutedTxs(res.executedTxs);
        setNotice(res.message);
        onRecoveryComplete?.();
        return;
      }

      if (res.mode === 'UNSIGNED_TX' && res.unsignedTxs && res.unsignedTxs.length > 0) {
        const ethProvider = (window as any)?.ethereum;
        if (!ethProvider?.request) {
          throw new Error(
            `No Web3 wallet detected and server key does not match contract owner ${res.contractOwner}. Connect MetaMask / Rabby as ${res.contractOwner} or enter its signer key.`
          );
        }

        const accounts: string[] = await ethProvider.request({ method: 'eth_requestAccounts' });
        const ownerLower = (res.signerRequired || res.contractOwner).toLowerCase();
        const matched = accounts.find((a) => a.toLowerCase() === ownerLower);
        if (!matched) {
          throw new Error(
            `Connected Web3 account is ${accounts[0] || 'none'}, but contract ownership requires ${res.contractOwner}. Switch account in MetaMask / Rabby.`
          );
        }

        const firstTx = res.unsignedTxs[0];
        const currentChainHex = await ethProvider.request({ method: 'eth_chainId' });
        if (String(currentChainHex).toLowerCase() !== firstTx.chainIdHex.toLowerCase()) {
          await ethProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: firstTx.chainIdHex }],
          });
        }

        const confirmedList: Array<{
          tokenSymbol: string;
          amountFormatted: string;
          functionSignature: string;
          txHash: string;
          explorerUrl: string;
        }> = [];

        for (let i = 0; i < res.unsignedTxs.length; i++) {
          const utx = res.unsignedTxs[i];
          setNotice(
            `Waiting for Web3 wallet signature (${i + 1}/${res.unsignedTxs.length}): ${utx.functionSignature} for ${utx.amountFormatted} ${utx.tokenSymbol}...`
          );
          const txHash: string = await ethProvider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: utx.from,
                to: utx.to,
                value: utx.value,
                data: utx.data,
                gas: utx.gas,
              },
            ],
          });

          setNotice(`Confirming recovery tx #${i + 1} (${txHash.slice(0, 10)}...) on-chain...`);
          const conf = await confirmContractRescueTx({ chain, txHash });
          confirmedList.push({
            tokenSymbol: utx.tokenSymbol,
            amountFormatted: utx.amountFormatted,
            functionSignature: utx.functionSignature,
            txHash: conf.txHash,
            explorerUrl: conf.explorerUrl,
          });
        }

        setExecutedTxs(confirmedList);
        setNotice(
          `Successfully recovered ${confirmedList.length} trapped asset tx(s) to FLASH_ARB_PROFIT_WALLET (${res.destinationWallet}).`
        );
        onRecoveryComplete?.();
        await handleScan();
      }
    } catch (err: any) {
      if (err?.data?.scan) {
        setScanResult(err.data.scan);
      }
      setError(err?.message || 'Contract rescue execution failed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="p-4 rounded-2xl bg-slate-950/90 border border-indigo-500/40 space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-500/20 border border-indigo-400/40 text-indigo-300 shrink-0">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-xs sm:text-sm font-bold text-white">
                Automated Contract Ownership &amp; Rescue / Sweep Agent
              </h4>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-400/40">
                ABI + PROVIDER AUTO-RECOVERY
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Detects <code className="text-cyan-300 font-mono">owner()</code> / <code className="text-cyan-300 font-mono">admin()</code> via live provider, inspects ABI &amp; bytecode for <code className="text-emerald-300 font-mono">rescue</code> / <code className="text-emerald-300 font-mono">sweep</code> methods, and recovers trapped tokens to <code className="text-amber-300 font-mono">FLASH_ARB_PROFIT_WALLET</code>.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleScan}
            disabled={scanning || executing}
            className="px-3 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/50 text-indigo-200 text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            <span>{scanning ? 'Scanning ABI...' : 'Scan Owner & ABI'}</span>
          </button>

          <button
            type="button"
            onClick={handleExecuteRecovery}
            disabled={executing || scanning}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 text-xs font-mono font-black flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
          >
            {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            <span>{executing ? 'Recovering...' : 'Auto-Recover Trapped Tokens'}</span>
          </button>
        </div>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
        <div>
          <label className="block text-[10px] uppercase text-slate-400 mb-1">Deployed Contract Address</label>
          <input
            type="text"
            value={contractInput}
            onChange={(e) => setContractInput(e.target.value)}
            placeholder="0x... Contract Address"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-400"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-400 mb-1">
            Target Wallet (FLASH_ARB_PROFIT_WALLET)
          </label>
          <input
            type="text"
            value={destinationInput}
            onChange={(e) => setDestinationInput(e.target.value)}
            placeholder="FLASH_ARB_PROFIT_WALLET (0x...)"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-indigo-400"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-slate-400 mb-1">Extra Token Addresses (Optional)</label>
          <input
            type="text"
            value={extraTokensInput}
            onChange={(e) => setExtraTokensInput(e.target.value)}
            placeholder="0xToken1, 0xToken2..."
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-400"
          />
        </div>
      </div>

      {/* Optional ABI override toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowAbiBox((v) => !v)}
          className="text-[11px] font-mono text-indigo-300 hover:text-indigo-200 flex items-center gap-1 cursor-pointer"
        >
          {showAbiBox ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <span>{showAbiBox ? 'Hide custom contract ABI JSON' : 'Optional: Paste custom contract ABI JSON (auto-fetches Etherscan ABI / bytecode otherwise)'}</span>
        </button>

        {showAbiBox && (
          <textarea
            value={customAbiInput}
            onChange={(e) => setCustomAbiInput(e.target.value)}
            rows={3}
            placeholder='[{"type":"function","name":"rescueTokensTo","inputs":[{"name":"token","type":"address"},{"name":"recipient","type":"address"}],"outputs":[],"stateMutability":"nonpayable"}]'
            className="mt-2 w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-indigo-400"
          />
        )}
      </div>

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-[11px] text-rose-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="p-2.5 rounded-lg bg-emerald-950/45 border border-emerald-500/40 text-[11px] text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {executedTxs.length > 0 && (
        <div className="p-3 rounded-xl bg-emerald-950/35 border border-emerald-500/50 space-y-1.5 text-[11px] font-mono">
          <div className="font-bold text-emerald-300 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            <span>Confirmed On-Chain Recovery Transactions</span>
          </div>
          {executedTxs.map((tx, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2 text-slate-200">
              <span>
                {tx.amountFormatted} <b>{tx.tokenSymbol}</b> ({tx.functionSignature})
              </span>
              <a
                href={tx.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-300 hover:text-cyan-200 underline flex items-center gap-1"
              >
                <span>{tx.txHash.slice(0, 10)}...{tx.txHash.slice(-6)}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Scan Results Breakdown */}
      {scanResult && (
        <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5 text-[11px] font-mono">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-400">Detected Owner:</span>
              {scanResult.contractOwner ? (
                <>
                  <span className="text-cyan-300 font-bold select-all">{scanResult.contractOwner}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    via {scanResult.ownerSource}
                  </span>
                </>
              ) : (
                <span className="text-rose-300 font-bold">None (Immutable / No owner getter)</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {scanResult.contractOwner && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    scanResult.hasSufficientOwnerGas
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-amber-500/20 text-amber-200 border-amber-500/40'
                  }`}
                >
                  <Fuel className="inline h-3 w-3 mr-1" />
                  Owner Gas: {Number(scanResult.ownerGasBalanceFormatted).toFixed(5)} {scanResult.nativeSymbol}
                </span>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-200 border border-indigo-500/30">
                ABI: {scanResult.abiSource}
              </span>
            </div>
          </div>

          {/* Detected Rescue / Sweep Functions */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase text-slate-400">
              Detected Rescue / Sweep Methods ({scanResult.detectedFunctions.length})
            </div>
            {scanResult.detectedFunctions.length === 0 ? (
              <div className="text-rose-300 text-[11px]">
                No rescue or sweep functions detected in contract ABI or bytecode.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {scanResult.detectedFunctions.map((fn) => (
                  <span
                    key={fn.selector + fn.signature}
                    className={`px-2 py-1 rounded-lg border text-[10px] flex items-center gap-1 ${
                      fn.directToRecipient
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                        : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200'
                    }`}
                  >
                    <Zap className="h-3 w-3 shrink-0" />
                    <span className="font-bold">{fn.signature}</span>
                    <span className="opacity-70">[{fn.selector}]</span>
                    {fn.directToRecipient && (
                      <span className="px-1 rounded bg-emerald-500/25 text-emerald-100 text-[9px]">1-TX DIRECT</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Gas-Optimized Plan */}
          <div className="space-y-1.5 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
              <span className="uppercase">
                Gas-Optimized Recovery Plan ({scanResult.plan.executableSteps.length} step(s))
              </span>
              <span className="text-emerald-300">
                {scanResult.plan.gasOptimizationStrategy} · Max Fee {scanResult.optimalGas.maxFeePerGasGwei} Gwei
              </span>
            </div>

            {scanResult.plan.executableSteps.map((step) => (
              <div
                key={step.id}
                className="p-2 rounded-lg bg-slate-950 border border-slate-800 flex flex-wrap items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 font-bold text-[10px]">
                    #{step.stepIndex}
                  </span>
                  <span className="text-white font-bold">
                    {step.amountFormatted} {step.tokenSymbol}
                  </span>
                  {step.usdValue !== null && (
                    <span className="text-emerald-300">({formatCurrency(step.usdValue)})</span>
                  )}
                  <span className="text-cyan-300 truncate">{step.functionSignature}</span>
                </div>
                <div className="text-[10px] text-slate-400">
                  Gas ~{step.estimatedGasUnits} (~{Number(step.estimatedGasCostEth).toFixed(6)} {scanResult.nativeSymbol}
                  {step.estimatedGasCostUsd !== null ? ` / $${step.estimatedGasCostUsd.toFixed(3)}` : ''})
                </div>
              </div>
            ))}

            {scanResult.plan.skippedSteps.map((skip) => (
              <div
                key={skip.id}
                className="p-2 rounded-lg bg-amber-950/30 border border-amber-500/30 text-[10px] text-amber-200 flex items-start justify-between gap-2"
              >
                <span>
                  Skipped <b>{skip.amountFormatted} {skip.tokenSymbol}</b>: {skip.reason}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 shrink-0">{skip.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractRescueAgentPanel;
