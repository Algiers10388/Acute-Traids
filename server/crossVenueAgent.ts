import { ethers } from 'ethers';
import {
  CAMELOT_V2_ROUTER_ADDRESS,
  CAMELOT_V3_ROUTER_ADDRESS,
  CHAIN_LAYER_META,
  CHAIN_TOKENS,
  LYNEX_V3_ROUTER_ADDRESS,
  QUICKSWAP_V3_ROUTER_ADDRESS,
  decodeFlashArbRevertError,
  encodeErc20Transfer,
  getEffectiveChainDexRouters,
  toTokenUnits,
  type ArbitrumTokenInfo,
  type BlockchainLayer,
  type RouterCapabilityOptions,
  type SupportedArbChain,
} from './flashArbExecutor.ts';

export interface DualVenueCorridorOpportunity {
  id: string;
  asset: string;
  buyChain: SupportedArbChain;
  buyLayer: BlockchainLayer;
  buyChainName: string;
  buyDex: string;
  buyPair: string;
  buyPool: string;
  buyPriceUsd: number;
  buyFeePercent?: number;
  sellChain: SupportedArbChain;
  sellLayer: BlockchainLayer;
  sellChainName: string;
  sellDex: string;
  sellPair: string;
  sellPool: string;
  sellPriceUsd: number;
  sellFeePercent?: number;
  layerCorridor: string;
  grossSpreadBps: number;
  dexAndBridgeCostBps: number;
  netSpreadBps: number;
  recommendedClipUsd: number;
  estNetProfitUsd: number;
  isProfitable: boolean;
  executionMode?: string;
  note?: string;
}

export interface DualVenueExecutedTrade {
  id: string;
  timestamp: number;
  corridorId: string;
  asset: string;
  layerCorridor: string;
  buyChain: SupportedArbChain;
  buyDex: string;
  buyAdapter?: SwapRouterFlavor;
  sellChain: SupportedArbChain;
  sellDex: string;
  sellAdapter?: SwapRouterFlavor;
  clipUsd: number;
  buyTxHash: string;
  sellTxHash: string;
  profitSweepTxHash: string | null;
  profitRecipient: string;
  realizedProfitUsd: number;
  realizedProfitToken: string;
  realizedProfitAmount: string;
  status: 'CONFIRMED' | 'PARTIAL_SETTLED';
  executionPath: 'DUAL_VENUE_DIRECT' | 'FLASH_LOAN_FALLBACK';
}

export interface DualVenueAgentState {
  enabled: boolean;
  agentState: 'IDLE' | 'MONITORING' | 'EXECUTING' | 'PROFIT_SWEPT' | 'AWAITING_INVENTORY';
  minNetProfitUsd: number;
  maxClipUsd: number;
  allowFlashLoanFallback: boolean;
  lastRunAt: number;
  lastNotice: string | null;
  totalRealizedProfitUsd: number;
  executedTrades: DualVenueExecutedTrade[];
}

export type SwapRouterFlavor =
  | 'UNIV3_V1'
  | 'UNIV3_ROUTER02'
  | 'SLIPSTREAM'
  | 'ALGEBRA'
  | 'UNIV2'
  | 'CAMELOT_V2';

export interface ResolvedVenueSwapSpec {
  chain: SupportedArbChain;
  dex: string;
  routerAddress: string;
  flavor: SwapRouterFlavor;
  feeUnits: number;
  tickSpacing?: number;
  baseToken: ArbitrumTokenInfo;
  quoteToken: ArbitrumTokenInfo;
}

export type VenueSwapResolution =
  | { ok: true; spec: ResolvedVenueSwapSpec }
  | { ok: false; reason: 'TOKEN_NOT_FOUND' | 'ROUTER_UNSUPPORTED'; message: string };

/**
 * Direct EOA Periphery Router Adapters verified on-chain (electromagnetically checked bytecode & factory()):
 * Unlike `FlashArbOptimized` on-chain contract `exec()`, Dual-Venue Corridor execution dispatches directly
 * from the signer EOA so Slipstream (`int24 tickSpacing`), Algebra (no `fee`), and Camelot V2 (6-arg referrer)
 * are natively supported via software ABI adapters.
 */
export const DIRECT_VENUE_ROUTER_ADAPTERS: Partial<
  Record<SupportedArbChain, Record<string, { router: string; isV3: boolean; flavor: SwapRouterFlavor }>>
> = {
  base: {
    // Base Aerodrome Slipstream SwapRouter (verified selector 0xa026383e, factory 0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a)
    'Aerodrome Slipstream': {
      router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
      isV3: true,
      flavor: 'SLIPSTREAM',
    },
  },
  optimism: {
    // Optimism Velodrome Slipstream SwapRouter (verified selector 0xa026383e, factory 0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F)
    'Velodrome Slipstream': {
      router: '0x0792a633F0c19c351081CF4B211F68F79bCc9676',
      isV3: true,
      flavor: 'SLIPSTREAM',
    },
  },
  arbitrum: {
    // Arbitrum Camelot V3 Algebra SwapRouter (verified selector 0xbc651188)
    'Camelot V3': {
      router: CAMELOT_V3_ROUTER_ADDRESS,
      isV3: true,
      flavor: 'ALGEBRA',
    },
    // Arbitrum Camelot V2 Router (verified getAmountsOut 0xd06ca61f + 6-arg swapExactTokensForTokensSupportingFeeOnTransferTokens 0xac3893ba)
    'Camelot V2': {
      router: CAMELOT_V2_ROUTER_ADDRESS,
      isV3: false,
      flavor: 'CAMELOT_V2',
    },
  },
  polygon: {
    // Polygon QuickSwap V3 Algebra SwapRouter (verified selector 0xbc651188)
    'QuickSwap V3': {
      router: QUICKSWAP_V3_ROUTER_ADDRESS,
      isV3: true,
      flavor: 'ALGEBRA',
    },
  },
  linea: {
    // Linea Lynex V3 Algebra SwapRouter (verified selector 0xbc651188)
    'Lynex V3': {
      router: LYNEX_V3_ROUTER_ADDRESS,
      isV3: true,
      flavor: 'ALGEBRA',
    },
  },
  apechain: {
    // ApeChain Camelot V3 Algebra SwapRouter (verified selector 0xbc651188, factory 0x10aA510d94E094Bd643677bd2964c3EE085Daffc)
    'Camelot V3': {
      router: '0xC69Dc28924930583024E067b2B3d773018F4EB52',
      isV3: true,
      flavor: 'ALGEBRA',
    },
  },
};

const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export function extractReceivedErc20AmountFromLogs(
  logs: Array<{ address?: string; topics: string[]; data: string }> | undefined,
  tokenAddress: string,
  recipientAddress: string
): bigint | null {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  const targetToken = tokenAddress.toLowerCase();
  const targetRecipient = recipientAddress.toLowerCase();
  let total = 0n;
  let matched = false;
  for (const log of logs) {
    if (log.address && log.address.toLowerCase() !== targetToken) continue;
    try {
      const parsed = ERC20_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === 'Transfer') {
        const toAddr = String(parsed.args.to || '').toLowerCase();
        if (toAddr === targetRecipient) {
          total += BigInt(parsed.args.value);
          matched = true;
        }
      }
    } catch {
      // ignore non-ERC20 Transfer logs
    }
  }
  return matched ? total : null;
}

const UNIV3_ROUTER_V1_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const UNIV3_ROUTER02_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const SLIPSTREAM_ROUTER_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const SLIPSTREAM_POOL_IFACE = new ethers.Interface([
  'function tickSpacing() view returns (int24)',
]);

const ALGEBRA_ROUTER_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) payable returns (uint256 amountOut)',
]);

const UNIV2_ROUTER_IFACE = new ethers.Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const CAMELOT_V2_ROUTER_IFACE = new ethers.Interface([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline)',
]);

const STABLE_SYMBOLS = new Set(['USDC', 'USDC.E', 'USDBC', 'USDT', 'DAI', 'FRAX', 'USDE', 'APEUSD']);

export function normalizeTokenKey(sym: string): string {
  return String(sym || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function detectSwapRouterFlavor(chain: SupportedArbChain, dex: string, isV3: boolean): SwapRouterFlavor {
  const lower = dex.toLowerCase();
  if (!isV3) {
    if (/camelot/i.test(lower)) return 'CAMELOT_V2';
    return 'UNIV2';
  }
  if (/slipstream/i.test(lower)) return 'SLIPSTREAM';
  if (/camelot|quickswap v3|lynex/i.test(lower)) return 'ALGEBRA';
  // SwapRouter02 deployments (exactInputSingle selector 0x04e45aaf, no deadline field in struct)
  if (
    /uniswap v3/i.test(lower) &&
    (chain === 'base' || chain === 'bsc' || chain === 'avalanche' || chain === 'linea' || chain === 'scroll')
  ) {
    return 'UNIV3_ROUTER02';
  }
  return 'UNIV3_V1';
}

export function inferFeeUnitsFromDex(dex: string, poolFeePercent?: number): number {
  if (typeof poolFeePercent === 'number' && Number.isFinite(poolFeePercent) && poolFeePercent > 0) {
    return Math.round(poolFeePercent * 10000);
  }
  const m = dex.match(/([\d.]+)%/);
  if (m) {
    return Math.round(parseFloat(m[1]) * 10000);
  }
  if (/pancake/i.test(dex)) return 500;
  return 500;
}

export function inferSlipstreamTickSpacing(poolFeePercent?: number): number {
  if (typeof poolFeePercent === 'number' && Number.isFinite(poolFeePercent) && poolFeePercent > 0) {
    if (poolFeePercent <= 0.015) return 1;
    if (poolFeePercent <= 0.06) return 10;
    if (poolFeePercent <= 0.2) return 50;
    if (poolFeePercent <= 0.4) return 60;
    if (poolFeePercent <= 1.0) return 200;
  }
  return 100;
}

export function decodeTickSpacingResult(rawHex: string): number | null {
  if (!rawHex || rawHex === '0x') return null;
  try {
    const [spacing] = SLIPSTREAM_POOL_IFACE.decodeFunctionResult('tickSpacing', rawHex);
    const val = Number(spacing);
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch {
    return null;
  }
}

export function resolvePairTokensForChain(
  chain: SupportedArbChain,
  pair: string
): { baseToken: ArbitrumTokenInfo; quoteToken: ArbitrumTokenInfo } | null {
  const tokensMap = CHAIN_TOKENS[chain] || {};
  const tokensEntries = Object.entries(tokensMap);
  const rawParts = String(pair || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawParts.length !== 2) return null;

  const findTok = (rawSym: string): ArbitrumTokenInfo | undefined => {
    if (tokensMap[rawSym]) return tokensMap[rawSym];
    const upper = rawSym.toUpperCase();
    const norm = normalizeTokenKey(rawSym);
    // 1. Exact case-insensitive key or display symbol match
    const exactMatch = tokensEntries.find(
      ([k, t]) => k.toUpperCase() === upper || t.sym.toUpperCase() === upper
    );
    if (exactMatch) return exactMatch[1];
    // 2. Punctuation/separator-agnostic match (handles BTCb <-> BTC.b, USDCe <-> USDC.e, USDbC <-> USDBC, etc.)
    const normMatch = tokensEntries.find(
      ([k, t]) => normalizeTokenKey(k) === norm || normalizeTokenKey(t.sym) === norm
    );
    return normMatch?.[1];
  };

  const baseToken = findTok(rawParts[0]);
  const quoteToken = findTok(rawParts[1]);
  if (!baseToken || !quoteToken || baseToken.addr.toLowerCase() === quoteToken.addr.toLowerCase()) {
    return null;
  }
  return { baseToken, quoteToken };
}

export function resolveVenueSwapSpecWithDiagnostic(params: {
  chain: SupportedArbChain;
  dex: string;
  pair: string;
  feePercent?: number;
  routerCaps?: RouterCapabilityOptions;
}): VenueSwapResolution {
  const tokens = resolvePairTokensForChain(params.chain, params.pair);
  if (!tokens) {
    return {
      ok: false,
      reason: 'TOKEN_NOT_FOUND',
      message: `Pair tokens "${params.pair}" could not be resolved in ${params.chain} token registry.`,
    };
  }

  const cleanDex = params.dex.split('(')[0].trim();
  const chainAdapters = DIRECT_VENUE_ROUTER_ADAPTERS[params.chain];
  const directAdapter =
    chainAdapters?.[params.dex] ||
    chainAdapters?.[cleanDex] ||
    (chainAdapters
      ? Object.entries(chainAdapters).find(([k]) => k.toLowerCase() === cleanDex.toLowerCase())?.[1]
      : undefined);

  if (directAdapter) {
    const flavor = directAdapter.flavor;
    return {
      ok: true,
      spec: {
        chain: params.chain,
        dex: params.dex,
        routerAddress: directAdapter.router,
        flavor,
        feeUnits: inferFeeUnitsFromDex(params.dex, params.feePercent),
        tickSpacing: flavor === 'SLIPSTREAM' ? inferSlipstreamTickSpacing(params.feePercent) : undefined,
        baseToken: tokens.baseToken,
        quoteToken: tokens.quoteToken,
      },
    };
  }

  const routers = getEffectiveChainDexRouters(params.chain, params.routerCaps);
  const entry =
    routers[params.dex] ||
    routers[cleanDex] ||
    Object.entries(routers).find(([k]) => k.toLowerCase() === cleanDex.toLowerCase())?.[1];

  if (!entry || !entry.supported || !entry.router) {
    return {
      ok: false,
      reason: 'ROUTER_UNSUPPORTED',
      message: `Venue "${params.dex}" on ${params.chain} does not expose a compatible standalone SwapRouter adapter (e.g. RouteProcessor-only). Choose an adapted corridor.`,
    };
  }

  const flavor = detectSwapRouterFlavor(params.chain, params.dex, entry.isV3);
  return {
    ok: true,
    spec: {
      chain: params.chain,
      dex: params.dex,
      routerAddress: entry.router,
      flavor,
      feeUnits: inferFeeUnitsFromDex(params.dex, params.feePercent),
      tickSpacing: flavor === 'SLIPSTREAM' ? inferSlipstreamTickSpacing(params.feePercent) : undefined,
      baseToken: tokens.baseToken,
      quoteToken: tokens.quoteToken,
    },
  };
}

export function resolveVenueSwapSpec(params: {
  chain: SupportedArbChain;
  dex: string;
  pair: string;
  feePercent?: number;
  routerCaps?: RouterCapabilityOptions;
}): ResolvedVenueSwapSpec | null {
  const res = resolveVenueSwapSpecWithDiagnostic(params);
  return res.ok ? res.spec : null;
}

export function encodeVenueSwapCalldata(params: {
  flavor: SwapRouterFlavor;
  tokenIn: string;
  tokenOut: string;
  feeUnits: number;
  tickSpacing?: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadlineSec?: number;
}): string {
  const deadline = BigInt(params.deadlineSec ?? Math.floor(Date.now() / 1000) + 180);
  if (params.flavor === 'UNIV3_ROUTER02') {
    return UNIV3_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.feeUnits,
        recipient: params.recipient,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ]);
  }
  if (params.flavor === 'SLIPSTREAM') {
    return SLIPSTREAM_ROUTER_IFACE.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tickSpacing: params.tickSpacing ?? 100,
        recipient: params.recipient,
        deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ]);
  }
  if (params.flavor === 'ALGEBRA') {
    return ALGEBRA_ROUTER_IFACE.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        recipient: params.recipient,
        deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        limitSqrtPrice: 0n,
      },
    ]);
  }
  if (params.flavor === 'CAMELOT_V2') {
    return CAMELOT_V2_ROUTER_IFACE.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens', [
      params.amountIn,
      params.amountOutMinimum,
      [params.tokenIn, params.tokenOut],
      params.recipient,
      ethers.ZeroAddress,
      deadline,
    ]);
  }
  if (params.flavor === 'UNIV2') {
    return UNIV2_ROUTER_IFACE.encodeFunctionData('swapExactTokensForTokens', [
      params.amountIn,
      params.amountOutMinimum,
      [params.tokenIn, params.tokenOut],
      params.recipient,
      deadline,
    ]);
  }
  return UNIV3_ROUTER_V1_IFACE.encodeFunctionData('exactInputSingle', [
    {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.feeUnits,
      recipient: params.recipient,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    },
  ]);
}

/**
 * Builds preflight `eth_call` simulation calldata. For flavors whose swap function returns `amountOut`
 * or `amounts[]` (UniV3 V1/02, Slipstream, Algebra, UniV2), simulates the exact swap call directly;
 * for Camelot V2 whose fee-on-transfer swap returns `void`, queries `getAmountsOut(amountIn, path)`.
 */
export function encodeVenueQuoteCalldata(params: {
  flavor: SwapRouterFlavor;
  tokenIn: string;
  tokenOut: string;
  feeUnits: number;
  tickSpacing?: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadlineSec?: number;
}): string {
  if (params.flavor === 'CAMELOT_V2') {
    return CAMELOT_V2_ROUTER_IFACE.encodeFunctionData('getAmountsOut', [
      params.amountIn,
      [params.tokenIn, params.tokenOut],
    ]);
  }
  return encodeVenueSwapCalldata(params);
}

export function decodeVenueSwapOutput(flavor: SwapRouterFlavor, rawHex: string): bigint {
  if (!rawHex || rawHex === '0x') return 0n;
  if (flavor === 'CAMELOT_V2') {
    const [amounts] = CAMELOT_V2_ROUTER_IFACE.decodeFunctionResult('getAmountsOut', rawHex);
    if (Array.isArray(amounts) && amounts.length > 0) {
      return BigInt(amounts[amounts.length - 1]);
    }
    return 0n;
  }
  if (flavor === 'UNIV2') {
    const [amounts] = UNIV2_ROUTER_IFACE.decodeFunctionResult('swapExactTokensForTokens', rawHex);
    if (Array.isArray(amounts) && amounts.length > 0) {
      return BigInt(amounts[amounts.length - 1]);
    }
    return 0n;
  }
  const iface =
    flavor === 'UNIV3_ROUTER02'
      ? UNIV3_ROUTER02_IFACE
      : flavor === 'SLIPSTREAM'
      ? SLIPSTREAM_ROUTER_IFACE
      : flavor === 'ALGEBRA'
      ? ALGEBRA_ROUTER_IFACE
      : UNIV3_ROUTER_V1_IFACE;
  const [amountOut] = iface.decodeFunctionResult('exactInputSingle', rawHex);
  return BigInt(amountOut);
}

export interface CrossVenueRuntimeDeps {
  signerAddress: string;
  cleanKey: string;
  profitWallet: string;
  getRouterCaps: (chain: SupportedArbChain) => Promise<RouterCapabilityOptions | undefined>;
  getTokenUsdPrice: (sym: string, chain: SupportedArbChain) => number;
  getGasPriceGwei: (chain: SupportedArbChain) => number;
  rpcCall: (chain: SupportedArbChain, method: string, params: any[]) => Promise<any>;
  sendSignedTxAndWait: (params: {
    chain: SupportedArbChain;
    cleanKey: string;
    to: string;
    data: string;
    gasLimit: bigint;
    minBalanceWei?: bigint;
  }) => Promise<{
    txHash: string;
    receipt: {
      status: number;
      blockNumber: number;
      gasUsed: bigint;
      effectiveGasPrice: bigint | null;
      logs?: Array<{ address?: string; topics: string[]; data: string }>;
    };
  }>;
  tryFlashLoanFallback?: (asset: string, chains: SupportedArbChain[]) => Promise<{
    executed: boolean;
    txHash?: string;
    chain?: SupportedArbChain;
    buyDex?: string;
    sellDex?: string;
    sweptAmount?: string;
    sweptToken?: string;
    realizedUsd?: number;
    error?: string;
  }>;
}

export interface CrossVenueExecutionResult {
  ok: boolean;
  statusCode: number;
  trade?: DualVenueExecutedTrade;
  buyTxHash?: string;
  sellTxHash?: string;
  profitSweepTxHash?: string | null;
  profitRecipient?: string;
  realizedProfitUsd?: number;
  diagnostics?: {
    buyChainBalance: string;
    sellChainBalance: string;
    buyChainQuoteToken: string;
    sellChainBaseToken: string;
    simulatedBuyOut?: string;
    simulatedSellOut?: string;
    verifiedNetProfitUsd?: number;
  };
  error?: string;
}

/**
 * Executes a real on-chain Dual-Venue Spatial Arbitrage trade across `corridor.buyChain` (Buy Low)
 * and `corridor.sellChain` (Sell High), pre-flighting both swaps via `eth_call` (0 gas spent)
 * and transferring 100% of verified spread profit directly into `profitWallet` (Profit Vault).
 */
export async function executeDualVenueCorridorTrade(
  corridor: DualVenueCorridorOpportunity,
  deps: CrossVenueRuntimeDeps,
  options?: {
    clipUsd?: number;
    minNetProfitUsd?: number;
    allowFlashLoanFallback?: boolean;
    force?: boolean;
  }
): Promise<CrossVenueExecutionResult> {
  if (!deps.profitWallet || !/^0x[a-fA-F0-9]{40}$/.test(deps.profitWallet) || deps.profitWallet === ethers.ZeroAddress) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Profit Vault destination address is missing or invalid; refusing cross-chain execution without profit routing.',
    };
  }

  if (!corridor.isProfitable && !options?.force) {
    return {
      ok: false,
      statusCode: 400,
      error: `Corridor ${corridor.asset} (${corridor.layerCorridor}) est. net is $${corridor.estNetProfitUsd.toFixed(2)} (below $0 after DEX & solver/bridge cost). Pick a net-positive corridor or verify spreads.`,
    };
  }

  const [buyCaps, sellCaps] = await Promise.all([
    deps.getRouterCaps(corridor.buyChain).catch(() => undefined),
    deps.getRouterCaps(corridor.sellChain).catch(() => undefined),
  ]);

  const buyResolution = resolveVenueSwapSpecWithDiagnostic({
    chain: corridor.buyChain,
    dex: corridor.buyDex,
    pair: corridor.buyPair,
    feePercent: corridor.buyFeePercent,
    routerCaps: buyCaps,
  });
  const sellResolution = resolveVenueSwapSpecWithDiagnostic({
    chain: corridor.sellChain,
    dex: corridor.sellDex,
    pair: corridor.sellPair,
    feePercent: corridor.sellFeePercent,
    routerCaps: sellCaps,
  });

  if (!buyResolution.ok || !sellResolution.ok) {
    const diagnosticError = !buyResolution.ok ? buyResolution.message : (!sellResolution.ok ? sellResolution.message : '');
    if (options?.allowFlashLoanFallback && deps.tryFlashLoanFallback) {
      const fb = await deps.tryFlashLoanFallback(corridor.asset, [corridor.buyChain, corridor.sellChain]);
      if (fb.executed && fb.txHash) {
        const trade: DualVenueExecutedTrade = {
          id: `l4-arb-${Date.now()}-${fb.txHash.slice(2, 8)}`,
          timestamp: Date.now(),
          corridorId: corridor.id,
          asset: corridor.asset,
          layerCorridor: corridor.layerCorridor,
          buyChain: fb.chain || corridor.buyChain,
          buyDex: fb.buyDex || corridor.buyDex,
          sellChain: fb.chain || corridor.sellChain,
          sellDex: fb.sellDex || corridor.sellDex,
          clipUsd: corridor.recommendedClipUsd,
          buyTxHash: fb.txHash,
          sellTxHash: fb.txHash,
          profitSweepTxHash: fb.txHash,
          profitRecipient: deps.profitWallet,
          realizedProfitUsd: fb.realizedUsd ?? 0,
          realizedProfitToken: fb.sweptToken || corridor.asset,
          realizedProfitAmount: fb.sweptAmount || '0',
          status: 'CONFIRMED',
          executionPath: 'FLASH_LOAN_FALLBACK',
        };
        return {
          ok: true,
          statusCode: 200,
          trade,
          buyTxHash: fb.txHash,
          sellTxHash: fb.txHash,
          profitSweepTxHash: fb.txHash,
          profitRecipient: deps.profitWallet,
          realizedProfitUsd: trade.realizedProfitUsd,
        };
      }
    }
    return {
      ok: false,
      statusCode: 422,
      error: diagnosticError,
    };
  }

  const buySpec = buyResolution.spec;
  const sellSpec = sellResolution.spec;

  // Query real on-chain inventory, allowances, native gas & Slipstream tickSpacing on both chains concurrently (0 gas)
  const balCall = (tokenAddr: string) => ({
    to: tokenAddr,
    data: ERC20_IFACE.encodeFunctionData('balanceOf', [deps.signerAddress]),
  });
  const allowCall = (tokenAddr: string, spender: string) => ({
    to: tokenAddr,
    data: ERC20_IFACE.encodeFunctionData('allowance', [deps.signerAddress, spender]),
  });
  const shouldReadBuySpacing =
    buySpec.flavor === 'SLIPSTREAM' && /^0x[a-fA-F0-9]{40}$/.test(corridor.buyPool || '');
  const shouldReadSellSpacing =
    sellSpec.flavor === 'SLIPSTREAM' && /^0x[a-fA-F0-9]{40}$/.test(corridor.sellPool || '');

  const [
    buyQuoteBalHex,
    buyQuoteAllowHex,
    sellBaseBalHex,
    sellBaseAllowHex,
    buyNativeHex,
    sellNativeHex,
    buyGasPriceHex,
    sellGasPriceHex,
    buyTickSpacingHex,
    sellTickSpacingHex,
  ] = await Promise.all([
    deps.rpcCall(corridor.buyChain, 'eth_call', [balCall(buySpec.quoteToken.addr), 'latest']),
    deps.rpcCall(corridor.buyChain, 'eth_call', [allowCall(buySpec.quoteToken.addr, buySpec.routerAddress), 'latest']),
    deps.rpcCall(corridor.sellChain, 'eth_call', [balCall(sellSpec.baseToken.addr), 'latest']),
    deps.rpcCall(corridor.sellChain, 'eth_call', [allowCall(sellSpec.baseToken.addr, sellSpec.routerAddress), 'latest']),
    deps.rpcCall(corridor.buyChain, 'eth_getBalance', [deps.signerAddress, 'latest']),
    deps.rpcCall(corridor.sellChain, 'eth_getBalance', [deps.signerAddress, 'latest']),
    deps.rpcCall(corridor.buyChain, 'eth_gasPrice', []).catch(() => null),
    deps.rpcCall(corridor.sellChain, 'eth_gasPrice', []).catch(() => null),
    shouldReadBuySpacing
      ? deps
          .rpcCall(corridor.buyChain, 'eth_call', [
            { to: corridor.buyPool, data: SLIPSTREAM_POOL_IFACE.encodeFunctionData('tickSpacing', []) },
            'latest',
          ])
          .catch(() => null)
      : Promise.resolve(null),
    shouldReadSellSpacing
      ? deps
          .rpcCall(corridor.sellChain, 'eth_call', [
            { to: corridor.sellPool, data: SLIPSTREAM_POOL_IFACE.encodeFunctionData('tickSpacing', []) },
            'latest',
          ])
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  if (buyTickSpacingHex && typeof buyTickSpacingHex === 'string') {
    const parsedBuySpacing = decodeTickSpacingResult(buyTickSpacingHex);
    if (parsedBuySpacing !== null) buySpec.tickSpacing = parsedBuySpacing;
  }
  if (sellTickSpacingHex && typeof sellTickSpacingHex === 'string') {
    const parsedSellSpacing = decodeTickSpacingResult(sellTickSpacingHex);
    if (parsedSellSpacing !== null) sellSpec.tickSpacing = parsedSellSpacing;
  }

  const buyGasGweiLive =
    typeof buyGasPriceHex === 'string' && buyGasPriceHex.startsWith('0x')
      ? Number(BigInt(buyGasPriceHex)) / 1e9
      : deps.getGasPriceGwei(corridor.buyChain);
  const sellGasGweiLive =
    typeof sellGasPriceHex === 'string' && sellGasPriceHex.startsWith('0x')
      ? Number(BigInt(sellGasPriceHex)) / 1e9
      : deps.getGasPriceGwei(corridor.sellChain);

  const buyQuoteBal = typeof buyQuoteBalHex === 'string' && buyQuoteBalHex.startsWith('0x') ? BigInt(buyQuoteBalHex) : 0n;
  const buyQuoteAllow = typeof buyQuoteAllowHex === 'string' && buyQuoteAllowHex.startsWith('0x') ? BigInt(buyQuoteAllowHex) : 0n;
  const sellBaseBal = typeof sellBaseBalHex === 'string' && sellBaseBalHex.startsWith('0x') ? BigInt(sellBaseBalHex) : 0n;
  const sellBaseAllow = typeof sellBaseAllowHex === 'string' && sellBaseAllowHex.startsWith('0x') ? BigInt(sellBaseAllowHex) : 0n;
  const buyNativeBal = typeof buyNativeHex === 'string' && buyNativeHex.startsWith('0x') ? BigInt(buyNativeHex) : 0n;
  const sellNativeBal = typeof sellNativeHex === 'string' && sellNativeHex.startsWith('0x') ? BigInt(sellNativeHex) : 0n;

  const buyQuoteHuman = Number(ethers.formatUnits(buyQuoteBal, buySpec.quoteToken.dec));
  const sellBaseHuman = Number(ethers.formatUnits(sellBaseBal, sellSpec.baseToken.dec));

  const buyQuotePriceUsd = STABLE_SYMBOLS.has(buySpec.quoteToken.sym.toUpperCase())
    ? 1
    : deps.getTokenUsdPrice(buySpec.quoteToken.sym, corridor.buyChain) || 2500;
  const sellQuotePriceUsd = STABLE_SYMBOLS.has(sellSpec.quoteToken.sym.toUpperCase())
    ? 1
    : deps.getTokenUsdPrice(sellSpec.quoteToken.sym, corridor.sellChain) || buyQuotePriceUsd;
  const buyQuoteAvailUsd = buyQuoteHuman * buyQuotePriceUsd;
  const sellBaseAvailUsd = sellBaseHuman * corridor.sellPriceUsd;

  if (buyQuoteBal === 0n || sellBaseBal === 0n || buyQuoteAvailUsd < 5 || sellBaseAvailUsd < 5) {
    if (options?.allowFlashLoanFallback && deps.tryFlashLoanFallback) {
      const fb = await deps.tryFlashLoanFallback(corridor.asset, [corridor.buyChain, corridor.sellChain]);
      if (fb.executed && fb.txHash) {
        const trade: DualVenueExecutedTrade = {
          id: `l4-arb-${Date.now()}-${fb.txHash.slice(2, 8)}`,
          timestamp: Date.now(),
          corridorId: corridor.id,
          asset: corridor.asset,
          layerCorridor: corridor.layerCorridor,
          buyChain: fb.chain || corridor.buyChain,
          buyDex: fb.buyDex || corridor.buyDex,
          sellChain: fb.chain || corridor.sellChain,
          sellDex: fb.sellDex || corridor.sellDex,
          clipUsd: corridor.recommendedClipUsd,
          buyTxHash: fb.txHash,
          sellTxHash: fb.txHash,
          profitSweepTxHash: fb.txHash,
          profitRecipient: deps.profitWallet,
          realizedProfitUsd: fb.realizedUsd ?? 0,
          realizedProfitToken: fb.sweptToken || corridor.asset,
          realizedProfitAmount: fb.sweptAmount || '0',
          status: 'CONFIRMED',
          executionPath: 'FLASH_LOAN_FALLBACK',
        };
        return {
          ok: true,
          statusCode: 200,
          trade,
          buyTxHash: fb.txHash,
          sellTxHash: fb.txHash,
          profitSweepTxHash: fb.txHash,
          profitRecipient: deps.profitWallet,
          realizedProfitUsd: trade.realizedProfitUsd,
        };
      }
    }

    return {
      ok: false,
      statusCode: 422,
      diagnostics: {
        buyChainBalance: `${buyQuoteHuman.toFixed(4)} ${buySpec.quoteToken.sym}`,
        sellChainBalance: `${sellBaseHuman.toFixed(6)} ${sellSpec.baseToken.sym}`,
        buyChainQuoteToken: buySpec.quoteToken.sym,
        sellChainBaseToken: sellSpec.baseToken.sym,
      },
      error: `Awaiting Dual-Venue L4 inventory (0 gas spent): Signer ${deps.signerAddress.slice(0, 8)}... holds ${buyQuoteHuman.toFixed(4)} ${buySpec.quoteToken.sym} ($${buyQuoteAvailUsd.toFixed(2)}) on ${corridor.buyChainName} and ${sellBaseHuman.toFixed(6)} ${sellSpec.baseToken.sym} ($${sellBaseAvailUsd.toFixed(2)}) on ${corridor.sellChainName}. Fund both legs (min $5 each) for non-atomic L4 execution.`,
    };
  }

  const minGasWei = 80_000_000_000_000n;
  if (buyNativeBal < minGasWei || sellNativeBal < minGasWei) {
    return {
      ok: false,
      statusCode: 422,
      error: `Insufficient native gas on ${buyNativeBal < minGasWei ? corridor.buyChainName : corridor.sellChainName} for L4 two-leg execution (0 gas spent).`,
    };
  }

  const requestedClipUsd = options?.clipUsd && options.clipUsd > 0 ? options.clipUsd : corridor.recommendedClipUsd;
  const activeClipUsd = Math.min(requestedClipUsd, buyQuoteAvailUsd, sellBaseAvailUsd);
  const buyQuoteUnits = toTokenUnits(activeClipUsd / buyQuotePriceUsd, buySpec.quoteToken.dec);

  // Pre-flight `eth_call` on Buy Leg (buyQuoteUnits -> baseToken) to measure exact on-chain output
  const buySimCalldata = encodeVenueQuoteCalldata({
    flavor: buySpec.flavor,
    tokenIn: buySpec.quoteToken.addr,
    tokenOut: buySpec.baseToken.addr,
    feeUnits: buySpec.feeUnits,
    tickSpacing: buySpec.tickSpacing,
    recipient: deps.signerAddress,
    amountIn: buyQuoteUnits,
    amountOutMinimum: 1n,
  });

  let simBaseBoughtUnits = 0n;
  try {
    const rawBuyOut = await deps.rpcCall(corridor.buyChain, 'eth_call', [
      { from: deps.signerAddress, to: buySpec.routerAddress, data: buySimCalldata },
      'latest',
    ]);
    simBaseBoughtUnits = decodeVenueSwapOutput(buySpec.flavor, String(rawBuyOut || '0x'));
  } catch (err: any) {
    return {
      ok: false,
      statusCode: 422,
      error: `Buy-venue eth_call preflight aborted (0 gas spent): ${decodeFlashArbRevertError(err)}`,
    };
  }

  const sellBaseUnits = simBaseBoughtUnits > sellBaseBal ? sellBaseBal : simBaseBoughtUnits;
  if (simBaseBoughtUnits <= 0n || sellBaseUnits <= 0n) {
    return {
      ok: false,
      statusCode: 422,
      error: `Buy-venue eth_call returned 0 ${buySpec.baseToken.sym} output (0 gas spent).`,
    };
  }

  // Pre-flight `eth_call` on Sell Leg (sellBaseUnits -> quoteToken)
  const sellSimCalldata = encodeVenueQuoteCalldata({
    flavor: sellSpec.flavor,
    tokenIn: sellSpec.baseToken.addr,
    tokenOut: sellSpec.quoteToken.addr,
    feeUnits: sellSpec.feeUnits,
    tickSpacing: sellSpec.tickSpacing,
    recipient: deps.signerAddress,
    amountIn: sellBaseUnits,
    amountOutMinimum: 1n,
  });

  let simQuoteOutUnits = 0n;
  try {
    const rawSellOut = await deps.rpcCall(corridor.sellChain, 'eth_call', [
      { from: deps.signerAddress, to: sellSpec.routerAddress, data: sellSimCalldata },
      'latest',
    ]);
    simQuoteOutUnits = decodeVenueSwapOutput(sellSpec.flavor, String(rawSellOut || '0x'));
  } catch (err: any) {
    return {
      ok: false,
      statusCode: 422,
      error: `Sell-venue eth_call preflight aborted (0 gas spent): ${decodeFlashArbRevertError(err)}`,
    };
  }

  const quoteSpentUsd = Number(ethers.formatUnits(buyQuoteUnits, buySpec.quoteToken.dec)) * buyQuotePriceUsd;
  const quoteReceivedUsd = Number(ethers.formatUnits(simQuoteOutUnits, sellSpec.quoteToken.dec)) * sellQuotePriceUsd;
  const buyGasUsd =
    ((220_000 * Math.max(0.01, buyGasGweiLive)) / 1e9) *
    (deps.getTokenUsdPrice(CHAIN_LAYER_META[corridor.buyChain].nativeSymbol, corridor.buyChain) || 2500);
  const sellGasUsd =
    ((220_000 * Math.max(0.01, sellGasGweiLive)) / 1e9) *
    (deps.getTokenUsdPrice(CHAIN_LAYER_META[corridor.sellChain].nativeSymbol, corridor.sellChain) || 2500);
  const verifiedNetProfitUsd = Number((quoteReceivedUsd - quoteSpentUsd - buyGasUsd - sellGasUsd).toFixed(4));
  const minRequiredProfit = options?.force ? -Infinity : options?.minNetProfitUsd ?? 0.25;

  if (verifiedNetProfitUsd < minRequiredProfit) {
    return {
      ok: false,
      statusCode: 422,
      diagnostics: {
        buyChainBalance: `${buyQuoteHuman.toFixed(4)} ${buySpec.quoteToken.sym}`,
        sellChainBalance: `${sellBaseHuman.toFixed(6)} ${sellSpec.baseToken.sym}`,
        buyChainQuoteToken: buySpec.quoteToken.sym,
        sellChainBaseToken: sellSpec.baseToken.sym,
        simulatedBuyOut: ethers.formatUnits(simBaseBoughtUnits, buySpec.baseToken.dec),
        simulatedSellOut: ethers.formatUnits(simQuoteOutUnits, sellSpec.quoteToken.dec),
        verifiedNetProfitUsd,
      },
      error: `On-chain two-venue preflight aborted tx (0 gas spent): realized spread profit $${verifiedNetProfitUsd.toFixed(2)} is below minimum threshold ($${minRequiredProfit.toFixed(2)}).`,
    };
  }

  // Execute approvals cleanly in parallel when existing router allowance is below trade size
  const approvalOps: Promise<any>[] = [];
  if (buyQuoteAllow < buyQuoteUnits) {
    approvalOps.push(
      deps.sendSignedTxAndWait({
        chain: corridor.buyChain,
        cleanKey: deps.cleanKey,
        to: buySpec.quoteToken.addr,
        data: ERC20_IFACE.encodeFunctionData('approve', [buySpec.routerAddress, buyQuoteUnits * 4n]),
        gasLimit: 90_000n,
      })
    );
  }
  if (sellBaseAllow < sellBaseUnits) {
    approvalOps.push(
      deps.sendSignedTxAndWait({
        chain: corridor.sellChain,
        cleanKey: deps.cleanKey,
        to: sellSpec.baseToken.addr,
        data: ERC20_IFACE.encodeFunctionData('approve', [sellSpec.routerAddress, sellBaseUnits * 4n]),
        gasLimit: 90_000n,
      })
    );
  }
  if (approvalOps.length > 0) {
    await Promise.all(approvalOps);
  }

  // Bound slippage per leg dynamically within the verified margin so execution cannot land at a net loss
  const verifiedMarginBps = quoteSpentUsd > 0 && verifiedNetProfitUsd > 0 ? (verifiedNetProfitUsd / quoteSpentUsd) * 10000 : 0;
  const maxSlippageBps = options?.force
    ? 50n
    : BigInt(Math.max(2, Math.min(35, Math.floor(verifiedMarginBps * 0.35))));
  const minOutBps = 10000n - maxSlippageBps;
  const buyMinOut = (simBaseBoughtUnits * minOutBps) / 10000n;
  const sellMinOut = (simQuoteOutUnits * minOutBps) / 10000n;

  const buyExecCalldata = encodeVenueSwapCalldata({
    flavor: buySpec.flavor,
    tokenIn: buySpec.quoteToken.addr,
    tokenOut: buySpec.baseToken.addr,
    feeUnits: buySpec.feeUnits,
    tickSpacing: buySpec.tickSpacing,
    recipient: deps.signerAddress,
    amountIn: buyQuoteUnits,
    amountOutMinimum: buyMinOut > 0n ? buyMinOut : 1n,
  });

  // If Profit Wallet equals signer, route sell proceeds directly; otherwise land in signer & sweep spread profit to Profit Vault
  const directVaultOnSell = deps.profitWallet.toLowerCase() === deps.signerAddress.toLowerCase();
  const sellExecCalldata = encodeVenueSwapCalldata({
    flavor: sellSpec.flavor,
    tokenIn: sellSpec.baseToken.addr,
    tokenOut: sellSpec.quoteToken.addr,
    feeUnits: sellSpec.feeUnits,
    tickSpacing: sellSpec.tickSpacing,
    recipient: directVaultOnSell ? deps.profitWallet : deps.signerAddress,
    amountIn: sellBaseUnits,
    amountOutMinimum: sellMinOut > 0n ? sellMinOut : 1n,
  });

  const [buyExecRes, sellExecRes] = await Promise.all([
    deps.sendSignedTxAndWait({
      chain: corridor.buyChain,
      cleanKey: deps.cleanKey,
      to: buySpec.routerAddress,
      data: buyExecCalldata,
      gasLimit: corridor.buyChain === 'arbitrum' ? 350_000n : 280_000n,
    }),
    deps.sendSignedTxAndWait({
      chain: corridor.sellChain,
      cleanKey: deps.cleanKey,
      to: sellSpec.routerAddress,
      data: sellExecCalldata,
      gasLimit: corridor.sellChain === 'arbitrum' ? 350_000n : 280_000n,
    }),
  ]);

  if (buyExecRes.receipt.status !== 1 || sellExecRes.receipt.status !== 1) {
    return {
      ok: false,
      statusCode: 500,
      buyTxHash: buyExecRes.txHash,
      sellTxHash: sellExecRes.txHash,
      error: `Dual-venue swap leg reverted on-chain (Buy: ${buyExecRes.txHash}, Sell: ${sellExecRes.txHash}).`,
    };
  }

  // Determine exact actual quote proceeds on sell chain from receipt ERC-20 Transfer logs (or simulated output if logs omitted)
  const expectedSellRecipient = directVaultOnSell ? deps.profitWallet : deps.signerAddress;
  const loggedSellQuoteOutUnits = extractReceivedErc20AmountFromLogs(
    sellExecRes.receipt.logs,
    sellSpec.quoteToken.addr,
    expectedSellRecipient
  );
  const actualSellQuoteOutUnits =
    loggedSellQuoteOutUnits !== null && loggedSellQuoteOutUnits > 0n
      ? loggedSellQuoteOutUnits
      : simQuoteOutUnits;
  const actualSellQuoteUsd = Number(ethers.formatUnits(actualSellQuoteOutUnits, sellSpec.quoteToken.dec)) * sellQuotePriceUsd;
  const actualSpreadProfitUsd = Math.max(0, actualSellQuoteUsd - quoteSpentUsd);
  const actualNetProfitUsd = Number((actualSpreadProfitUsd - buyGasUsd - sellGasUsd).toFixed(4));

  // Sweep the exact spread profit in sellSpec.quoteToken directly into FLASH_ARB_PROFIT_WALLET
  const rawSpreadProfitUnits =
    actualSpreadProfitUsd > 0 && sellQuotePriceUsd > 0
      ? toTokenUnits(actualSpreadProfitUsd / sellQuotePriceUsd, sellSpec.quoteToken.dec)
      : 0n;
  const spreadProfitUnits =
    rawSpreadProfitUnits > actualSellQuoteOutUnits ? actualSellQuoteOutUnits : rawSpreadProfitUnits;

  let profitSweepTxHash: string | null = directVaultOnSell ? sellExecRes.txHash : null;
  let sweepFailedError: string | null = null;
  if (!directVaultOnSell && spreadProfitUnits > 0n) {
    try {
      const sweepData = encodeErc20Transfer(deps.profitWallet, spreadProfitUnits);
      const sweepTx = await deps.sendSignedTxAndWait({
        chain: corridor.sellChain,
        cleanKey: deps.cleanKey,
        to: sellSpec.quoteToken.addr,
        data: sweepData,
        gasLimit: 90_000n,
      });
      if (sweepTx.receipt.status === 1) {
        profitSweepTxHash = sweepTx.txHash;
      } else {
        sweepFailedError = `Profit sweep tx ${sweepTx.txHash} reverted on ${corridor.sellChainName}`;
      }
    } catch (sweepErr: any) {
      sweepFailedError = sweepErr?.message || `Profit sweep tx failed on ${corridor.sellChainName}`;
    }
  }

  const realizedProfitAmount = ethers.formatUnits(spreadProfitUnits, sellSpec.quoteToken.dec);
  const sweepMissing = !directVaultOnSell && spreadProfitUnits > 0n && !profitSweepTxHash;
  const trade: DualVenueExecutedTrade = {
    id: `l4-${Date.now()}-${sellExecRes.txHash.slice(2, 8)}`,
    timestamp: Date.now(),
    corridorId: corridor.id,
    asset: corridor.asset,
    layerCorridor: corridor.layerCorridor,
    buyChain: corridor.buyChain,
    buyDex: corridor.buyDex,
    buyAdapter: buySpec.flavor,
    sellChain: corridor.sellChain,
    sellDex: corridor.sellDex,
    sellAdapter: sellSpec.flavor,
    clipUsd: Number(activeClipUsd.toFixed(2)),
    buyTxHash: buyExecRes.txHash,
    sellTxHash: sellExecRes.txHash,
    profitSweepTxHash,
    profitRecipient: deps.profitWallet,
    realizedProfitUsd: actualNetProfitUsd,
    realizedProfitToken: sellSpec.quoteToken.sym,
    realizedProfitAmount,
    status: sweepMissing ? 'PARTIAL_SETTLED' : 'CONFIRMED',
    executionPath: 'DUAL_VENUE_DIRECT',
  };

  if (sweepMissing) {
    return {
      ok: false,
      statusCode: 500,
      trade,
      buyTxHash: buyExecRes.txHash,
      sellTxHash: sellExecRes.txHash,
      profitSweepTxHash: null,
      profitRecipient: deps.profitWallet,
      realizedProfitUsd: actualNetProfitUsd,
      error: `Swaps succeeded (Buy: ${buyExecRes.txHash}, Sell: ${sellExecRes.txHash}) but profit sweep of ${realizedProfitAmount} ${sellSpec.quoteToken.sym} to Profit Vault ${deps.profitWallet} failed: ${sweepFailedError || 'Sweep tx reverted'}`,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    trade,
    buyTxHash: buyExecRes.txHash,
    sellTxHash: sellExecRes.txHash,
    profitSweepTxHash,
    profitRecipient: deps.profitWallet,
    realizedProfitUsd: actualNetProfitUsd,
  };
}
