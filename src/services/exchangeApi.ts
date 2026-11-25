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


