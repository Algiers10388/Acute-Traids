import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  recordRpcLatencyFailure,
  recordRpcLatencySuccess,
  sortRpcUrlsByEfficiency,
} from './rpcLatencyAgent.ts';
import {
  computeSafeFlashArbGasLimit,
  evaluateAnalyzerPreflightCandidates,
} from './arbCycleHelpers.ts';
import {
  DEFAULT_VERIFIED_RPC_POOLS,
  getEffectiveRpcPool,
  inspectBatchResponseForQuotaError,
  isRpcQuotaOrRateLimitError,
  redactRpcUrlForDisplay,
  validatePublicHttpsRpcUrl,
} from './rpcSourceRegistry.ts';
import { ETHEREUM_LISTS_CANONICAL_CHAINS } from './ethereumLists.ts';
import type { EncodedArbitrageCandidate } from './flashArbExecutor.ts';

const iface = new ethers.Interface(['error InsufficientProfit(uint256 actual, uint256 required)']);

function makeDummyCandidate(label: string, amountUnits = 1_000_000n): EncodedArbitrageCandidate {
  const tokenA = {
    sym: 'USDC',
    addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    dec: 6,
  };
  const tokenB = {
    sym: 'WETH',
    addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    dec: 18,
  };
  return {
    label,
    borrowedToken: tokenA,
    intermediateToken: tokenB,
    amountUnits,
    routerA: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    routerB: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    feeA: 500,
    feeB: 500,
    routeType: 1,
    minProfitUnits: 1n,
    recipient: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    calldata: '0x23b3aa6b',
  };
}

test('sortRpcUrlsByEfficiency prioritizes lowest-latency healthy endpoints and avoids cooled/failed nodes', () => {
  const urls = [
    'https://slow.rpc.test',
    'https://fast.rpc.test',
    'https://unmeasured.rpc.test',
    'https://cooled.rpc.test',
    'https://failed.rpc.test',
  ];
  const now = Date.now();
  const cooldowns = new Map<string, number>([['https://cooled.rpc.test', now + 30_000]]);

  recordRpcLatencySuccess('arbitrum', 'https://slow.rpc.test', 420);
  recordRpcLatencySuccess('arbitrum', 'https://fast.rpc.test', 55);
  recordRpcLatencySuccess('arbitrum', 'https://cooled.rpc.test', 15);
  recordRpcLatencyFailure('arbitrum', 'https://failed.rpc.test');

  const ranked = sortRpcUrlsByEfficiency('arbitrum', urls, cooldowns, now);

  assert.equal(ranked[0], 'https://fast.rpc.test');
  assert.equal(ranked[1], 'https://unmeasured.rpc.test');
  assert.equal(ranked[2], 'https://slow.rpc.test');
  assert.equal(ranked[3], 'https://failed.rpc.test');
  assert.equal(ranked[4], 'https://cooled.rpc.test');
});

test('evaluateAnalyzerPreflightCandidates aborts immediately without eth_estimateGas fallback when analyzer reports actual=0', () => {
  const candidates = [makeDummyCandidate('cand-1'), makeDummyCandidate('cand-2')];
  const zeroProfitErr = iface.encodeErrorResult('InsufficientProfit', [0n, ethers.MaxUint256]);

  const result = evaluateAnalyzerPreflightCandidates({
    candidates,
    probeBatchSucceeded: true,
    probeResults: [
      { id: 1, error: { data: zeroProfitErr } },
      { id: 2, error: { data: zeroProfitErr } },
    ],
    tokenUsdPrice: () => 1,
    minProfitThresholdUsd: 0.01,
    estGasUsd: 0.02,
  });

  assert.equal(result.shouldAbortWithoutEstimateGas, true);
  assert.equal(result.bestCandidate, null);
  assert.equal(result.orderedCandidates.length, 0);
  assert.match(result.bestProbeRevertReason || '', /InsufficientProfit\(actual=0/);
});

test('evaluateAnalyzerPreflightCandidates aborts without eth_estimateGas fallback when actual profit is below minRequiredUsd', () => {
  const candidates = [makeDummyCandidate('cand-tiny')];
  // 0.005 USDC actual profit vs minRequired = 0.01 + 0.02 = 0.03
  const tinyProfitErr = iface.encodeErrorResult('InsufficientProfit', [5_000n, ethers.MaxUint256]);

  const result = evaluateAnalyzerPreflightCandidates({
    candidates,
    probeBatchSucceeded: true,
    probeResults: [{ id: 1, error: { data: tinyProfitErr } }],
    tokenUsdPrice: () => 1,
    minProfitThresholdUsd: 0.01,
    estGasUsd: 0.02,
  });

  assert.equal(result.shouldAbortWithoutEstimateGas, true);
  assert.equal(result.bestCandidate, null);
  assert.match(result.bestProbeRevertReason || '', /actualUsd=\$0\.0050/);
});

test('evaluateAnalyzerPreflightCandidates selects highest net profit candidate directly when analyzer passes', () => {
  const candidates = [makeDummyCandidate('cand-small'), makeDummyCandidate('cand-best')];
  const smallProfitErr = iface.encodeErrorResult('InsufficientProfit', [500_000n, ethers.MaxUint256]); // $0.50
  const bestProfitErr = iface.encodeErrorResult('InsufficientProfit', [2_000_000n, ethers.MaxUint256]); // $2.00

  const result = evaluateAnalyzerPreflightCandidates({
    candidates,
    probeBatchSucceeded: true,
    probeResults: [
      { id: 1, error: { data: smallProfitErr } },
      { id: 2, error: { data: bestProfitErr } },
    ],
    tokenUsdPrice: () => 1,
    minProfitThresholdUsd: 0.01,
    estGasUsd: 0.02,
  });

  assert.equal(result.shouldAbortWithoutEstimateGas, false);
  assert.ok(result.bestCandidate);
  assert.equal(result.bestCandidate.cand.label, 'cand-best');
  assert.equal(result.bestCandidate.actualProfitUsd, 2);
  // minProfit tightened to 75% of 2_000_000 = 1_500_000 (< actual 2_000_000)
  assert.equal(result.bestCandidate.cand.minProfitUnits, 1_500_000n);
});

test('computeSafeFlashArbGasLimit returns deterministic headroom ceilings per chain without simulation lag', () => {
  assert.equal(computeSafeFlashArbGasLimit('arbitrum', 140_000), 420_000n);
  assert.equal(computeSafeFlashArbGasLimit('ethereum', 140_000), 450_000n);
  assert.equal(computeSafeFlashArbGasLimit('optimism', 140_000), 380_000n);
  assert.equal(computeSafeFlashArbGasLimit('arbitrum', 200_000), 500_000n);
  assert.equal(computeSafeFlashArbGasLimit('arbitrum', 400_000), 600_000n);
});

test('isRpcQuotaOrRateLimitError and inspectBatchResponseForQuotaError flag usage limits without misclassifying EVM reverts', () => {
  assert.equal(
    isRpcQuotaOrRateLimitError(-32001, "You've reached the usage limit. Sign up for a free plan").matched,
    true
  );
  assert.equal(
    isRpcQuotaOrRateLimitError(429, 'Your usage limit has been reached').cooldownMs >= 180_000,
    true
  );
  assert.equal(
    isRpcQuotaOrRateLimitError(3, 'execution reverted: InsufficientProfit(actual=0, required=74)').matched,
    false
  );

  // HTTP 200 batch array containing a usage-limit error must trigger failover
  const batchLimit = inspectBatchResponseForQuotaError([
    { jsonrpc: '2.0', id: 1, error: { code: -32001, message: "You've reached the usage limit" } },
  ]);
  assert.equal(batchLimit.isQuotaError, true);

  // HTTP 200 batch array containing normal eth_call analyzer revert passes cleanly
  const zeroProfitErr = iface.encodeErrorResult('InsufficientProfit', [0n, ethers.MaxUint256]);
  const batchRevert = inspectBatchResponseForQuotaError([
    { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: zeroProfitErr } },
  ]);
  assert.equal(batchRevert.isQuotaError, false);
});

test('redactRpcUrlForDisplay masks secret path tokens while preserving keyless public RPC URLs', () => {
  assert.equal(redactRpcUrlForDisplay('https://arb1.arbitrum.io/rpc'), 'https://arb1.arbitrum.io/rpc');
  const masked = redactRpcUrlForDisplay('https://arb-mainnet.g.alchemy.com/v2/mySuperSecretKey9876?foo=bar');
  assert.equal(masked.includes('mySuperSecretKey'), false);
  assert.match(masked, /9876/);
});

test('validatePublicHttpsRpcUrl blocks non-https, loopback, and private/metadata addresses', async () => {
  await assert.rejects(() => validatePublicHttpsRpcUrl('http://arb1.arbitrum.io/rpc'), /https:\/\//);
  await assert.rejects(() => validatePublicHttpsRpcUrl('https://localhost:8545'), /blocked/);
  await assert.rejects(() => validatePublicHttpsRpcUrl('https://127.0.0.1:8545'), /blocked/);
  await assert.rejects(() => validatePublicHttpsRpcUrl('https://169.254.169.254/latest'), /blocked/);
  await assert.rejects(() => validatePublicHttpsRpcUrl('https://10.0.0.1/rpc'), /blocked/);

  const validIp = await validatePublicHttpsRpcUrl('https://1.1.1.1/rpc');
  assert.equal(validIp.hostname, '1.1.1.1');
});

test('default RPC pools exclude dead providers and keep strict-quota 1rpc gateways at the tail behind high-capacity nodes', () => {
  for (const [chain, urls] of Object.entries(DEFAULT_VERIFIED_RPC_POOLS)) {
    assert.ok(urls.length >= 3, `${chain} should have at least 3 verified RPC sources`);
    assert.equal(urls.some((u) => u.includes('llamarpc.com')), false, `${chain} should not contain broken llamarpc`);
    assert.equal(urls.some((u) => u.includes('polygon-pokt.nodies.app')), false, `${chain} should not contain paid polygon-pokt`);
    assert.equal(urls[0].includes('1rpc.io'), false, `${chain} should not use strict-quota 1rpc.io as primary index 0`);
  }
  for (const [chain, meta] of Object.entries(ETHEREUM_LISTS_CANONICAL_CHAINS)) {
    assert.equal(meta.rpc[0].includes('llamarpc.com'), false, `${chain} metadata should not start with broken llamarpc`);
    assert.ok(getEffectiveRpcPool(chain).length >= 3, `${chain} effective pool should have >= 3 RPCs`);
  }
});
