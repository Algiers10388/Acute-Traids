import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  OWNER_GETTER_PROBES,
  decodeAddressReturn,
  detectBytecodeRescueSweepFunctions,
  encodeRescueSweepCall,
  inspectAbiForRescueSweep,
  planGasOptimizedRecovery,
} from './contractRescueAgent.ts';

const PROFIT_WALLET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CONTRACT_ADDR = '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D';
const OWNER_ADDR = '0xF1d765d693f9e6fAb0c4a2FCa942d9D54233C966';
const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

test('decodeAddressReturn validates 32-byte ABI return and rejects zero/invalid payloads', () => {
  const padded = `0x000000000000000000000000${OWNER_ADDR.slice(2).toLowerCase()}`;
  assert.equal(decodeAddressReturn(padded), OWNER_ADDR);
  assert.equal(
    decodeAddressReturn('0x0000000000000000000000000000000000000000000000000000000000000000'),
    null
  );
  assert.equal(decodeAddressReturn('0x'), null);
  assert.equal(OWNER_GETTER_PROBES.map((p) => p.name).join(','), 'owner,admin,governance,getOwner');
});

test('inspectAbiForRescueSweep parses rescue/sweep functions and skips views & unrelated methods', () => {
  const sampleAbi = [
    { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
    { type: 'function', name: 'pause', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    {
      type: 'function',
      name: 'rescueTokens',
      inputs: [{ name: 'token', type: 'address' }],
      outputs: [],
      stateMutability: 'nonpayable',
    },
    {
      type: 'function',
      name: 'sweepERC20',
      inputs: [
        { name: 'tokenAddress', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [],
      stateMutability: 'nonpayable',
    },
    {
      type: 'function',
      name: 'rescueTokensTo',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'recipient', type: 'address' },
      ],
      outputs: [],
      stateMutability: 'nonpayable',
    },
  ];

  const found = inspectAbiForRescueSweep(sampleAbi);
  assert.equal(found.length, 3);
  assert.equal(found[0].name, 'rescueTokensTo');
  assert.equal(found[0].directToRecipient, true);
  assert.equal(found[1].name, 'sweepERC20');
  assert.deepEqual(found[1].paramRoles, ['TOKEN', 'RECIPIENT', 'AMOUNT']);
  assert.equal(found[2].name, 'rescueTokens');
  assert.equal(found[2].directToRecipient, false);
});

test('detectBytecodeRescueSweepFunctions distinguishes rescue-enabled bytecode from immutable contracts', () => {
  const flashArbBytecode = '0x6080604052a7070692deadbeef00ae3bf8cafe7804d9ac';
  const wethBytecode = '0x6080604052a9059cbb23b872dd70a08231';

  const arbMatches = detectBytecodeRescueSweepFunctions(flashArbBytecode);
  assert.equal(arbMatches.length, 3);
  assert.equal(arbMatches[0].name, 'rescueTokensTo');

  const wethMatches = detectBytecodeRescueSweepFunctions(wethBytecode);
  assert.equal(wethMatches.length, 0);
});

test('encodeRescueSweepCall accurately encodes 1-arg, 2-arg, and 3-arg rescue/sweep calls', () => {
  const [twoArg, threeArg, oneArg] = inspectAbiForRescueSweep([
    'function rescueTokensTo(address token, address recipient)',
    'function sweepERC20(address token, address recipient, uint256 amount)',
    'function sweep(address token)',
  ]);

  const enc2 = encodeRescueSweepCall(twoArg, {
    tokenAddress: USDC_ADDR,
    recipient: PROFIT_WALLET,
    amountWei: 1_500_000n,
  });
  assert.equal(enc2.ok, true);
  if (enc2.ok) {
    assert.ok(enc2.data.startsWith('0xa7070692'));
  }

  const enc3 = encodeRescueSweepCall(threeArg, {
    tokenAddress: USDC_ADDR,
    recipient: PROFIT_WALLET,
    amountWei: 2_500_000n,
  });
  assert.equal(enc3.ok, true);
  if (enc3.ok) {
    const decoded = new ethers.Interface(['function sweepERC20(address,address,uint256)']).decodeFunctionData(
      'sweepERC20',
      enc3.data
    );
    assert.equal(decoded[0], USDC_ADDR);
    assert.equal(decoded[1], PROFIT_WALLET);
    assert.equal(decoded[2], 2_500_000n);
  }

  const enc1 = encodeRescueSweepCall(oneArg, {
    tokenAddress: USDC_ADDR,
    recipient: PROFIT_WALLET,
    amountWei: 5_000_000n,
  });
  assert.equal(enc1.ok, true);
});

test('planGasOptimizedRecovery selects single-tx direct recovery, avoids owner-hop overhead, and filters gas-negative dust', () => {
  const abiFuncs = inspectAbiForRescueSweep([
    'function rescueTokensTo(address token, address recipient)',
    'function rescueTokens(address token)',
  ]);

  const plan = planGasOptimizedRecovery({
    contractAddress: CONTRACT_ADDR,
    contractOwner: OWNER_ADDR,
    profitWallet: PROFIT_WALLET,
    detectedFunctions: abiFuncs,
    trappedAssets: [
      {
        symbol: 'USDC',
        address: USDC_ADDR,
        decimals: 6,
        rawBalance: 250_000_000n,
        formattedBalance: '250.0',
        usdValue: 250.0,
        isNative: false,
      },
      {
        symbol: 'DUST',
        address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        decimals: 18,
        rawBalance: 10_000_000_000_000_000n,
        formattedBalance: '0.01',
        usdValue: 0.01,
        isNative: false,
      },
    ],
    effectiveGasPriceWei: 20_000_000_000n, // 20 Gwei -> ~54k gas * 20 Gwei * $3000 ≈ $3.24
    ethPriceUsd: 3000,
    skipGasNegativeDust: true,
  });

  assert.equal(plan.executableSteps.length, 1);
  assert.equal(plan.executableSteps[0].functionName, 'rescueTokensTo');
  assert.equal(plan.executableSteps[0].singleTxToProfitVault, true);
  assert.equal(plan.executableSteps[0].recipient, PROFIT_WALLET);
  assert.equal(plan.gasSavedByDirectCallUnits, '65000');
  assert.equal(plan.skippedSteps.length, 1);
  assert.equal(plan.skippedSteps[0].status, 'SKIPPED_DUST');
});

test('planGasOptimizedRecovery emits 2-step owner-hop forward when only 1-arg sweep(token) exists', () => {
  const abiFuncs = inspectAbiForRescueSweep(['function sweep(address token)']);
  const plan = planGasOptimizedRecovery({
    contractAddress: CONTRACT_ADDR,
    contractOwner: OWNER_ADDR,
    profitWallet: PROFIT_WALLET,
    detectedFunctions: abiFuncs,
    trappedAssets: [
      {
        symbol: 'USDC',
        address: USDC_ADDR,
        decimals: 6,
        rawBalance: 100_000_000n,
        formattedBalance: '100.0',
        usdValue: 100.0,
        isNative: false,
      },
    ],
    effectiveGasPriceWei: 1_000_000_000n,
    ethPriceUsd: 3000,
  });

  assert.equal(plan.executableSteps.length, 2);
  assert.equal(plan.executableSteps[0].actionType, 'CONTRACT_RESCUE_TO_OWNER');
  assert.equal(plan.executableSteps[0].recipient, OWNER_ADDR);
  assert.equal(plan.executableSteps[1].actionType, 'OWNER_FORWARD_TRANSFER');
  assert.equal(plan.executableSteps[1].recipient, PROFIT_WALLET);
});
