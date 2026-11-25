import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  decodeVenueSwapOutput,
  encodeVenueQuoteCalldata,
  encodeVenueSwapCalldata,
  executeDualVenueCorridorTrade,
  resolvePairTokensForChain,
  resolveVenueSwapSpec,
  resolveVenueSwapSpecWithDiagnostic,
  type DualVenueCorridorOpportunity,
} from './crossVenueAgent.ts';

const PROFIT_VAULT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const SIGNER_ADDR = '0x1111111111111111111111111111111111111111';

function makeEthCorridor(overrides?: Partial<DualVenueCorridorOpportunity>): DualVenueCorridorOpportunity {
  return {
    id: 'l4-eth-arbitrum-base',
    asset: 'ETH',
    buyChain: 'arbitrum',
    buyLayer: 'L2',
    buyChainName: 'Arbitrum',
    buyDex: 'Uniswap V3',
    buyPair: 'WETH/USDC',
    buyPool: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
    buyPriceUsd: 2480,
    sellChain: 'base',
    sellLayer: 'L2',
    sellChainName: 'Base',
    sellDex: 'Uniswap V3',
    sellPair: 'WETH/USDC',
    sellPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
    sellPriceUsd: 2520,
    layerCorridor: 'L2 (Arbitrum) -> L2 (Base)',
    grossSpreadBps: 161.29,
    dexAndBridgeCostBps: 14,
    netSpreadBps: 147.29,
    recommendedClipUsd: 25000,
    estNetProfitUsd: 368.0,
    isProfitable: true,
    ...overrides,
  };
}

test('resolveVenueSwapSpec selects SwapRouter02 on Base UniV3 and ISwapRouter on Arbitrum UniV3', () => {
  const arbSpec = resolveVenueSwapSpec({
    chain: 'arbitrum',
    dex: 'Uniswap V3',
    pair: 'WETH/USDC',
  });
  const baseSpec = resolveVenueSwapSpec({
    chain: 'base',
    dex: 'Uniswap V3',
    pair: 'WETH/USDC',
  });

  assert.ok(arbSpec);
  assert.ok(baseSpec);
  assert.equal(arbSpec.flavor, 'UNIV3_V1');
  assert.equal(baseSpec.flavor, 'UNIV3_ROUTER02');

  const encoded = encodeVenueSwapCalldata({
    flavor: baseSpec.flavor,
    tokenIn: baseSpec.baseToken.addr,
    tokenOut: baseSpec.quoteToken.addr,
    feeUnits: 500,
    recipient: SIGNER_ADDR,
    amountIn: ethers.parseEther('1'),
    amountOutMinimum: 1n,
  });
  assert.ok(encoded.startsWith('0x04e45aaf')); // ISwapRouter02.exactInputSingle selector
  const decoded = decodeVenueSwapOutput(
    baseSpec.flavor,
    ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [2_520_000_000n])
  );
  assert.equal(decoded, 2_520_000_000n);
});

test('Avalanche Uniswap V3 resolves BTCb/WAVAX (dotted BTC.b symbol) and Scroll/Linea SwapRouter02 cleanly', () => {
  const tokens = resolvePairTokensForChain('avalanche', 'BTCb/WAVAX');
  assert.ok(tokens);
  assert.equal(tokens.baseToken.sym, 'BTC.b');
  assert.equal(tokens.quoteToken.sym, 'WAVAX');

  const avaxSpec = resolveVenueSwapSpec({
    chain: 'avalanche',
    dex: 'Uniswap V3',
    pair: 'BTCb/WAVAX',
    feePercent: 0.05,
  });
  assert.ok(avaxSpec);
  assert.equal(avaxSpec.flavor, 'UNIV3_ROUTER02');
  assert.equal(avaxSpec.routerAddress, '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE');
  assert.equal(avaxSpec.feeUnits, 500);

  const scrollUni = resolveVenueSwapSpec({ chain: 'scroll', dex: 'Uniswap V3', pair: 'WETH/USDC' });
  const lineaUni = resolveVenueSwapSpec({ chain: 'linea', dex: 'Uniswap V3', pair: 'WETH/USDC' });
  assert.equal(scrollUni?.flavor, 'UNIV3_ROUTER02');
  assert.equal(lineaUni?.flavor, 'UNIV3_ROUTER02');
});

test('Slipstream, Algebra (Camelot/QuickSwap/Lynex/ApeChain), and Camelot V2 adapters resolve & encode valid calldata', () => {
  const aeroSlip = resolveVenueSwapSpec({ chain: 'base', dex: 'Aerodrome Slipstream', pair: 'WETH/USDC', feePercent: 0.01 });
  const veloSlip = resolveVenueSwapSpec({ chain: 'optimism', dex: 'Velodrome Slipstream', pair: 'WETH/USDC', feePercent: 0.05 });
  assert.equal(aeroSlip?.flavor, 'SLIPSTREAM');
  assert.equal(aeroSlip?.routerAddress, '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5');
  assert.equal(aeroSlip?.tickSpacing, 1);
  assert.equal(veloSlip?.flavor, 'SLIPSTREAM');
  assert.equal(veloSlip?.routerAddress, '0x0792a633F0c19c351081CF4B211F68F79bCc9676');
  assert.equal(veloSlip?.tickSpacing, 10);

  const slipData = encodeVenueSwapCalldata({
    flavor: 'SLIPSTREAM',
    tokenIn: aeroSlip!.quoteToken.addr,
    tokenOut: aeroSlip!.baseToken.addr,
    feeUnits: 100,
    tickSpacing: 1,
    recipient: SIGNER_ADDR,
    amountIn: 1_000_000n,
    amountOutMinimum: 1n,
  });
  assert.ok(slipData.startsWith('0xa026383e')); // Slipstream exactInputSingle(tuple with int24 tickSpacing)

  const arbCamV3 = resolveVenueSwapSpec({ chain: 'arbitrum', dex: 'Camelot V3', pair: 'WETH/USDC' });
  const apeCamV3 = resolveVenueSwapSpec({ chain: 'apechain', dex: 'Camelot V3', pair: 'WAPE/ApeUSD' });
  const polyQuickV3 = resolveVenueSwapSpec({ chain: 'polygon', dex: 'QuickSwap V3', pair: 'WETH/USDC' });
  const lineaLynex = resolveVenueSwapSpec({ chain: 'linea', dex: 'Lynex V3', pair: 'WETH/USDC' });
  assert.equal(arbCamV3?.flavor, 'ALGEBRA');
  assert.equal(apeCamV3?.flavor, 'ALGEBRA');
  assert.equal(apeCamV3?.routerAddress, '0xC69Dc28924930583024E067b2B3d773018F4EB52');
  assert.equal(polyQuickV3?.flavor, 'ALGEBRA');
  assert.equal(lineaLynex?.flavor, 'ALGEBRA');

  const algData = encodeVenueSwapCalldata({
    flavor: 'ALGEBRA',
    tokenIn: arbCamV3!.quoteToken.addr,
    tokenOut: arbCamV3!.baseToken.addr,
    feeUnits: 500,
    recipient: SIGNER_ADDR,
    amountIn: 1_000_000n,
    amountOutMinimum: 1n,
  });
  assert.ok(algData.startsWith('0xbc651188')); // Algebra exactInputSingle

  const arbCamV2 = resolveVenueSwapSpec({ chain: 'arbitrum', dex: 'Camelot V2', pair: 'WETH/USDC' });
  assert.equal(arbCamV2?.flavor, 'CAMELOT_V2');
  const camQuoteData = encodeVenueQuoteCalldata({
    flavor: 'CAMELOT_V2',
    tokenIn: arbCamV2!.quoteToken.addr,
    tokenOut: arbCamV2!.baseToken.addr,
    feeUnits: 3000,
    recipient: SIGNER_ADDR,
    amountIn: 1_000_000n,
    amountOutMinimum: 1n,
  });
  assert.ok(camQuoteData.startsWith('0xd06ca61f')); // getAmountsOut
  const camSwapData = encodeVenueSwapCalldata({
    flavor: 'CAMELOT_V2',
    tokenIn: arbCamV2!.quoteToken.addr,
    tokenOut: arbCamV2!.baseToken.addr,
    feeUnits: 3000,
    recipient: SIGNER_ADDR,
    amountIn: 1_000_000n,
    amountOutMinimum: 1n,
  });
  assert.ok(camSwapData.startsWith('0xac3893ba')); // Camelot 6-arg swapExactTokensForTokensSupportingFeeOnTransferTokens
  assert.equal(
    decodeVenueSwapOutput(
      'CAMELOT_V2',
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256[]'], [[1_000_000n, ethers.parseEther('0.0004')]])
    ),
    ethers.parseEther('0.0004')
  );

  const missingTokDiag = resolveVenueSwapSpecWithDiagnostic({ chain: 'arbitrum', dex: 'Uniswap V3', pair: 'NOPE/USDC' });
  assert.equal(missingTokDiag.ok, false);
  if (!missingTokDiag.ok) assert.equal(missingTokDiag.reason, 'TOKEN_NOT_FOUND');

  const unsupportedRouterDiag = resolveVenueSwapSpecWithDiagnostic({ chain: 'scroll', dex: 'SushiSwap V3', pair: 'WETH/USDC' });
  assert.equal(unsupportedRouterDiag.ok, false);
  if (!unsupportedRouterDiag.ok) assert.equal(unsupportedRouterDiag.reason, 'ROUTER_UNSUPPORTED');
});

test('executeDualVenueCorridorTrade aborts with 0 txs when simulated spread profit is negative', async () => {
  const sentTxs: string[] = [];
  const corridor = makeEthCorridor();

  const res = await executeDualVenueCorridorTrade(corridor, {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: PROFIT_VAULT,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async (chain, method, params) => {
      if (method === 'eth_getBalance') return '0x0de0b6b3a7640000'; // 1 ETH
      if (method === 'eth_gasPrice') return '0x5f5e100'; // 0.1 gwei
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0x70a08231')) {
          // balanceOf: 50k USDC on arb, 20 WETH on base
          return chain === 'arbitrum'
            ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [50_000_000_000n])
            : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('20')]);
        }
        if (data.startsWith('0xdd62ed3e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.MaxUint256]);
        }
        // exactInputSingle simulation: return slight loss on sell (24,950 USDC out for 25,000 USDC in)
        if (chain === 'arbitrum') {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('10')]);
        }
        return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [24_950_000_000n]);
      }
      return '0x';
    },
    sendSignedTxAndWait: async ({ to }) => {
      sentTxs.push(to);
      return {
        txHash: '0x' + 'aa'.repeat(32),
        receipt: { status: 1, blockNumber: 1, gasUsed: 120000n, effectiveGasPrice: 100000000n },
      };
    },
  });

  assert.equal(res.ok, false);
  assert.equal(sentTxs.length, 0);
  assert.match(res.error || '', /0 gas spent/);
});

test('executeDualVenueCorridorTrade swaps on both venues and sweeps exact spread profit to Profit Vault', async () => {
  const sentTxs: Array<{ chain: string; to: string; data: string }> = [];
  const corridor = makeEthCorridor({ recommendedClipUsd: 25000 });

  const res = await executeDualVenueCorridorTrade(corridor, {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: PROFIT_VAULT,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async (chain, method, params) => {
      if (method === 'eth_getBalance') return '0x0de0b6b3a7640000';
      if (method === 'eth_gasPrice') return '0x5f5e100';
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0x70a08231')) {
          return chain === 'arbitrum'
            ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [50_000_000_000n])
            : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('20')]);
        }
        if (data.startsWith('0xdd62ed3e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.MaxUint256]);
        }
        // Buy leg on Arbitrum: 25,000 USDC -> 10.08 WETH; Sell leg on Base: 10.08 WETH -> 25,400 USDC (+$400 spread)
        if (chain === 'arbitrum') {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('10.08')]);
        }
        return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [25_400_000_000n]);
      }
      return '0x';
    },
    sendSignedTxAndWait: async ({ chain, to, data }) => {
      sentTxs.push({ chain, to, data });
      return {
        txHash: `0x${String(sentTxs.length).padStart(64, 'a')}`,
        receipt: { status: 1, blockNumber: 100, gasUsed: 150000n, effectiveGasPrice: 100000000n },
      };
    },
  });

  assert.equal(res.ok, true);
  assert.ok(res.trade);
  assert.equal(res.profitRecipient, PROFIT_VAULT);
  assert.ok(res.profitSweepTxHash);
  // Expect 3 txs: Buy swap on Arbitrum + Sell swap on Base + ERC20 transfer of $400 spread profit to PROFIT_VAULT
  assert.equal(sentTxs.length, 3);
  const sweepTx = sentTxs[2];
  assert.equal(sweepTx.chain, 'base');
  // 0xa9059cbb = ERC20.transfer(address,uint256)
  assert.ok(sweepTx.data.startsWith('0xa9059cbb'));
  assert.ok(sweepTx.data.toLowerCase().includes(PROFIT_VAULT.slice(2).toLowerCase()));
  assert.equal(res.trade.realizedProfitToken, 'USDC');
  assert.equal(Number(res.trade.realizedProfitAmount), 400);
});

test('executeDualVenueCorridorTrade executes Aerodrome Slipstream -> Camelot V2 with live pool tickSpacing and Vault sweep', async () => {
  const sentTxs: Array<{ chain: string; to: string; data: string }> = [];
  const corridor = makeEthCorridor({
    id: 'l4-eth-base-arbitrum-adapted',
    buyChain: 'base',
    buyChainName: 'Base',
    buyDex: 'Aerodrome Slipstream',
    buyPool: '0x861A2922bE165a5Bd41b1E482B49216b465e1B5F',
    buyFeePercent: 0.05,
    sellChain: 'arbitrum',
    sellChainName: 'Arbitrum',
    sellDex: 'Camelot V2',
    sellPool: '0x0000000000000000000000000000000000000001',
    recommendedClipUsd: 25000,
  });

  let queriedTickSpacing = false;
  let queriedCamelotAmountsOut = false;

  const res = await executeDualVenueCorridorTrade(corridor, {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: PROFIT_VAULT,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async (chain, method, params) => {
      if (method === 'eth_getBalance') return '0x0de0b6b3a7640000';
      if (method === 'eth_gasPrice') return '0x5f5e100';
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0xd0c93a7c')) {
          queriedTickSpacing = true;
          return ethers.AbiCoder.defaultAbiCoder().encode(['int24'], [1]);
        }
        if (data.startsWith('0x70a08231')) {
          return chain === 'base'
            ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [50_000_000_000n])
            : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('20')]);
        }
        if (data.startsWith('0xdd62ed3e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.MaxUint256]);
        }
        if (chain === 'base' && data.startsWith('0xa026383e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('10.05')]);
        }
        if (chain === 'arbitrum' && data.startsWith('0xd06ca61f')) {
          queriedCamelotAmountsOut = true;
          return ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256[]'],
            [[ethers.parseEther('10.05'), 25_350_000_000n]]
          );
        }
      }
      return '0x';
    },
    sendSignedTxAndWait: async ({ chain, to, data }) => {
      sentTxs.push({ chain, to, data });
      return {
        txHash: `0x${String(sentTxs.length).padStart(64, 'b')}`,
        receipt: { status: 1, blockNumber: 200, gasUsed: 160000n, effectiveGasPrice: 100000000n },
      };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(queriedTickSpacing, true);
  assert.equal(queriedCamelotAmountsOut, true);
  assert.equal(sentTxs.length, 3);
  assert.ok(sentTxs[0].data.startsWith('0xa026383e')); // Aerodrome Slipstream buy
  assert.ok(sentTxs[1].data.startsWith('0xac3893ba')); // Camelot V2 sell
  assert.ok(sentTxs[2].data.startsWith('0xa9059cbb')); // Vault sweep
  assert.equal(res.trade?.buyAdapter, 'SLIPSTREAM');
  assert.equal(res.trade?.sellAdapter, 'CAMELOT_V2');
  assert.equal(Number(res.trade?.realizedProfitAmount), 350);
});

test('executeDualVenueCorridorTrade uses Transfer receipt logs to sweep exact realized profit and flags PARTIAL_SETTLED if sweep fails', async () => {
  const erc20TransferTopic = ethers.id('Transfer(address,address,uint256)');
  const toTopic = ethers.zeroPadValue(SIGNER_ADDR, 32);
  const fromTopic = ethers.zeroPadValue('0x2222222222222222222222222222222222222222', 32);
  const baseUsdcAddr = resolvePairTokensForChain('base', 'WETH/USDC')!.quoteToken.addr;

  // Case 1: Actual on-chain sell output log is 25,310 USDC (+$310 real profit vs $400 sim quote)
  const sentData: string[] = [];
  const resWithLogs = await executeDualVenueCorridorTrade(makeEthCorridor({ recommendedClipUsd: 25000 }), {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: PROFIT_VAULT,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async (chain, method, params) => {
      if (method === 'eth_getBalance') return '0x0de0b6b3a7640000';
      if (method === 'eth_gasPrice') return '0x5f5e100';
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0x70a08231')) {
          return chain === 'arbitrum'
            ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [50_000_000_000n])
            : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('20')]);
        }
        if (data.startsWith('0xdd62ed3e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.MaxUint256]);
        }
        return chain === 'arbitrum'
          ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('10.08')])
          : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [25_400_000_000n]);
      }
      return '0x';
    },
    sendSignedTxAndWait: async ({ chain, data }) => {
      sentData.push(data);
      const isSell = chain === 'base' && !data.startsWith('0xa9059cbb');
      return {
        txHash: `0x${String(sentData.length).padStart(64, 'c')}`,
        receipt: {
          status: 1,
          blockNumber: 300,
          gasUsed: 150000n,
          effectiveGasPrice: 100000000n,
          logs: isSell
            ? [
                {
                  address: baseUsdcAddr,
                  topics: [erc20TransferTopic, fromTopic, toTopic],
                  data: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [25_310_000_000n]),
                },
              ]
            : [],
        },
      };
    },
  });

  assert.equal(resWithLogs.ok, true);
  assert.equal(Number(resWithLogs.trade?.realizedProfitAmount), 310);

  // Case 2: If Profit Vault ERC20 sweep reverts, never mark CONFIRMED; return ok:false & PARTIAL_SETTLED
  const resSweepFail = await executeDualVenueCorridorTrade(makeEthCorridor({ recommendedClipUsd: 25000 }), {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: PROFIT_VAULT,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async (chain, method, params) => {
      if (method === 'eth_getBalance') return '0x0de0b6b3a7640000';
      if (method === 'eth_gasPrice') return '0x5f5e100';
      if (method === 'eth_call') {
        const data = String(params[0]?.data || '');
        if (data.startsWith('0x70a08231')) {
          return chain === 'arbitrum'
            ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [50_000_000_000n])
            : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('20')]);
        }
        if (data.startsWith('0xdd62ed3e')) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.MaxUint256]);
        }
        return chain === 'arbitrum'
          ? ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('10.08')])
          : ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [25_400_000_000n]);
      }
      return '0x';
    },
    sendSignedTxAndWait: async ({ data }) => {
      const isSweep = data.startsWith('0xa9059cbb');
      return {
        txHash: `0x${isSweep ? 'd' : 'e'}`.padEnd(66, '0'),
        receipt: { status: isSweep ? 0 : 1, blockNumber: 301, gasUsed: 150000n, effectiveGasPrice: 100000000n },
      };
    },
  });

  assert.equal(resSweepFail.ok, false);
  assert.equal(resSweepFail.statusCode, 500);
  assert.equal(resSweepFail.trade?.status, 'PARTIAL_SETTLED');
  assert.equal(resSweepFail.profitSweepTxHash, null);
  assert.match(resSweepFail.error || '', /profit sweep.*failed/i);
});

test('executeDualVenueCorridorTrade rejects zero or invalid profitWallet before any RPC or tx', async () => {
  let calledTx = false;
  const badRes = await executeDualVenueCorridorTrade(makeEthCorridor(), {
    signerAddress: SIGNER_ADDR,
    cleanKey: '0x' + '22'.repeat(32),
    profitWallet: ethers.ZeroAddress,
    getRouterCaps: async () => undefined,
    getTokenUsdPrice: () => 2500,
    getGasPriceGwei: () => 0.1,
    rpcCall: async () => '0x',
    sendSignedTxAndWait: async () => {
      calledTx = true;
      return { txHash: '0x0', receipt: { status: 1, blockNumber: 1, gasUsed: 1n, effectiveGasPrice: 1n } };
    },
  });

  assert.equal(badRes.ok, false);
  assert.equal(badRes.statusCode, 400);
  assert.equal(calledTx, false);
  assert.match(badRes.error || '', /Profit Vault destination address is missing or invalid/i);
});
