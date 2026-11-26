export type ChainKey =
  | 'ethereum'
  | 'polygon'
  | 'bsc'
  | 'avalanche'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'linea'
  | 'scroll'
  | 'apechain';

export type BlockchainLayer = 'L1' | 'L2' | 'L3';
export type AllLayerFilter = 'ALL' | BlockchainLayer | 'L4';
export type FlashLoanProviderId = 'BALANCER_V2' | 'AAVE_V3' | 'UNISWAP_V3_FLASH';
export type GasOptimizationLevel = 'STANDARD' | 'HYPER_ALPHA' | 'ECO';

export interface ChainCatalogItem {
  key: ChainKey;
  name: string;
  shortName: string;
  layer: BlockchainLayer;
  chainIdHex: string;
  chainIdDec: number;
  explorer: string;
  defaultContract: string;
  icon: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  rpcUrl: string;
  balancerVault: string;
  aavePool: string;
  settlementModel: string;
  defaultPoolCountEstimate: number;
}

export interface ArbTokenConfig {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  category: 'Major' | 'LST / LRT' | 'Ecosystem' | 'DeFi' | 'Meme' | 'Stablecoin';
  defaultLoan: number;
  loanStep: number;
  maxLoan: number;
  typicalSpreadBps: number;
}

export interface SupportedDexPool {
  name: string;
  feeTier: string;
  chains: string[];
}

export interface FlashLoanProviderConfig {
  id: FlashLoanProviderId;
  name: string;
  feeBps: number;
  feePercent: number;
  badge: string;
  badgeColor: string;
  description: string;
}

export interface GasOptimizationProfile {
  label: string;
  badge: string;
  gasUnits: number;
  savingsPercent: number;
}

export const CHAIN_CONFIG_CATALOG: ChainCatalogItem[] = [
  {
    key: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    layer: 'L2',
    chainIdHex: '0xa4b1',
    chainIdDec: 42161,
    explorer: 'https://arbiscan.io',
    defaultContract: '',
    icon: '🔷',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    settlementModel: 'L2 Optimistic Nitro Rollup -> Ethereum L1',
    defaultPoolCountEstimate: 14,
  },
  {
    key: 'base',
    name: 'Base Mainnet',
    shortName: 'Base',
    layer: 'L2',
    chainIdHex: '0x2105',
    chainIdDec: 8453,
    explorer: 'https://basescan.org',
    defaultContract: '',
    icon: '🔵',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://mainnet.base.org',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    settlementModel: 'L2 Optimistic OP-Stack Rollup -> Ethereum L1',
    defaultPoolCountEstimate: 12,
  },
  {
    key: 'optimism',
    name: 'Optimism Mainnet',
    shortName: 'Optimism',
    layer: 'L2',
    chainIdHex: '0xa',
    chainIdDec: 10,
    explorer: 'https://optimistic.etherscan.io',
    defaultContract: '',
    icon: '🔴',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://mainnet.optimism.io',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    settlementModel: 'L2 Optimistic OP-Stack Bedrock -> Ethereum L1',
    defaultPoolCountEstimate: 10,
  },
  {
    key: 'ethereum',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    layer: 'L1',
    chainIdHex: '0x1',
    chainIdDec: 1,
    explorer: 'https://etherscan.io',
    defaultContract: '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D',
    icon: '⟠',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://eth.llamarpc.com',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    settlementModel: 'L1 Sovereign Proof-of-Stake Settlement',
    defaultPoolCountEstimate: 16,
  },
  {
    key: 'polygon',
    name: 'Polygon PoS',
    shortName: 'Polygon',
    layer: 'L1',
    chainIdHex: '0x89',
    chainIdDec: 137,
    explorer: 'https://polygonscan.com',
    defaultContract: '0xBBA273E057cDa31bB359d8AA8749256246B6d0cC',
    icon: '🟣',
    nativeSymbol: 'POL',
    wrappedNativeSymbol: 'WMATIC',
    rpcUrl: 'https://polygon-rpc.com',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    settlementModel: 'L1 High-Throughput Sidechain / Heimdall PoS',
    defaultPoolCountEstimate: 10,
  },
  {
    key: 'bsc',
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    layer: 'L1',
    chainIdHex: '0x38',
    chainIdDec: 56,
    explorer: 'https://bscscan.com',
    defaultContract: '',
    icon: '🟡',
    nativeSymbol: 'BNB',
    wrappedNativeSymbol: 'WBNB',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    settlementModel: 'L1 Parlia PoSA Consensus',
    defaultPoolCountEstimate: 10,
  },
  {
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    shortName: 'Avalanche',
    layer: 'L1',
    chainIdHex: '0xa86a',
    chainIdDec: 43114,
    explorer: 'https://snowtrace.io',
    defaultContract: '',
    icon: '🔺',
    nativeSymbol: 'AVAX',
    wrappedNativeSymbol: 'WAVAX',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    settlementModel: 'L1 Snowman Sub-Second Finality Consensus',
    defaultPoolCountEstimate: 8,
  },
  {
    key: 'linea',
    name: 'Linea zkEVM',
    shortName: 'Linea',
    layer: 'L2',
    chainIdHex: '0xe708',
    chainIdDec: 59144,
    explorer: 'https://lineascan.build',
    defaultContract: '',
    icon: '🟩',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://rpc.linea.build',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x0000000000000000000000000000000000000000',
    settlementModel: 'L2 Type-2 zkEVM Rollup -> Ethereum L1',
    defaultPoolCountEstimate: 6,
  },
  {
    key: 'scroll',
    name: 'Scroll zkEVM',
    shortName: 'Scroll',
    layer: 'L2',
    chainIdHex: '0x82750',
    chainIdDec: 534352,
    explorer: 'https://scrollscan.com',
    defaultContract: '',
    icon: '📜',
    nativeSymbol: 'ETH',
    wrappedNativeSymbol: 'WETH',
    rpcUrl: 'https://rpc.scroll.io',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    aavePool: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
    settlementModel: 'L2 Bytecode zkEVM Rollup -> Ethereum L1',
    defaultPoolCountEstimate: 6,
  },
  {
    key: 'apechain',
    name: 'ApeChain Orbit L3',
    shortName: 'ApeChain',
    layer: 'L3',
    chainIdHex: '0x8173',
    chainIdDec: 33139,
    explorer: 'https://apescan.io',
    defaultContract: '',
    icon: '🦍',
    nativeSymbol: 'APE',
    wrappedNativeSymbol: 'WAPE',
    rpcUrl: 'https://rpc.apechain.com/http',
    balancerVault: '0x0000000000000000000000000000000000000000',
    aavePool: '0x0000000000000000000000000000000000000000',
    settlementModel: 'L3 Arbitrum Orbit App-Chain -> Arbitrum L2 -> Ethereum L1',
    defaultPoolCountEstimate: 4,
  },
];

export const ARB_TOKENS: ArbTokenConfig[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, category: 'Major', defaultLoan: 25, loanStep: 1, maxLoan: 500, typicalSpreadBps: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 12 },
  { symbol: 'USDT', name: 'Tether USD', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 12 },
  { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, category: 'Major', defaultLoan: 2, loanStep: 0.25, maxLoan: 50, typicalSpreadBps: 16 },
  { symbol: 'ARB', name: 'Arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, category: 'Ecosystem', defaultLoan: 15000, loanStep: 500, maxLoan: 300000, typicalSpreadBps: 24 },
  { symbol: 'DAI', name: 'Dai Stablecoin', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 12 },
  { symbol: 'LINK', name: 'Chainlink', address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18, category: 'DeFi', defaultLoan: 1500, loanStep: 100, maxLoan: 30000, typicalSpreadBps: 22 },
  { symbol: 'UNI', name: 'Uniswap', address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', decimals: 18, category: 'DeFi', defaultLoan: 2500, loanStep: 100, maxLoan: 40000, typicalSpreadBps: 22 },
  { symbol: 'AAVE', name: 'Aave Token', address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', decimals: 18, category: 'DeFi', defaultLoan: 100, loanStep: 5, maxLoan: 2000, typicalSpreadBps: 25 },
  { symbol: 'GMX', name: 'GMX', address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', decimals: 18, category: 'DeFi', defaultLoan: 400, loanStep: 25, maxLoan: 8000, typicalSpreadBps: 28 },
  { symbol: 'PENDLE', name: 'Pendle', address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', decimals: 18, category: 'DeFi', defaultLoan: 3000, loanStep: 200, maxLoan: 50000, typicalSpreadBps: 28 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f', decimals: 18, category: 'LST / LRT', defaultLoan: 10, loanStep: 1, maxLoan: 200, typicalSpreadBps: 20 },
  { symbol: 'ezETH', name: 'Renzo Restaked ETH', address: '0x2416092f143378750bb29b79eD961ab195CcEea5', decimals: 18, category: 'LST / LRT', defaultLoan: 10, loanStep: 1, maxLoan: 200, typicalSpreadBps: 24 },
];

const EXTRA_CHAIN_TOKENS: Partial<Record<ChainKey, ArbTokenConfig[]>> = {
  base: [
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, category: 'Major', defaultLoan: 25, loanStep: 1, maxLoan: 500, typicalSpreadBps: 18 },
    { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 12 },
    { symbol: 'USDbC', name: 'USD Base Coin', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 14 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 14 },
    { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, category: 'LST / LRT', defaultLoan: 10, loanStep: 1, maxLoan: 200, typicalSpreadBps: 20 },
    { symbol: 'wstETH', name: 'Wrapped Lido Staked ETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18, category: 'LST / LRT', defaultLoan: 10, loanStep: 1, maxLoan: 200, typicalSpreadBps: 20 },
    { symbol: 'ezETH', name: 'Renzo Restaked ETH', address: '0x2416092f143378750bb29b79eD961ab195CcEea5', decimals: 18, category: 'LST / LRT', defaultLoan: 10, loanStep: 1, maxLoan: 200, typicalSpreadBps: 24 },
    { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, category: 'Major', defaultLoan: 2, loanStep: 0.25, maxLoan: 40, typicalSpreadBps: 18 },
    { symbol: 'AERO', name: 'Aerodrome', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, category: 'Ecosystem', defaultLoan: 10000, loanStep: 500, maxLoan: 200000, typicalSpreadBps: 26 },
    { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 14 },
    { symbol: 'DEGEN', name: 'Degen', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, category: 'Meme', defaultLoan: 250000, loanStep: 10000, maxLoan: 5000000, typicalSpreadBps: 35 },
    { symbol: 'VIRTUAL', name: 'Virtuals Protocol', address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', decimals: 18, category: 'DeFi', defaultLoan: 10000, loanStep: 500, maxLoan: 200000, typicalSpreadBps: 30 },
    { symbol: 'MORPHO', name: 'Morpho Token', address: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842', decimals: 18, category: 'DeFi', defaultLoan: 10000, loanStep: 500, maxLoan: 200000, typicalSpreadBps: 25 },
  ],
  ethereum: [
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, category: 'Major', defaultLoan: 50, loanStep: 1, maxLoan: 1000, typicalSpreadBps: 14 },
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, category: 'Stablecoin', defaultLoan: 50000, loanStep: 2500, maxLoan: 1000000, typicalSpreadBps: 10 },
    { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, category: 'Stablecoin', defaultLoan: 50000, loanStep: 2500, maxLoan: 1000000, typicalSpreadBps: 10 },
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, category: 'Major', defaultLoan: 3, loanStep: 0.5, maxLoan: 60, typicalSpreadBps: 14 },
  ],
  polygon: [
    { symbol: 'WMATIC', name: 'Wrapped POL', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, category: 'Ecosystem', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 22 },
    { symbol: 'USDC', name: 'USD Coin', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 14 },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, category: 'Major', defaultLoan: 20, loanStep: 1, maxLoan: 400, typicalSpreadBps: 18 },
  ],
  bsc: [
    { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, category: 'Ecosystem', defaultLoan: 40, loanStep: 2, maxLoan: 800, typicalSpreadBps: 18 },
    { symbol: 'USDT', name: 'Binance-Peg USDt', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 12 },
    { symbol: 'CAKE', name: 'PancakeSwap Token', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, category: 'DeFi', defaultLoan: 5000, loanStep: 250, maxLoan: 100000, typicalSpreadBps: 25 },
  ],
  avalanche: [
    { symbol: 'WAVAX', name: 'Wrapped AVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18, category: 'Ecosystem', defaultLoan: 600, loanStep: 25, maxLoan: 12000, typicalSpreadBps: 20 },
    { symbol: 'USDC', name: 'USD Coin', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, category: 'Stablecoin', defaultLoan: 25000, loanStep: 1000, maxLoan: 500000, typicalSpreadBps: 14 },
  ],
  apechain: [
    { symbol: 'WAPE', name: 'Wrapped APE', address: '0x48b62137EdfA95a428D35C09E44256a739F6B557', decimals: 18, category: 'Ecosystem', defaultLoan: 15000, loanStep: 500, maxLoan: 250000, typicalSpreadBps: 30 },
    { symbol: 'AUSD', name: 'Ape USD', address: '0xA2235d059F80e176D931Ef76b6C51953Eb3fBEf4', decimals: 6, category: 'Stablecoin', defaultLoan: 10000, loanStep: 500, maxLoan: 200000, typicalSpreadBps: 22 },
  ],
};

export function getChainTokenConfigs(chainKey: ChainKey): ArbTokenConfig[] {
  return EXTRA_CHAIN_TOKENS[chainKey] || ARB_TOKENS;
}

export const SUPPORTED_DEX_POOLS: SupportedDexPool[] = [
  { name: 'Uniswap V3 (0.05% Tick)', feeTier: '0.05%', chains: ['Arbitrum', 'Base', 'Optimism', 'Ethereum', 'Polygon', 'BSC', 'Avalanche', 'Scroll'] },
  { name: 'Uniswap V3 (0.30% Tick)', feeTier: '0.30%', chains: ['Arbitrum', 'Base', 'Optimism', 'Ethereum', 'Polygon', 'BSC', 'Avalanche', 'Scroll'] },
  { name: 'PancakeSwap V3', feeTier: '0.05%', chains: ['Arbitrum', 'Base', 'Ethereum', 'BSC', 'Linea'] },
  { name: 'SushiSwap V3', feeTier: '0.05%', chains: ['Arbitrum', 'Base', 'Optimism', 'Ethereum', 'Polygon', 'Avalanche', 'Linea', 'Scroll'] },
  { name: 'Camelot V3', feeTier: 'Dynamic', chains: ['Arbitrum', 'ApeChain'] },
  { name: 'Camelot V2', feeTier: '0.30%', chains: ['Arbitrum', 'ApeChain'] },
  { name: 'Aerodrome Slipstream', feeTier: '0.05%', chains: ['Base'] },
  { name: 'Velodrome Slipstream', feeTier: '0.05%', chains: ['Optimism'] },
  { name: 'Trader Joe V2', feeTier: '0.15%', chains: ['Arbitrum', 'Avalanche'] },
  { name: 'QuickSwap V3', feeTier: '0.05%', chains: ['Polygon'] },
];

export const FLASH_LOAN_PROVIDERS: FlashLoanProviderConfig[] = [
  {
    id: 'BALANCER_V2',
    name: 'Balancer V2 Vault',
    feeBps: 0,
    feePercent: 0.0,
    badge: '0.00% Fee Vault',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    description: 'Zero-fee multi-asset flash loan vault',
  },
  {
    id: 'AAVE_V3',
    name: 'Aave V3 Pool',
    feeBps: 5,
    feePercent: 0.05,
    badge: '0.05% Institutional',
    badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    description: 'Deep cross-chain flash loan liquidity',
  },
  {
    id: 'UNISWAP_V3_FLASH',
    name: 'Uniswap V3 Flash',
    feeBps: 5,
    feePercent: 0.05,
    badge: '0.05% Pool Flash',
    badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
    description: 'Direct pool flash swap borrowing',
  },
];

export const GAS_OPTIMIZATION_PROFILES: Record<GasOptimizationLevel, GasOptimizationProfile> = {
  HYPER_ALPHA: {
    label: 'Hyper-Alpha EIP-1153 (Transient)',
    badge: 'EIP-1153 (-28% Gas)',
    gasUnits: 165_000,
    savingsPercent: 28,
  },
  ECO: {
    label: 'Eco Tight Packing',
    badge: 'Calldata Opt (-18% Gas)',
    gasUnits: 190_000,
    savingsPercent: 18,
  },
  STANDARD: {
    label: 'Standard ERC-20 Path',
    badge: 'Baseline',
    gasUnits: 230_000,
    savingsPercent: 0,
  },
};

export const FLASH_ARB_FILES: Record<string, { path: string; lang: string; code: string }> = {
  'FlashArbOptimized.sol': {
    path: 'flash-arb/contracts/src/FlashArbOptimized.sol',
    lang: 'solidity',
    code: '// See repository file: flash-arb/contracts/src/FlashArbOptimized.sol\n// Cancun EIP-1153 transient storage + Balancer V2 / Aave V3 / Uniswap V3 flash arbitrage executor.',
  },
  'CamelotV3SwapAdapter.sol': {
    path: 'flash-arb/contracts/src/CamelotV3SwapAdapter.sol',
    lang: 'solidity',
    code: '// See repository file: flash-arb/contracts/src/CamelotV3SwapAdapter.sol\n// Algebra / Camelot V3 single-hop swap adapter for Arbitrum One.',
  },
  'arbitrum.toml': {
    path: 'flash-arb/searcher/config/arbitrum.toml',
    lang: 'toml',
    code: '[chain]\nname = "arbitrum"\nchain_id = 42161\nmin_profit_usd = 0.25\nmax_gas_gwei = 0.25\n',
  },
  'base.toml': {
    path: 'flash-arb/searcher/config/base.toml',
    lang: 'toml',
    code: '[chain]\nname = "base"\nchain_id = 8453\nmin_profit_usd = 0.25\nmax_gas_gwei = 0.25\n',
  },
  'optimism.toml': {
    path: 'flash-arb/searcher/config/optimism.toml',
    lang: 'toml',
    code: '[chain]\nname = "optimism"\nchain_id = 10\nmin_profit_usd = 0.25\nmax_gas_gwei = 0.25\n',
  },
};
