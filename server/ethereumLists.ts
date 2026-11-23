import {
  DEFAULT_VERIFIED_RPC_POOLS,
  getEffectiveRpcPool,
  redactRpcUrlForDisplay,
} from './rpcSourceRegistry.ts';

export interface EthereumListChainMetadata {
  name: string;
  chain: string;
  icon: string;
  rpc: string[];
  faucets: string[];
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  infoURL: string;
  shortName: string;
  chainId: number;
  networkId: number;
  explorers?: Array<{
    name: string;
    url: string;
    standard: string;
  }>;
}

export const ETHEREUM_LISTS_CANONICAL_CHAINS: Record<string, EthereumListChainMetadata> = {
  ethereum: {
    name: 'Ethereum Mainnet',
    chain: 'ETH',
    icon: 'ethereum',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.ethereum],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://ethereum.org',
    shortName: 'eth',
    chainId: 1,
    networkId: 1,
    explorers: [{ name: 'etherscan', url: 'https://etherscan.io', standard: 'EIP3096' }],
  },
  arbitrum: {
    name: 'Arbitrum One',
    chain: 'ETH',
    icon: 'arbitrum',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.arbitrum],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://arbitrum.io',
    shortName: 'arb1',
    chainId: 42161,
    networkId: 42161,
    explorers: [{ name: 'Arbiscan', url: 'https://arbiscan.io', standard: 'EIP3096' }],
  },
  base: {
    name: 'Base',
    chain: 'ETH',
    icon: 'base',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.base],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://base.org',
    shortName: 'base',
    chainId: 8453,
    networkId: 8453,
    explorers: [{ name: 'basescan', url: 'https://basescan.org', standard: 'EIP3096' }],
  },
  optimism: {
    name: 'Op Mainnet',
    chain: 'ETH',
    icon: 'optimism',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.optimism],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://optimism.io',
    shortName: 'op',
    chainId: 10,
    networkId: 10,
    explorers: [{ name: 'optimistic.etherscan', url: 'https://optimistic.etherscan.io', standard: 'EIP3096' }],
  },
  polygon: {
    name: 'Polygon Mainnet',
    chain: 'Polygon',
    icon: 'polygon',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.polygon],
    faucets: [],
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    infoURL: 'https://polygon.technology',
    shortName: 'matic',
    chainId: 137,
    networkId: 137,
    explorers: [{ name: 'polygonscan', url: 'https://polygonscan.com', standard: 'EIP3096' }],
  },
  bsc: {
    name: 'BNB Smart Chain Mainnet',
    chain: 'BSC',
    icon: 'bsc',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.bsc],
    faucets: [],
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    infoURL: 'https://www.binance.org',
    shortName: 'bnb',
    chainId: 56,
    networkId: 56,
    explorers: [{ name: 'bscscan', url: 'https://bscscan.com', standard: 'EIP3096' }],
  },
  avalanche: {
    name: 'Avalanche C-Chain',
    chain: 'AVAX',
    icon: 'avalanche',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.avalanche],
    faucets: [],
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    infoURL: 'https://avalabs.org',
    shortName: 'avax',
    chainId: 43114,
    networkId: 43114,
    explorers: [{ name: 'snowtrace', url: 'https://snowtrace.io', standard: 'EIP3096' }],
  },
  linea: {
    name: 'Linea Mainnet',
    chain: 'ETH',
    icon: 'linea',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.linea],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://linea.build',
    shortName: 'linea',
    chainId: 59144,
    networkId: 59144,
    explorers: [{ name: 'lineascan', url: 'https://lineascan.build', standard: 'EIP3096' }],
  },
  scroll: {
    name: 'Scroll',
    chain: 'ETH',
    icon: 'scroll',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.scroll],
    faucets: [],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://scroll.io',
    shortName: 'scroll',
    chainId: 534352,
    networkId: 534352,
    explorers: [{ name: 'scrollscan', url: 'https://scrollscan.com', standard: 'EIP3096' }],
  },
  apechain: {
    name: 'ApeChain',
    chain: 'APE',
    icon: 'apechain',
    rpc: [...DEFAULT_VERIFIED_RPC_POOLS.apechain],
    faucets: [],
    nativeCurrency: { name: 'ApeCoin', symbol: 'APE', decimals: 18 },
    infoURL: 'https://apechain.com',
    shortName: 'ape',
    chainId: 33139,
    networkId: 33139,
    explorers: [{ name: 'apescan', url: 'https://apescan.io', standard: 'EIP3096' }],
  },
};

export function getEthereumListsChainData(chainKey: string): EthereumListChainMetadata | null {
  const normalized = String(chainKey || '').toLowerCase().trim();
  const base = ETHEREUM_LISTS_CANONICAL_CHAINS[normalized];
  if (!base) return null;
  const effectivePool = getEffectiveRpcPool(normalized).map(redactRpcUrlForDisplay);
  return {
    ...base,
    rpc: effectivePool.length > 0 ? effectivePool : base.rpc,
  };
}

export function getAllEthereumListsChains(): EthereumListChainMetadata[] {
  return Object.keys(ETHEREUM_LISTS_CANONICAL_CHAINS)
    .map((key) => getEthereumListsChainData(key))
    .filter((item): item is EthereumListChainMetadata => Boolean(item));
}
