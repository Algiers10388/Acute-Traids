import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  ExternalLink,
  Fuel,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Vault,
  Wallet,
} from 'lucide-react';
import type { ExchangeId } from '../types';
import {
  confirmVaultTransferTx,
  fetchExchangeDepositAddress,
  fetchVaultChainBalances,
  fundVaultSignerGas,
  resolveVaultSignerInfo,
  transferVaultToExchange,
  type VaultChainBalances,
  type VaultSignerGasInfo,
} from '../services/exchangeApi';
import { formatCurrency } from '../utils/cryptoMath';
import { ContractRescueAgentPanel } from './ContractRescueAgentPanel';

type TargetExchange = 'KRAKEN' | 'BINANCE' | 'COINBASE' | 'OKX' | 'NONKYC';

const TARGET_EXCHANGES: { id: TargetExchange; label: string; note: string }[] = [
  { id: 'KRAKEN', label: 'Kraken', note: 'ETH / Arbitrum / Optimism / Base / Polygon' },
  { id: 'BINANCE', label: 'Binance', note: 'ETH / Arbitrum / Base / Optimism / Polygon / BSC' },
  { id: 'COINBASE', label: 'Coinbase', note: 'ETH / Base / Arbitrum / Optimism / Polygon' },
  { id: 'OKX', label: 'OKX', note: 'ETH / Arbitrum / Optimism / Base / Polygon' },
  { id: 'NONKYC', label: 'NonKYC', note: 'EVM Spot Deposits' },
];

const EVM_CHAINS: { id: string; label: string; explorerName: string }[] = [
  { id: 'ethereum', label: 'Ethereum Mainnet (Etherscan)', explorerName: 'Etherscan' },
  { id: 'arbitrum', label: 'Arbitrum One (Arbiscan)', explorerName: 'Arbiscan' },
  { id: 'base', label: 'Base L2 (Basescan)', explorerName: 'Basescan' },
  { id: 'optimism', label: 'Optimism (Optimistic Etherscan)', explorerName: 'Optimistic Etherscan' },
  { id: 'polygon', label: 'Polygon PoS (Polygonscan)', explorerName: 'Polygonscan' },
  { id: 'bsc', label: 'BNB Smart Chain (BscScan)', explorerName: 'BscScan' },
  { id: 'avalanche', label: 'Avalanche C-Chain (Snowtrace)', explorerName: 'Snowtrace' },
  { id: 'linea', label: 'Linea (Lineascan)', explorerName: 'Lineascan' },
  { id: 'scroll', label: 'Scroll (Scrollscan)', explorerName: 'Scrollscan' },
  { id: 'apechain', label: 'ApeChain (Apescan)', explorerName: 'Apescan' },
];

interface VaultToExchangeTransferProps {
  defaultExchange?: ExchangeId;
  onTransferComplete?: (info: { txHash: string; exchange: string; asset: string; amount: string }) => void;
}

const DEFAULT_VAULT_ADDRESS = '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D';

const DEPLOYED_CONTRACT_BY_CHAIN: Record<string, string> = {
  ethereum: '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D',
  arbitrum: '0xeee31ff9e69904b43c124095b6f33aa61505bcc2',
  base: '0x37440674a814f24d9C6ea0990b272215D40c4512',
  optimism: '0x738C8Eb31316B23d9b8A68B0c2658B456c932598',
  polygon: '0xBBA273E057cDa31bB359d8AA8749256246B6d0cC',
  bsc: '0xBBA273E057cDa31bB359d8AA8749256246B6d0cC',
};

export const VaultToExchangeTransfer: React.FC<VaultToExchangeTransferProps> = ({
  defaultExchange = 'KRAKEN',
  onTransferComplete,
}) => {
  const initialEx: TargetExchange = TARGET_EXCHANGES.some((e) => e.id === defaultExchange)
    ? (defaultExchange as TargetExchange)
    : 'KRAKEN';

  const [chain, setChain] = useState<string>('ethereum');
  const [exchange, setExchange] = useState<TargetExchange>(initialEx);
  const [vaultSourceMode, setVaultSourceMode] = useState<'DEPLOYED_CONTRACT' | 'PROFIT_VAULT' | 'GAS_WALLET' | 'CUSTOM'>('DEPLOYED_CONTRACT');
  const [customVaultAddress, setCustomVaultAddress] = useState<string>(DEFAULT_VAULT_ADDRESS);

  const [vaultBalances, setVaultBalances] = useState<VaultChainBalances | null>(null);
  const [loadingBalances, setLoadingBalances] = useState<boolean>(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [selectedAsset, setSelectedAsset] = useState<string>('ETH');
  const [amount, setAmount] = useState<string>('');
  const [depositAddress, setDepositAddress] = useState<string>('');
  const [depositSourceNote, setDepositSourceNote] = useState<string | null>(null);
  const [fetchingDepositAddr, setFetchingDepositAddr] = useState<boolean>(false);

  const [showSignerInput, setShowSignerInput] = useState<boolean>(false);
  const [sourcePrivateKey, setSourcePrivateKey] = useState<string>('');
  const [sourcePassphrase, setSourcePassphrase] = useState<string>('');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<boolean>(false);
  const [scanningWeb3, setScanningWeb3] = useState<boolean>(false);
  const [web3ScannedWallets, setWeb3ScannedWallets] = useState<Array<{ address: string; providerName: string; isMatch: boolean }> | null>(null);
  const [web3ScanError, setWeb3ScanError] = useState<string | null>(null);

  // Add Gas Panel State
  const [showAddGasPanel, setShowAddGasPanel] = useState<boolean>(false);
  const [signerGasInfo, setSignerGasInfo] = useState<VaultSignerGasInfo | null>(null);
  const [loadingSignerGas, setLoadingSignerGas] = useState<boolean>(false);
  const [gasTargetAddress, setGasTargetAddress] = useState<string>('');
  const [gasTopUpAmount, setGasTopUpAmount] = useState<string>('0.002');
  const [fundingGasMode, setFundingGasMode] = useState<'WEB3' | 'SERVER' | null>(null);
  const [gasFundError, setGasFundError] = useState<string | null>(null);
  const [gasFundNotice, setGasFundNotice] = useState<string | null>(null);
  const [copiedSignerAddr, setCopiedSignerAddr] = useState<boolean>(false);

  const [txReceipt, setTxReceipt] = useState<{
    txHash: string;
    explorerUrl: string;
    exchange: string;
    asset: string;
    amount: string;
    chainName: string;
  } | null>(null);

  useEffect(() => {
    if (TARGET_EXCHANGES.some((e) => e.id === defaultExchange)) {
      setExchange(defaultExchange as TargetExchange);
    }
  }, [defaultExchange]);

  const activeVaultAddress = useMemo(() => {
    if (vaultSourceMode === 'CUSTOM' && /^0x[a-fA-F0-9]{40}$/.test(customVaultAddress.trim())) {
      return customVaultAddress.trim();
    }
    if (vaultSourceMode === 'DEPLOYED_CONTRACT') {
      return (
        DEPLOYED_CONTRACT_BY_CHAIN[chain] ||
        (vaultBalances?.chain === chain ? vaultBalances?.knownContractForChain : null) ||
        vaultBalances?.profitVaultDefault ||
        DEFAULT_VAULT_ADDRESS
      );
    }
    if (vaultSourceMode === 'GAS_WALLET' && vaultBalances?.gasWalletDefault) {
      return vaultBalances.gasWalletDefault;
    }
    if (vaultSourceMode === 'PROFIT_VAULT') {
      return vaultBalances?.profitVaultDefault || DEFAULT_VAULT_ADDRESS;
    }
    return DEFAULT_VAULT_ADDRESS;
  }, [vaultSourceMode, customVaultAddress, chain, vaultBalances?.chain, vaultBalances?.knownContractForChain, vaultBalances?.gasWalletDefault, vaultBalances?.profitVaultDefault]);

  const loadVaultBalances = useCallback(async () => {
    setLoadingBalances(true);
    setBalanceError(null);
    try {
      const requestedVault =
        vaultSourceMode === 'CUSTOM'
          ? customVaultAddress.trim() || undefined
          : vaultSourceMode === 'DEPLOYED_CONTRACT'
            ? (DEPLOYED_CONTRACT_BY_CHAIN[chain] || vaultBalances?.knownContractForChain || DEFAULT_VAULT_ADDRESS)
            : vaultSourceMode === 'GAS_WALLET'
              ? vaultBalances?.gasWalletDefault || undefined
              : undefined;
      if (vaultSourceMode === 'CUSTOM' && (!requestedVault || !/^0x[a-fA-F0-9]{40}$/.test(requestedVault))) {
        setLoadingBalances(false);
        return;
      }
      const data = await fetchVaultChainBalances({ chain, vaultAddress: requestedVault });
      setVaultBalances(data);
      // Ensure selectedAsset exists on this chain
      const validSymbols = new Set([data.native.symbol.toUpperCase(), ...data.tokens.map((t) => t.symbol.toUpperCase())]);
      setSelectedAsset((prev) => (validSymbols.has(prev.toUpperCase()) ? prev : data.native.symbol));
    } catch (err: any) {
      setBalanceError(err?.message || 'Failed to read live on-chain vault balances.');
    } finally {
      setLoadingBalances(false);
    }
  }, [chain, vaultSourceMode, customVaultAddress, vaultBalances?.gasWalletDefault]);

  useEffect(() => {
    loadVaultBalances();
  }, [chain, vaultSourceMode]);

  const selectableAssets = useMemo(() => {
    if (!vaultBalances) {
      return [{ symbol: 'ETH', balance: '0', usdValue: null as number | null, address: undefined as string | undefined, isNative: true }];
    }
    const items = [
      {
        symbol: vaultBalances.native.symbol,
        balance: vaultBalances.native.balance,
        usdValue: vaultBalances.native.usdValue,
        address: undefined as string | undefined,
        isNative: true,
      },
      ...vaultBalances.tokens.map((t) => ({
        symbol: t.symbol,
        balance: t.balance,
        usdValue: t.usdValue,
        address: t.address,
        isNative: false,
      })),
    ];
    // Sort non-zero balances first while keeping native coin prominent
    return items.sort((a, b) => {
      const aHas = Number(a.balance) > 0 ? 1 : 0;
      const bHas = Number(b.balance) > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [vaultBalances]);

  const currentAssetInfo = useMemo(
    () => selectableAssets.find((a) => a.symbol.toUpperCase() === selectedAsset.toUpperCase()) || selectableAssets[0],
    [selectableAssets, selectedAsset]
  );

  const handleFetchDepositAddress = async () => {
    setFetchingDepositAddr(true);
    setError(null);
    setDepositSourceNote(null);
    try {
      const res = await fetchExchangeDepositAddress({
        exchange,
        asset: selectedAsset,
        chain,
      });
      if (res.depositAddress) {
        setDepositAddress(res.depositAddress);
        setDepositSourceNote(
          res.source === 'EXCHANGE_API'
            ? `Verified from ${exchange} API (${res.method || chain})`
            : res.hint || `Loaded linked ${exchange} deposit address`
        );
      }
    } catch (err: any) {
      setError(err?.message || `Could not auto-fetch ${exchange} deposit address. Paste it manually below.`);
    } finally {
      setFetchingDepositAddr(false);
    }
  };

  const handleScanWeb3Wallets = async () => {
    setScanningWeb3(true);
    setWeb3ScanError(null);
    setWeb3ScannedWallets(null);
    try {
      const ethProvider = (window as any)?.ethereum;
      if (!ethProvider?.request) {
        throw new Error('No Web3 wallet extension detected in browser (e.g. MetaMask, Rabby, Coinbase Wallet).');
      }
      const accounts: string[] = await ethProvider.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('No accounts returned from connected Web3 wallet.');
      }
      const targetVault = (vaultBalances?.vaultAddress || activeVaultAddress || '').toLowerCase();
      const discovered = accounts.map((acc) => {
        const cleanAcc = acc.toLowerCase();
        return {
          address: acc,
          providerName: ethProvider.isMetaMask ? 'MetaMask' : ethProvider.isCoinbaseWallet ? 'Coinbase Wallet' : 'Injected Web3 Wallet',
          isMatch: Boolean(targetVault && cleanAcc === targetVault),
        };
      });
      setWeb3ScannedWallets(discovered);
    } catch (err: any) {
      setWeb3ScanError(err?.message || 'Failed to scan connected Web3 wallets.');
    } finally {
      setScanningWeb3(false);
    }
  };

  const refreshSignerGasInfo = useCallback(
    async (explicitAddress?: string) => {
      const targetAddr =
        explicitAddress?.trim() ||
        gasTargetAddress.trim() ||
        vaultBalances?.serverSignerAddress ||
        vaultBalances?.gasWalletDefault ||
        '';
      if (!sourcePrivateKey.trim() && !/^0x[a-fA-F0-9]{40}$/.test(targetAddr)) {
        return;
      }
      setLoadingSignerGas(true);
      setGasFundError(null);
      try {
        const info = await resolveVaultSignerInfo({
          chain,
          ...(sourcePrivateKey.trim()
            ? {
                privateKey: sourcePrivateKey.trim(),
                ...(sourcePassphrase ? { passphrase: sourcePassphrase } : {}),
              }
            : { signerAddress: targetAddr }),
        });
        setSignerGasInfo(info);
        setGasTargetAddress(info.signerAddress);
        setGasTopUpAmount((prev) =>
          !prev || prev === '0.002' || prev === '0.0002' ? info.recommendedTopUp : prev
        );
      } catch (err: any) {
        setGasFundError(err?.message || 'Unable to resolve signer gas balance.');
      } finally {
        setLoadingSignerGas(false);
      }
    },
    [chain, gasTargetAddress, sourcePrivateKey, sourcePassphrase, vaultBalances?.serverSignerAddress, vaultBalances?.gasWalletDefault]
  );

  useEffect(() => {
    if (sourcePrivateKey.trim()) {
      const timer = setTimeout(() => {
        void refreshSignerGasInfo();
      }, 250);
      return () => clearTimeout(timer);
    } else if (showAddGasPanel) {
      void refreshSignerGasInfo();
    }
  }, [chain, sourcePrivateKey, sourcePassphrase, showAddGasPanel]);

  const handleGenerateTempSigner = async () => {
    setError(null);
    setNotice(null);
    setGasFundError(null);
    setGasFundNotice(null);
    try {
      const currentVault = vaultBalances?.vaultAddress || activeVaultAddress || DEFAULT_VAULT_ADDRESS;
      const res = await fetch('/api/flash-arb/vault/generate-temp-signer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultAddress: currentVault }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.privateKey) {
        throw new Error(data?.error || 'Failed to generate temporary signer');
      }
      setSourcePrivateKey(data.privateKey);
      setShowSignerInput(true);
      if (data.signerAddress && /^0x[a-fA-F0-9]{40}$/.test(data.signerAddress)) {
        setGasTargetAddress(data.signerAddress);
        setShowAddGasPanel(true);
        void refreshSignerGasInfo(data.signerAddress);
      }
      setNotice(
        data.signerAddress
          ? `Generated temporary signer ${data.signerAddress} for Vault ${currentVault}. Add gas below if balance is 0.`
          : data.message || `Generated working temporary signer for Vault ${currentVault}`
      );
    } catch (err: any) {
      setError(err?.message || 'Failed to generate temporary signer.');
    }
  };

  const handleFundGasViaWeb3 = async () => {
    setGasFundError(null);
    setGasFundNotice(null);
    const recipient = (gasTargetAddress || signerGasInfo?.signerAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return setGasFundError('Enter or select a valid 0x... signer address to fund.');
    }
    const cleanTopUp = gasTopUpAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(cleanTopUp) || Number(cleanTopUp) <= 0) {
      return setGasFundError('Enter a valid positive decimal gas amount (e.g. 0.002).');
    }

    setFundingGasMode('WEB3');
    try {
      const ethProvider = (window as any)?.ethereum;
      if (!ethProvider?.request) {
        throw new Error('No Web3 browser wallet detected (MetaMask, Rabby, Coinbase Wallet). Copy the signer address below to fund it from Kraken, Coinbase, or another wallet.');
      }
      const accounts: string[] = await ethProvider.request({ method: 'eth_requestAccounts' });
      const fromAccount = accounts?.[0];
      if (!fromAccount) {
        throw new Error('No unlocked Web3 account available to send gas.');
      }

      const targetChainHex = vaultBalances?.chainIdHex || signerGasInfo?.chainIdHex;
      if (targetChainHex) {
        const currentChainId = await ethProvider.request({ method: 'eth_chainId' });
        if (String(currentChainId).toLowerCase() !== targetChainHex.toLowerCase()) {
          await ethProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetChainHex }],
          });
        }
      }

      // Convert decimal amount cleanly to Wei hex without float drift
      const [wholePart = '0', fracPart = ''] = cleanTopUp.split('.');
      const weiBigInt = BigInt(wholePart || '0') * 10n ** 18n + BigInt((fracPart + '0'.repeat(18)).slice(0, 18));
      const valueHex = `0x${weiBigInt.toString(16)}`;

      setGasFundNotice(`Confirm gas top-up of ${cleanTopUp} in your Web3 wallet...`);
      const txHash: string = await ethProvider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: fromAccount,
            to: recipient,
            value: valueHex,
          },
        ],
      });

      setGasFundNotice(`Gas transfer submitted (${txHash.slice(0, 10)}...). Checking on-chain confirmation...`);
      await refreshSignerGasInfo(recipient);
      await loadVaultBalances();
      setGasFundNotice(`Sent ${cleanTopUp} ${signerGasInfo?.nativeSymbol || 'ETH'} gas to ${recipient.slice(0, 6)}...${recipient.slice(-4)} (Tx ${txHash.slice(0, 10)}...).`);
    } catch (err: any) {
      setGasFundError(err?.message || 'Web3 gas transfer failed.');
    } finally {
      setFundingGasMode(null);
    }
  };

  const handleFundGasFromServerWallet = async () => {
    setGasFundError(null);
    setGasFundNotice(null);
    const recipient = (gasTargetAddress || signerGasInfo?.signerAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return setGasFundError('Enter or select a valid 0x... signer address to fund.');
    }
    const cleanAmt = gasTopUpAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(cleanAmt) || !(Number(cleanAmt) > 0)) {
      return setGasFundError('Enter a valid positive decimal gas amount.');
    }
    setFundingGasMode('SERVER');
    try {
      const res = await fundVaultSignerGas({
        chain,
        targetAddress: recipient,
        amount: cleanAmt,
      });
      setGasFundNotice(`${res.message} (${res.txHash.slice(0, 10)}...)`);
      await refreshSignerGasInfo(recipient);
      await loadVaultBalances();
    } catch (err: any) {
      setGasFundError(err?.message || 'Could not fund gas from server Gas Wallet.');
    } finally {
      setFundingGasMode(null);
    }
  };

  const applyFraction = (pct: number) => {
    if (!currentAssetInfo) return;
    if (pct === 1 && currentAssetInfo.isNative) {
      setAmount('MAX');
      return;
    }
    const bal = parseFloat(currentAssetInfo.balance);
    if (!Number.isFinite(bal) || bal <= 0) {
      setAmount('0');
      return;
    }
    if (pct === 1) {
      setAmount(currentAssetInfo.balance);
      return;
    }
    const sliced = Math.floor(bal * pct * 1e6) / 1e6;
    setAmount(String(sliced));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setTxReceipt(null);

    const sourceAddr = vaultBalances?.vaultAddress || activeVaultAddress;
    if (!sourceAddr || !/^0x[a-fA-F0-9]{40}$/.test(sourceAddr)) {
      return setError('Valid Source Vault EVM address (0x...) is required.');
    }
    const destAddr = depositAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(destAddr)) {
      return setError(`Enter a valid ${exchange} EVM deposit address (0x + 40 hex characters) or click Fetch Deposit Address.`);
    }
    if (destAddr.toLowerCase() === sourceAddr.toLowerCase()) {
      return setError('Destination deposit address cannot match the source Vault address.');
    }
    const cleanAmt = amount.trim();
    if (!cleanAmt || (cleanAmt.toUpperCase() !== 'MAX' && !(Number(cleanAmt) > 0))) {
      return setError('Enter a valid positive transfer amount or MAX.');
    }

    setSubmitting(true);
    try {
      const res = await transferVaultToExchange({
        chain,
        exchange,
        sourceVaultAddress: sourceAddr,
        depositAddress: destAddr,
        assetSymbol: currentAssetInfo.symbol,
        ...(currentAssetInfo.address ? { tokenAddress: currentAssetInfo.address } : {}),
        amount: cleanAmt,
        ...(sourcePrivateKey.trim() ? { sourcePrivateKey: sourcePrivateKey.trim() } : {}),
        ...(sourcePassphrase ? { sourcePassphrase } : {}),
      });

      if (res.mode === 'BROADCASTED' && res.txHash) {
        setTxReceipt({
          txHash: res.txHash,
          explorerUrl: res.explorerUrl || `${vaultBalances?.explorer || ''}/tx/${res.txHash}`,
          exchange,
          asset: res.asset,
          amount: res.amount,
          chainName: res.chainName,
        });
        setNotice(res.message);
        setAmount('');
        setSourcePrivateKey('');
        setSourcePassphrase('');
        await loadVaultBalances();
        onTransferComplete?.({ txHash: res.txHash, exchange, asset: res.asset, amount: res.amount });
        return;
      }

      if (res.mode === 'UNSIGNED_TX' && res.unsignedTx) {
        const ethProvider = (window as any)?.ethereum;
        if (!ethProvider?.request) {
          throw new Error(
            `No Web3 wallet detected and server key does not match Vault ${sourceAddr.slice(0, 6)}...${sourceAddr.slice(-4)}. Expand "Vault Signer Key" below or connect MetaMask / Rabby for ${sourceAddr}.`
          );
        }

        // Request active Web3 accounts and ensure correct chain
        const accounts: string[] = await ethProvider.request({ method: 'eth_requestAccounts' });
        const requiredSigner = (res.signerRequired || sourceAddr).toLowerCase();
        const matchedAccount = accounts.find((a) => a.toLowerCase() === requiredSigner);
        if (!matchedAccount) {
          throw new Error(
            `Connected Web3 wallet is ${accounts[0] || 'none'}, but transfer requires ${res.signerRequired || sourceAddr}. Switch accounts in MetaMask or supply the Vault Signer Key below.`
          );
        }

        const currentChainId = await ethProvider.request({ method: 'eth_chainId' });
        if (String(currentChainId).toLowerCase() !== res.unsignedTx.chainIdHex.toLowerCase()) {
          await ethProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: res.unsignedTx.chainIdHex }],
          });
        }

        setNotice(`Waiting for Web3 wallet signature from ${(res.signerRequired || sourceAddr).slice(0, 6)}...${(res.signerRequired || sourceAddr).slice(-4)}...`);
        const txHash: string = await ethProvider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: res.unsignedTx.from,
              to: res.unsignedTx.to,
              value: res.unsignedTx.value,
              data: res.unsignedTx.data,
              gas: res.unsignedTx.gas,
            },
          ],
        });

        setNotice(`Transaction submitted (${txHash.slice(0, 10)}...). Verifying on-chain receipt...`);
        const confirmed = await confirmVaultTransferTx({
          chain,
          txHash,
          exchange,
          sourceVaultAddress: sourceAddr,
          depositAddress: destAddr,
          assetSymbol: res.asset,
          amount: res.amount,
        });

        setTxReceipt({
          txHash: confirmed.txHash,
          explorerUrl: confirmed.explorerUrl,
          exchange,
          asset: res.asset,
          amount: res.amount,
          chainName: res.chainName,
        });
        setNotice(confirmed.message);
        setAmount('');
        await loadVaultBalances();
        onTransferComplete?.({ txHash: confirmed.txHash, exchange, asset: res.asset, amount: res.amount });
      }
    } catch (err: any) {
      setError(err?.message || 'Vault-to-exchange transfer failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {/* Header Banner */}
      <div className="p-4 rounded-2xl bg-slate-950/80 border border-cyan-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 shrink-0">
            <Vault className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm sm:text-base font-bold text-white">Profit Vault → Kraken / Exchange Transfer</h3>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                ON-CHAIN LIVE RPC
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
              Send realized native ETH/gas coin or ERC-20 profits directly from your on-chain Profit Vault to your Kraken or CEX EVM deposit address.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowAddGasPanel((v) => !v);
              if (!showAddGasPanel) {
                void refreshSignerGasInfo();
              }
            }}
            className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer transition-all ${
              showAddGasPanel
                ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-300'
            }`}
          >
            <Fuel className="h-3.5 w-3.5" />
            <span>Add Gas</span>
          </button>

          <button
            type="button"
            onClick={loadVaultBalances}
            disabled={loadingBalances}
            className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-mono font-bold text-cyan-300 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingBalances ? 'animate-spin' : ''}`} />
            <span>Sync Vault</span>
          </button>
        </div>
      </div>

      {/* Vault Source & Chain Selector */}
      <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-mono font-bold uppercase text-slate-400 mb-1">1. Blockchain Network</label>
            <select
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setDepositSourceNote(null);
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-cyan-500"
            >
              {EVM_CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-mono font-bold uppercase text-slate-400 mb-1">2. Source On-Chain Wallet / Contract</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: 'DEPLOYED_CONTRACT', label: 'FlashArb Contract' },
                { id: 'PROFIT_VAULT', label: 'Profit Vault' },
                ...(vaultBalances?.gasWalletDefault ? [{ id: 'GAS_WALLET', label: 'Gas Wallet' }] : []),
                { id: 'CUSTOM', label: 'Custom EVM' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setVaultSourceMode(opt.id as any);
                    setError(null);
                  }}
                  className={`flex-1 py-2 px-2.5 rounded-xl text-xs font-mono font-bold border transition-all cursor-pointer ${
                    vaultSourceMode === opt.id
                      ? opt.id === 'DEPLOYED_CONTRACT'
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                        : 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={async () => {
                  try {
                    const ethProvider = (window as any)?.ethereum;
                    if (!ethProvider?.request) {
                      setError('No Web3 wallet extension detected (MetaMask, Rabby, Coinbase Wallet).');
                      return;
                    }
                    const accounts: string[] = await ethProvider.request({ method: 'eth_requestAccounts' });
                    if (accounts?.[0]) {
                      setVaultSourceMode('CUSTOM');
                      setCustomVaultAddress(accounts[0]);
                      setError(null);
                      setNotice(`Selected connected Web3 account ${accounts[0]} as Source Wallet.`);
                    }
                  } catch (e: any) {
                    setError(e?.message || 'Failed to read connected Web3 account.');
                  }
                }}
                className="py-2 px-2.5 rounded-xl text-xs font-mono font-bold border border-slate-700 bg-slate-900 hover:border-cyan-500/60 text-cyan-300 transition-all cursor-pointer"
                title="Use your active MetaMask / Rabby / Coinbase Wallet address"
              >
                Connected Web3
              </button>
            </div>
          </div>
        </div>

        {vaultSourceMode === 'CUSTOM' && (
          <div className="flex gap-2">
            <input
              type="text"
              value={customVaultAddress}
              onChange={(e) => setCustomVaultAddress(e.target.value)}
              placeholder="0x... Custom EVM Vault Address"
              className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-cyan-500"
            />
            <button
              type="button"
              onClick={loadVaultBalances}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-mono text-cyan-300 cursor-pointer"
            >
              Load Balances
            </button>
          </div>
        )}

        {/* Active Vault Address + Live Balance Pills */}
        {vaultBalances && (
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-2 min-w-0">
                <Wallet className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="text-slate-400">Vault:</span>
                <span className="text-white font-bold truncate select-all">{vaultBalances.vaultAddress}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(vaultBalances.vaultAddress);
                    setCopiedAddr(true);
                    setTimeout(() => setCopiedAddr(false), 1800);
                  }}
                  className="text-slate-400 hover:text-cyan-300 cursor-pointer"
                  title="Copy Vault address"
                >
                  {copiedAddr ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
                <a
                  href={`${vaultBalances.explorer}/address/${vaultBalances.vaultAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 text-[10px] underline ml-1 cursor-pointer"
                  title={`View on ${EVM_CHAINS.find((c) => c.id === chain)?.explorerName || 'Explorer'}`}
                >
                  <span>{EVM_CHAINS.find((c) => c.id === chain)?.explorerName || 'Explorer'}</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    vaultBalances.hasServerSignerForVault
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-amber-500/15 text-amber-200 border-amber-500/40'
                  }`}
                >
                  {vaultBalances.hasServerSignerForVault ? 'Server Signer Ready' : 'Web3 / Vault Key Signer'}
                </span>
                <span className="text-emerald-300 font-bold">{formatCurrency(vaultBalances.totalUsd)}</span>
              </div>
            </div>

            {chain !== 'ethereum' && vaultBalances.vaultAddress.toLowerCase() === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' && (
              <div className="p-2.5 rounded-lg bg-amber-950/50 border border-amber-500/40 text-[11px] font-sans text-amber-200 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-amber-300">
                      Vault address 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 is on Ethereum Mainnet (Etherscan), not {EVM_CHAINS.find((c) => c.id === chain)?.explorerName || 'this network'}.
                    </span>
                    <p className="text-[10px] text-slate-300 mt-0.5">
                      On Arbitrum One (Arbiscan), canonical WETH is <code className="text-cyan-300 font-mono">0x82aF49447D8a07e3bd95BD0d56f35241523fBab1</code>. Click below to inspect on Etherscan or switch to Arbitrum WETH.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1 font-mono text-[10px]">
                  <button
                    type="button"
                    onClick={() => setChain('ethereum')}
                    className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <span>⚡ Switch Network to Ethereum (Etherscan)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setChain('arbitrum');
                      setVaultSourceMode('CUSTOM');
                      setCustomVaultAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
                    }}
                    className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <span>🔵 Use Arbitrum WETH (0x82aF... on Arbiscan)</span>
                  </button>
                  <a
                    href="https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <span>Open Etherscan</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            )}

            {vaultBalances.isSmartContract && vaultBalances.canContractRescue && (
              <div className="p-2.5 rounded-lg bg-emerald-950/35 border border-emerald-500/40 text-[11px] font-sans text-emerald-200 space-y-1.5">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-emerald-300">
                      Rescueable Smart-Contract Vault Ready ({vaultBalances.vaultAddress})
                    </span>
                    <p className="text-[10px] text-slate-300 mt-0.5 leading-relaxed">
                      Owner: <code className="text-cyan-300 font-mono">{vaultBalances.contractOwner}</code>. Transfers from this contract execute on-chain via{' '}
                      <code className="text-emerald-300 font-mono">
                        {vaultBalances.hasRescueTokensTo ? 'rescueTokensTo(token, recipient)' : 'executeDirectFlashArb(recipient)'}
                      </code>{' '}
                      when signed by the contract owner (click <b>MAX</b> for ERC-20 token withdrawals).
                    </p>
                  </div>
                </div>
              </div>
            )}

            {vaultBalances.isSmartContract && !vaultBalances.canContractRescue && (
              <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-[11px] font-sans text-rose-200 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-rose-300">
                      {vaultBalances.vaultAddress} is an immutable token/external smart contract without owner rescue functions.
                    </span>
                    <p className="text-[10px] text-slate-300 mt-0.5 leading-relaxed">
                      Public contracts like WETH9 have no <code className="text-cyan-300 font-mono">owner()</code> or <code className="text-cyan-300 font-mono">rescueTokensTo()</code> method, so Ethereum does not allow any key to withdraw funds held at this contract address. To transfer assets from a contract you own or from your wallet, switch below:
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 font-mono text-[10px]">
                  {vaultBalances.knownContractForChain && (
                    <button
                      type="button"
                      onClick={() => {
                        setVaultSourceMode('CUSTOM');
                        setCustomVaultAddress(vaultBalances.knownContractForChain || '');
                        setError(null);
                      }}
                      className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-200 font-bold cursor-pointer transition-all"
                    >
                      Use Deployed FlashArb Contract ({vaultBalances.knownContractForChain.slice(0, 6)}...{vaultBalances.knownContractForChain.slice(-4)})
                    </button>
                  )}
                  {signerGasInfo?.signerAddress &&
                    signerGasInfo.signerAddress.toLowerCase() !== vaultBalances.vaultAddress.toLowerCase() && (
                      <button
                        type="button"
                        onClick={() => {
                          setVaultSourceMode('CUSTOM');
                          setCustomVaultAddress(signerGasInfo.signerAddress);
                          setError(null);
                        }}
                        className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-bold cursor-pointer transition-all"
                      >
                        Switch Source Wallet to Signer ({signerGasInfo.signerAddress.slice(0, 6)}...{signerGasInfo.signerAddress.slice(-4)})
                      </button>
                    )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {selectableAssets.slice(0, 8).map((item) => {
                const isSelected = currentAssetInfo?.symbol.toUpperCase() === item.symbol.toUpperCase();
                const balNum = parseFloat(item.balance);
                return (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => setSelectedAsset(item.symbol)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-all cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200 font-bold'
                        : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <span>{Number.isFinite(balNum) ? balNum.toFixed(balNum >= 1 ? 4 : 6) : item.balance}</span>
                    <span className="text-cyan-300">{item.symbol}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {balanceError && (
          <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-500/40 rounded-lg px-3 py-2">{balanceError}</div>
        )}

        {/* Web3 Wallet Signer Scanner Agent */}
        <div className="mt-3 p-3 rounded-xl bg-slate-900/90 border border-cyan-500/30 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-cyan-300 text-xs font-mono font-bold">
              <span>🔍</span>
              <span>Web3 Wallet Signer Scanner Agent</span>
            </div>
            <button
              type="button"
              onClick={handleScanWeb3Wallets}
              disabled={scanningWeb3}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {scanningWeb3 ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wallet className="h-3 w-3" />}
              <span>{scanningWeb3 ? 'Scanning Connected Wallets...' : 'Scan Connected Web3 Wallets'}</span>
            </button>
          </div>

          <p className="text-[11px] text-slate-400 font-sans">
            Automatically scan connected browser extension wallets (MetaMask, Rabby, Coinbase Wallet) to verify signer accounts and match active vault addresses.
          </p>

          {web3ScanError && (
            <div className="text-[11px] text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg p-2 font-mono">
              {web3ScanError}
            </div>
          )}

          {web3ScannedWallets && (
            <div className="space-y-1.5 pt-1">
              {web3ScannedWallets.map((w, i) => (
                <div key={i} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-emerald-400 font-bold">●</span>
                    <span className="text-white truncate select-all">{w.address}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400">{w.providerName}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {w.isMatch ? (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                        MATCHED SIGNER
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setNotice(`Selected connected Web3 wallet ${w.address} as authorized signer for Vault ${vaultBalances?.vaultAddress || activeVaultAddress || DEFAULT_VAULT_ADDRESS}`);
                        }}
                        className="px-2 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 text-[10px] font-bold cursor-pointer transition-all"
                      >
                        Authorize as Signer
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Gas to Signer Wallet Panel */}
        {showAddGasPanel && (
          <div className="mt-3 p-3.5 rounded-xl bg-amber-950/25 border border-amber-500/40 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-amber-300 text-xs font-mono font-bold">
                <Fuel className="h-4 w-4 shrink-0" />
                <span>Add Gas ({EVM_CHAINS.find((c) => c.id === chain)?.label || chain})</span>
              </div>
              <div className="flex items-center gap-2">
                {signerGasInfo && (
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border font-bold ${
                      Number(signerGasInfo.balanceFormatted) > 0
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                    }`}
                  >
                    Live Gas Balance: {Number(signerGasInfo.balanceFormatted).toFixed(6)} {signerGasInfo.nativeSymbol}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void refreshSignerGasInfo(gasTargetAddress)}
                  disabled={loadingSignerGas}
                  className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-cyan-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${loadingSignerGas ? 'animate-spin' : ''}`} />
                  <span>Check Arrival</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono">
              <div className="sm:col-span-2 space-y-1">
                <label className="block text-[10px] uppercase text-slate-400">
                  Target Signer Wallet to Fund (0x...)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={gasTargetAddress}
                    onChange={(e) => setGasTargetAddress(e.target.value)}
                    placeholder="0x... Signer Address (auto-filled from Vault Signer Key)"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                  />
                  {gasTargetAddress.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(gasTargetAddress.trim());
                        setCopiedSignerAddr(true);
                        setTimeout(() => setCopiedSignerAddr(false), 1800);
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-300 flex items-center gap-1 cursor-pointer"
                      title="Copy Signer Deposit Address"
                    >
                      {copiedSignerAddr ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      <span className="text-[10px]">{copiedSignerAddr ? 'Copied' : 'Copy'}</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase text-slate-400">
                    Gas Amount ({signerGasInfo?.nativeSymbol || 'ETH'})
                  </label>
                  <div className="flex gap-1">
                    {(chain === 'ethereum' ? ['0.002', '0.005', '0.01'] : ['0.0005', '0.002', '0.01']).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setGasTopUpAmount(preset)}
                        className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 cursor-pointer"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="text"
                  value={gasTopUpAmount}
                  onChange={(e) => setGasTopUpAmount(e.target.value)}
                  placeholder="0.002"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            {signerGasInfo && (
              <div className="text-[10px] font-mono text-slate-400 flex flex-wrap items-center gap-3">
                <span>Network Gas: <b className="text-slate-200">{signerGasInfo.gasPriceGwei} Gwei</b></span>
                <span>Recommended Top-Up: <b className="text-amber-300">{signerGasInfo.recommendedTopUp} {signerGasInfo.nativeSymbol}</b></span>
                {signerGasInfo.serverSignerAddress && (
                  <span>
                    Server Gas Wallet ({signerGasInfo.serverSignerAddress.slice(0, 6)}...{signerGasInfo.serverSignerAddress.slice(-4)}):{' '}
                    <b className="text-cyan-300">{Number(signerGasInfo.serverSignerBalanceFormatted).toFixed(6)} {signerGasInfo.nativeSymbol}</b>
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-0.5 font-mono text-[10px]">
              <button
                type="button"
                onClick={handleFundGasViaWeb3}
                disabled={fundingGasMode !== null}
                className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
              >
                {fundingGasMode === 'WEB3' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                <span>Send {gasTopUpAmount || '0'} {signerGasInfo?.nativeSymbol || 'ETH'} via MetaMask / Web3</span>
              </button>

              {signerGasInfo?.hasServerFundingSigner && (
                <button
                  type="button"
                  onClick={handleFundGasFromServerWallet}
                  disabled={fundingGasMode !== null || !signerGasInfo.canServerFund}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-200 font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
                  title={
                    signerGasInfo.canServerFund
                      ? 'Broadcast real gas funding tx from configured server Gas Wallet'
                      : 'Server Gas Wallet needs more native gas balance on this network first'
                  }
                >
                  {fundingGasMode === 'SERVER' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fuel className="h-3.5 w-3.5" />}
                  <span>Fund from Server Gas Wallet</span>
                </button>
              )}

              <span className="text-[10px] font-sans text-slate-400 self-center">
                Or withdraw {signerGasInfo?.nativeSymbol || 'ETH'} from Kraken / Coinbase directly to the target address above, then click <b>Check Arrival</b>.
              </span>
            </div>

            {gasFundError && (
              <div className="p-2 rounded-lg bg-rose-950/60 border border-rose-500/40 text-[11px] text-rose-200 font-mono">
                {gasFundError}
              </div>
            )}
            {gasFundNotice && (
              <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-[11px] text-emerald-200 font-mono">
                {gasFundNotice}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-500/50 text-xs text-rose-200 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{error}</span>
          </div>

          {(/timed out|gas|fee|insufficient/i.test(error)) && (
            <div className="pt-2 border-t border-rose-500/20 text-[11px] text-slate-300 font-sans space-y-2">
              <div className="text-amber-300 font-bold flex items-center gap-1.5">
                <span>💡 Why Destination Wallets Cannot Pay Gas:</span>
              </div>
              <p className="leading-relaxed text-slate-300 text-[10px]">
                Under the EVM protocol, network gas is strictly deducted from the <b>sender (Vault/Signer)</b> before execution. Destination accounts (like Kraken or exchange deposit wallets) only receive assets and cannot be charged for incoming transfers.
              </p>
              <div className="flex flex-wrap gap-2 pt-1 font-mono text-[10px]">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddGasPanel(true);
                    void refreshSignerGasInfo(gasTargetAddress);
                  }}
                  className="px-2.5 py-1 rounded bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400/60 text-amber-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                >
                  <Fuel className="h-3 w-3" />
                  <span>⛽ Add Gas to Signer Wallet</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChain('arbitrum');
                    setError(null);
                  }}
                  className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                >
                  <span>⚡ Switch to Arbitrum One (&lt; $0.01 Gas)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChain('base');
                    setError(null);
                  }}
                  className="px-2.5 py-1 rounded bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/50 text-blue-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                >
                  <span>🔵 Switch to Base L2 (&lt; $0.01 Gas)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    applyFraction(1);
                    setError(null);
                  }}
                  className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-200 font-bold flex items-center gap-1 cursor-pointer transition-all"
                >
                  <span>✨ Auto-Deduct Gas with MAX</span>
                </button>
              </div>
            </div>
          )}

          {(/does not match|smart contract|reverted|allowance/i.test(error)) &&
            signerGasInfo?.signerAddress &&
            signerGasInfo.signerAddress.toLowerCase() !== (vaultBalances?.vaultAddress || activeVaultAddress).toLowerCase() && (
              <div className="pt-2 border-t border-rose-500/20 text-[11px] font-sans space-y-2">
                <p className="text-[10px] text-slate-300 leading-relaxed">
                  Your active signer key controls <code className="text-cyan-300 font-mono">{signerGasInfo.signerAddress}</code> (gas balance: {Number(signerGasInfo.balanceFormatted).toFixed(6)} {signerGasInfo.nativeSymbol}), whereas the selected source is <code className="text-amber-300 font-mono">{vaultBalances?.vaultAddress || activeVaultAddress}</code>.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setVaultSourceMode('CUSTOM');
                    setCustomVaultAddress(signerGasInfo.signerAddress);
                    setError(null);
                  }}
                  className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-mono text-[10px] font-bold cursor-pointer transition-all"
                >
                  Switch Source Wallet to Signer ({signerGasInfo.signerAddress.slice(0, 6)}...{signerGasInfo.signerAddress.slice(-4)})
                </button>
              </div>
            )}
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {txReceipt && (
        <div className="p-4 rounded-2xl bg-emerald-950/35 border border-emerald-500/50 space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              On-Chain Deposit Confirmed to {txReceipt.exchange}
            </span>
            <a
              href={txReceipt.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:text-cyan-200 flex items-center gap-1 underline"
            >
              <span>View Explorer</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="text-[11px] text-slate-200">
            Sent <b>{txReceipt.amount} {txReceipt.asset}</b> on {txReceipt.chainName} · Tx{' '}
            <span className="text-cyan-300 select-all">{txReceipt.txHash}</span>
          </div>
        </div>
      )}

      {/* Automated Contract Ownership & Rescue / Sweep Recovery Agent */}
      <ContractRescueAgentPanel
        chain={chain}
        activeContractAddress={
          vaultSourceMode === 'DEPLOYED_CONTRACT' || vaultBalances?.isSmartContract
            ? vaultBalances?.vaultAddress || activeVaultAddress
            : vaultBalances?.knownContractForChain || activeVaultAddress
        }
        defaultProfitWallet={vaultBalances?.profitVaultDefault || ''}
        privateKey={sourcePrivateKey}
        passphrase={sourcePassphrase}
        onRecoveryComplete={() => {
          void loadVaultBalances();
        }}
      />

      {/* Transfer Form */}
      <form onSubmit={handleSubmit} className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-[10px] font-mono font-bold uppercase text-slate-400 mb-1">3. Destination Exchange</label>
            <select
              value={exchange}
              onChange={(e) => {
                setExchange(e.target.value as TargetExchange);
                setDepositSourceNote(null);
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-semibold focus:outline-none focus:border-cyan-500"
            >
              {TARGET_EXCHANGES.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.label} ({ex.id})
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 mt-1">
              {TARGET_EXCHANGES.find((x) => x.id === exchange)?.note}
            </p>
          </div>

          <div>
            <label className="block text-[10px] font-mono font-bold uppercase text-slate-400 mb-1">4. Asset to Transfer</label>
            <select
              value={currentAssetInfo?.symbol || selectedAsset}
              onChange={(e) => setSelectedAsset(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-cyan-500"
            >
              {selectableAssets.map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.symbol} ({Number(a.balance || 0).toFixed(4)} avail)
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-mono font-bold uppercase text-slate-400">5. Amount</label>
              <div className="flex gap-1">
                {[0.25, 0.5, 1].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applyFraction(pct)}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 cursor-pointer"
                  >
                    {pct === 1 ? 'MAX' : `${pct * 100}%`}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.05 or MAX"
              className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2.5 rounded-xl font-mono text-sm font-bold focus:outline-none focus:border-cyan-500"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Tip: Click <b>MAX</b> to automatically calculate and deduct network gas fees from the transfer.
            </p>
          </div>
        </div>

        {/* Deposit Address Resolution */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <label className="text-[10px] font-mono font-bold uppercase text-slate-400">
              {exchange} {chain.toUpperCase()} EVM Deposit Address (0x...)
            </label>
            <button
              type="button"
              onClick={handleFetchDepositAddress}
              disabled={fetchingDepositAddr}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {fetchingDepositAddr ? <Loader2 className="h-3 w-3 animate-spin" /> : <Coins className="h-3 w-3" />}
              <span>{fetchingDepositAddr ? `Fetching from ${exchange}...` : `Fetch ${exchange} Deposit Address`}</span>
            </button>
          </div>

          <input
            type="text"
            value={depositAddress}
            onChange={(e) => setDepositAddress(e.target.value)}
            placeholder={`Paste your ${exchange} ${chain} ${currentAssetInfo?.symbol || 'ETH'} deposit address (0x...)`}
            className="w-full bg-slate-900 border border-slate-700 text-white px-3.5 py-2.5 rounded-xl font-mono text-xs focus:outline-none focus:border-cyan-500"
          />

          {depositSourceNote && (
            <div className="text-[11px] text-emerald-300 font-mono mt-1 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              <span>{depositSourceNote}</span>
            </div>
          )}

          <p className="text-[10px] text-amber-300/90 mt-1.5">
            Verify that <b>{exchange}</b> expects deposits on <b>{EVM_CHAINS.find((c) => c.id === chain)?.label || chain}</b> before sending. Sending tokens on an unsupported CEX network may require exchange recovery.
          </p>
        </div>

        {/* Optional Vault Signer Key if Vault address differs from server FLASH_ARB_SIGNER_KEY */}
        {!vaultBalances?.hasServerSignerForVault && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowSignerInput((v) => !v)}
              className="text-[11px] font-mono text-amber-300 hover:text-amber-200 flex items-center gap-1.5 cursor-pointer"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>
                {showSignerInput
                  ? 'Hide optional Vault Signer Key / Passphrase'
                  : 'Optional: Enter Profit Vault Private Key / Phrase for server broadcast (or leave blank to sign with MetaMask / Web3 Wallet)'}
              </span>
            </button>

            {showSignerInput && (
              <div className="mt-2 p-3 rounded-xl bg-slate-900/90 border border-amber-500/30 space-y-2 font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-amber-300">Vault Signer Key (Private Key / Phrase):</span>
                  <button
                    type="button"
                    onClick={handleGenerateTempSigner}
                    className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <span>✨ Generate Working Temp Signer</span>
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    value={sourcePrivateKey}
                    onChange={(e) => setSourcePrivateKey(e.target.value)}
                    placeholder="Vault EVM private key (0x...) or recovery phrase"
                    className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    value={sourcePassphrase}
                    onChange={(e) => setSourcePassphrase(e.target.value)}
                    placeholder="Optional BIP-39 / keystore passphrase"
                    className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                  />
                </div>
                {signerGasInfo?.signerAddress && (
                  <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-slate-950 border border-slate-800 text-[10px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-slate-400">Derived Signer:</span>
                      <span className="text-cyan-300 font-bold truncate select-all">{signerGasInfo.signerAddress}</span>
                      {signerGasInfo.signerAddress.toLowerCase() === (vaultBalances?.vaultAddress || activeVaultAddress).toLowerCase() ? (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                          MATCHES SOURCE
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                          ≠ DIFFERS FROM VAULT
                        </span>
                      )}
                    </div>
                    {signerGasInfo.signerAddress.toLowerCase() !== (vaultBalances?.vaultAddress || activeVaultAddress).toLowerCase() && (
                      <button
                        type="button"
                        onClick={() => {
                          setVaultSourceMode('CUSTOM');
                          setCustomVaultAddress(signerGasInfo.signerAddress);
                          setError(null);
                        }}
                        className="px-2 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-400/40 font-bold cursor-pointer"
                      >
                        Use Signer as Source Wallet
                      </button>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 font-sans">
                  💡 A private key can only broadcast on-chain if it controls the source vault (or holds ERC-20 <code className="text-cyan-300 font-mono">transferFrom</code> allowance) and holds gas ETH on {EVM_CHAINS.find((c) => c.id === chain)?.label || chain}. To sign directly from your browser without exposing keys, leave this blank and use MetaMask / Rabby.
                </p>
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !depositAddress.trim() || !amount.trim()}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-slate-950 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-all"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Executing Vault Transfer...</span>
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              <span>
                Transfer {amount || '0'} {currentAssetInfo?.symbol || selectedAsset} from Vault <ArrowRight className="inline h-3.5 w-3.5 mx-0.5" /> {exchange}
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default VaultToExchangeTransfer;
