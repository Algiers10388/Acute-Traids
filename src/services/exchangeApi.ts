import { ExchangeHealthCheckSummary, ExchangeId, ExchangeWallet, ExchangeWalletTransaction } from '../types';

export async function fetchExchangeWallets(): Promise<{
  wallets: Record<ExchangeId, ExchangeWallet>;
  timestamp: number;
}> {
  const res = await fetch('/api/exchange/wallets');
  if (!res.ok) {
    throw new Error('Failed to retrieve exchange wallets');
  }
  const data = await res.json();
  return { wallets: data.wallets, timestamp: data.timestamp };
}

export async function linkExchangeWallet(params: {
  exchange: ExchangeId;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  depositAddress?: string;
  walletLabel?: string;
}): Promise<{
  success: boolean;
  exchange: ExchangeId;
  isLinked: boolean;
  connectionVerified: boolean;
  verificationMessage: string;
  apiKeyMasked?: string;
}> {
  const res = await fetch('/api/exchange/link-wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Failed to link ${params.exchange} wallet`);
  }
  return data;
}

export async function unlinkExchangeWallet(exchange: ExchangeId): Promise<boolean> {
  const res = await fetch('/api/exchange/unlink-wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange }),
  });
  const data = await res.json();
  return data.success;
}

export async function executeWalletTransaction(params: {
  exchange: ExchangeId;
  type: 'BUY_ORDER' | 'SELL_ORDER' | 'WALLET_WITHDRAWAL' | 'WALLET_TRANSFER';
  symbolOrAsset: string;
  amount: number;
  price?: number;
  destinationAddress?: string;
}): Promise<{
  success: boolean;
  transaction: ExchangeWalletTransaction;
}> {
  const res = await fetch('/api/exchange/wallet-transaction', {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new Error('Network error reading exchange response');
  }
  let data: any = null;
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      if (text.includes('__cookie_check') || text.includes('Action required to load your app')) {
        throw new Error('Browser security cookie blocked in iframe. Please allow third-party cookies or open the app in a new window.');
      }
      throw new Error(
        res.status >= 500
          ? 'Exchange transaction gateway is busy. Please try again.'
          : res.status === 200
            ? 'Gateway session is synchronizing. Please retry.'
            : `Server returned an unexpected response (HTTP ${res.status}).`
      );
    }
  }
  if (!res.ok || !data || !data.success) {
    throw new Error((data && data.error) || 'Failed to execute exchange wallet transaction');
  }
  return data;
}

export async function fetchWalletTransactions(): Promise<ExchangeWalletTransaction[]> {
  try {
    const res = await fetch('/api/exchange/wallet-transactions');
    if (!res.ok) return [];
    const data = await res.json();
    return data.transactions || [];
  } catch {
    return [];
  }
}

export async function fetchExchangeHealthCheck(): Promise<ExchangeHealthCheckSummary> {
  const res = await fetch('/api/exchange/health-check');
  if (!res.ok) {
    throw new Error(`Health check probe failed with status HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error || 'Failed to complete exchange API health check');
  }
  return data.healthSummary;
}

export interface VaultTokenHolding {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  rawBalance: string;
  hasBalance: boolean;
  usdValue: number | null;
}

export interface VaultChainBalances {
  success: boolean;
  chain: string;
  chainName: string;
  chainId: number;
  chainIdHex: string;
  explorer: string;
  vaultAddress: string;
  isSmartContract?: boolean;
  contractOwner?: string | null;
  canContractRescue?: boolean;
  hasRescueTokensTo?: boolean;
  hasDirectFlashArb?: boolean;
  knownContractForChain?: string | null;
  profitVaultDefault: string;
  gasWalletDefault: string | null;
  hasServerSignerForVault: boolean;
  serverSignerAddress: string | null;
  native: {
    symbol: string;
    balance: string;
    rawWei: string;
    usdValue: number | null;
  };
  tokens: VaultTokenHolding[];
  totalUsd: number;
  timestamp: number;
  chainMismatchNotice?: string | null;
  suggestedChain?: string;
  arbitrumEquivalent?: string;
}

export interface ExchangeDepositAddressResult {
  success: boolean;
  exchange: ExchangeId;
  chain: string;
  asset: string;
  depositAddress: string | null;
  source: 'EXCHANGE_API' | 'LINKED_WALLET_ADDRESS' | null;
  method: string | null;
  addresses: Array<{ address: string; method?: string; new?: boolean }>;
  requiresAddressOrKeys?: boolean;
  hint?: string;
  error?: string;
}

export interface VaultExchangeTransferResult {
  success: boolean;
  mode: 'BROADCASTED' | 'UNSIGNED_TX';
  requiresWalletSigning?: boolean;
  signerRequired?: string;
  chain: string;
  chainName: string;
  exchange: string;
  sourceVaultAddress: string;
  depositAddress: string;
  asset: string;
  tokenAddress?: string;
  amount: string;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: string;
  explorerUrl?: string;
  transaction?: ExchangeWalletTransaction;
  unsignedTx?: {
    from: string;
    to: string;
    value: string;
    data: string;
    gas: string;
    chainId: number;
    chainIdHex: string;
  };
  message: string;
}

async function parseApiJson(res: Response, fallback: string) {
  const text = await res.text();
  let data: any = {};
  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response from gateway (HTTP ${res.status}).`);
    }
  }
  if (!res.ok || data?.success === false) {
    const err: any = new Error(data?.error || data?.message || `${fallback} (HTTP ${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function fetchExchangeDepositAddress(params: {
  exchange: string;
  asset: string;
  chain: string;
  createNew?: boolean;
}): Promise<ExchangeDepositAddressResult> {
  const qs = new URLSearchParams({
    exchange: params.exchange,
    asset: params.asset,
    chain: params.chain,
    ...(params.createNew ? { createNew: '1' } : {}),
  });
  const res = await fetch(`/api/exchange/deposit-address?${qs.toString()}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, `Failed to fetch ${params.exchange} deposit address`);
}

export async function fetchVaultChainBalances(params: {
  chain: string;
  vaultAddress?: string;
  extraTokens?: string[];
}): Promise<VaultChainBalances> {
  const qs = new URLSearchParams({
    chain: params.chain,
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
    ...(params.extraTokens?.length ? { extraTokens: params.extraTokens.join(',') } : {}),
  });
  const res = await fetch(`/api/flash-arb/vault/balances?${qs.toString()}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, 'Failed to query Vault balances');
}

export async function transferVaultToExchange(payload: {
  chain: string;
  exchange: string;
  sourceVaultAddress: string;
  depositAddress: string;
  assetSymbol: string;
  tokenAddress?: string;
  amount: string;
  sourcePrivateKey?: string;
  sourcePassphrase?: string;
}): Promise<VaultExchangeTransferResult> {
  const res = await fetch('/api/flash-arb/vault/transfer-to-exchange', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Vault-to-exchange transfer failed');
}

export async function confirmVaultTransferTx(payload: {
  chain: string;
  txHash: string;
  exchange: string;
  sourceVaultAddress: string;
  depositAddress: string;
  assetSymbol: string;
  amount: string;
}): Promise<{
  success: boolean;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  explorerUrl: string;
  transaction: ExchangeWalletTransaction;
  message: string;
}> {
  const res = await fetch('/api/flash-arb/vault/transfer-confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Could not confirm transaction on-chain');
}
export interface VaultSignerGasInfo {
  success: boolean;
  chain: string;
  chainName: string;
  chainId: number;
  chainIdHex: string;
  explorer: string;
  nativeSymbol: string;
  signerAddress: string;
  balanceWei: string;
  balanceFormatted: string;
  gasPriceGwei: string;
  recommendedTopUp: string;
  hasServerFundingSigner: boolean;
  serverSignerAddress: string | null;
  serverSignerBalanceFormatted: string;
  canServerFund: boolean;
  timestamp: number;
}

export async function resolveVaultSignerInfo(payload: {
  chain: string;
  signerAddress?: string;
  privateKey?: string;
  passphrase?: string;
}): Promise<VaultSignerGasInfo> {
  const res = await fetch('/api/flash-arb/vault/resolve-signer-info', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Failed to resolve signer gas balance');
}

export async function fundVaultSignerGas(payload: {
  chain: string;
  targetAddress: string;
  amount: string;
}): Promise<{
  success: boolean;
  chain: string;
  chainName: string;
  from: string;
  to: string;
  asset: string;
  amount: string;
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
  message: string;
}> {
  const res = await fetch('/api/flash-arb/vault/fund-signer-gas', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Failed to fund gas from server Gas Wallet');
}

export interface ContractRescueFunctionItem {
  name: string;
  signature: string;
  selector: string;
  source: 'ABI' | 'BYTECODE';
  paramTypes: string[];
  paramRoles: Array<'TOKEN' | 'RECIPIENT' | 'AMOUNT' | 'OTHER'>;
  directToRecipient: boolean;
  supportsToken: boolean;
  supportsNative: boolean;
  requiresOwnerFollowUpTransfer: boolean;
  encodable: boolean;
  priorityScore: number;
}

export interface ContractRescueStepItem {
  id: string;
  stepIndex: number;
  actionType: 'CONTRACT_RESCUE_DIRECT' | 'CONTRACT_RESCUE_TO_OWNER' | 'OWNER_FORWARD_TRANSFER';
  functionName: string;
  functionSignature: string;
  selector: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  amountWei: string;
  amountFormatted: string;
  usdValue: number | null;
  targetContract: string;
  from: string;
  to: string;
  recipient: string;
  calldata: string;
  estimatedGasUnits: string;
  estimatedGasCostWei: string;
  estimatedGasCostEth: string;
  estimatedGasCostUsd: number | null;
  singleTxToProfitVault: boolean;
  status: 'PLANNED' | 'SKIPPED_DUST' | 'UNSUPPORTED_ASSET' | 'SIMULATION_FAILED';
  reason?: string;
}

export interface ContractRescueScanResult {
  success: boolean;
  chain: string;
  chainName: string;
  chainId: number;
  chainIdHex: string;
  explorer: string;
  rpcUsed: string;
  nativeSymbol: string;
  contractAddress: string;
  destinationWallet: string;
  isProfitVaultDefault: boolean;
  contractOwner: string | null;
  ownerSource: string | null;
  ownershipProbes: Array<{
    getter: string;
    selector: string;
    ownerAddress: string | null;
  }>;
  ownerGasBalanceWei: string;
  ownerGasBalanceFormatted: string;
  hasSufficientOwnerGas: boolean;
  hasMatchingServerSigner: boolean;
  serverSignerAddress: string | null;
  abiSource: 'USER_PROVIDED' | 'ETHERSCAN_VERIFIED' | 'BYTECODE_ONLY';
  abiFetchNote: string | null;
  detectedFunctions: ContractRescueFunctionItem[];
  trappedAssets: Array<{
    symbol: string;
    address: string | null;
    decimals: number;
    rawBalance: string;
    formattedBalance: string;
    usdValue: number | null;
    isNative: boolean;
  }>;
  optimalGas: {
    baseFeeGwei: string | null;
    maxFeePerGasWei: string;
    maxFeePerGasGwei: string;
    maxPriorityFeePerGasWei: string;
    maxPriorityFeePerGasGwei: string;
  };
  plan: {
    contractAddress: string;
    contractOwner: string | null;
    profitWallet: string;
    gasOptimizationStrategy: string;
    executableSteps: ContractRescueStepItem[];
    skippedSteps: ContractRescueStepItem[];
    totalEstimatedGasUnits: string;
    totalEstimatedGasCostWei: string;
    totalEstimatedGasCostEth: string;
    totalEstimatedGasCostUsd: number | null;
    totalRecoverableUsd: number;
    gasSavedByDirectCallUnits: string;
  };
  timestamp: number;
}

export interface ContractRescueExecuteResult {
  success: boolean;
  mode: 'BROADCASTED' | 'UNSIGNED_TX';
  requiresWalletSigning?: boolean;
  signerRequired?: string;
  chain: string;
  chainName: string;
  contractAddress: string;
  contractOwner: string;
  destinationWallet: string;
  executedTxs?: Array<{
    stepIndex: number;
    actionType: string;
    functionSignature: string;
    tokenSymbol: string;
    amountFormatted: string;
    txHash: string;
    blockNumber: number;
    gasUsed: string;
    explorerUrl: string;
  }>;
  unsignedTxs?: Array<{
    stepIndex: number;
    actionType: string;
    functionSignature: string;
    tokenSymbol: string;
    amountFormatted: string;
    from: string;
    to: string;
    value: string;
    data: string;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    chainId: number;
    chainIdHex: string;
  }>;
  scan: ContractRescueScanResult;
  message: string;
}

export async function scanContractRescueAgent(payload: {
  chain: string;
  contractAddress?: string;
  destinationWallet?: string;
  abi?: string;
  extraTokens?: string[];
  skipGasNegativeDust?: boolean;
}): Promise<ContractRescueScanResult> {
  const res = await fetch('/api/flash-arb/contract-rescue-agent/scan', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Automated contract rescue scan failed');
}

export async function executeContractRescueAgent(payload: {
  chain: string;
  contractAddress?: string;
  destinationWallet?: string;
  abi?: string;
  extraTokens?: string[];
  skipGasNegativeDust?: boolean;
  privateKey?: string;
  passphrase?: string;
}): Promise<ContractRescueExecuteResult> {
  const res = await fetch('/api/flash-arb/contract-rescue-agent/execute', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Automated contract rescue execution failed');
}

export async function confirmContractRescueTx(payload: {
  chain: string;
  txHash: string;
}): Promise<{
  success: boolean;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  explorerUrl: string;
  message: string;
}> {
  const res = await fetch('/api/flash-arb/contract-rescue-agent/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, 'Could not confirm recovery transaction');
}

