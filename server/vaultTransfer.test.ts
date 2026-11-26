import test from 'node:test';
import assert from 'node:assert';
import 'dotenv/config';
import { lookupExchangeDepositAddress } from './exchangeRoutes.ts';
import {
  encodeErc20Allowance,
  encodeErc20TransferFrom,
  resolveVaultTransferExecutionPlan,
} from './flashArbExecutor.ts';

test('lookupExchangeDepositAddress: validates exchange and evm address correctly', async () => {
  const invalidEx = await lookupExchangeDepositAddress({ exchange: 'INVALID_CEX', asset: 'ETH', chain: 'arbitrum' });
  assert.equal(invalidEx.ok, false);
  assert.equal(invalidEx.status, 400);
  assert.match(invalidEx.error || '', /Unsupported exchange/);

  const unconfigured = await lookupExchangeDepositAddress({ exchange: 'KRAKEN', asset: 'ETH', chain: 'arbitrum' });
  assert.equal(unconfigured.exchange, 'KRAKEN');
  assert.equal(unconfigured.chain, 'arbitrum');
  assert.equal(unconfigured.asset, 'ETH');
});

test('vault transfer: respects 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 as source vault address', () => {
  const TARGET_VAULT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  assert.equal(process.env.FLASH_ARB_PROFIT_WALLET?.toLowerCase(), TARGET_VAULT.toLowerCase());
});

test('resolveVaultTransferExecutionPlan: blocks mismatched signer on non-rescuable WETH9 contract before broadcast', () => {
  const WETH9 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const TEMP_SIGNER = '0x779569ab6e57dd1c3e2dd0d36b17c577eb924848';
  const KRAKEN_DEPOSIT = '0x03c48b70752a9ce222daef328b56e7c68e52ff79';

  const plan = resolveVaultTransferExecutionPlan({
    isNativeTransfer: false,
    sourceVaultAddress: WETH9,
    depositAddress: KRAKEN_DEPOSIT,
    activeSignerAddress: TEMP_SIGNER,
    isSourceContract: true,
    assetSymbol: 'WETH',
    amountWei: 767100783330521695752n,
    tokenAddress: WETH9,
    allowanceWei: 0n,
    formattedAllowance: '0.0',
    hasRescueTokensTo: false,
  });

  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.signerMismatch, true);
    assert.match(plan.error, /smart contract/i);
    assert.match(plan.error, /0 gas spent/i);
  }
});

test('resolveVaultTransferExecutionPlan: withdraws ERC-20 from owned FlashArb contract via rescueTokensTo()', () => {
  const FLASH_ARB_CONTRACT = '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D';
  const OWNER_EOA = '0xF1d765d693f9e6fAb0c4a2FCa942d9D54233C966';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const KRAKEN_DEPOSIT = '0x03c48b70752a9ce222daef328b56e7c68e52ff79';
  const FULL_BAL = 2500000000000000000n;

  const plan = resolveVaultTransferExecutionPlan({
    isNativeTransfer: false,
    sourceVaultAddress: FLASH_ARB_CONTRACT,
    depositAddress: KRAKEN_DEPOSIT,
    activeSignerAddress: OWNER_EOA,
    isSourceContract: true,
    assetSymbol: 'WETH',
    amountWei: FULL_BAL,
    rawBalanceWei: FULL_BAL,
    formattedBalance: '2.5',
    tokenAddress: WETH,
    contractOwner: OWNER_EOA,
    hasRescueTokensTo: true,
  });

  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.usesContractRescue, true);
    assert.equal(plan.callTarget.toLowerCase(), FLASH_ARB_CONTRACT.toLowerCase());
    assert.equal(plan.effectiveSender.toLowerCase(), OWNER_EOA.toLowerCase());
    assert.ok(plan.calldata.startsWith('0xa7070692'));
  }

  // Non-owner key on an owned FlashArb contract should still be blocked before broadcast
  const wrongOwnerPlan = resolveVaultTransferExecutionPlan({
    isNativeTransfer: false,
    sourceVaultAddress: FLASH_ARB_CONTRACT,
    depositAddress: KRAKEN_DEPOSIT,
    activeSignerAddress: '0x779569ab6e57dd1c3e2dd0d36b17c577eb924848',
    isSourceContract: true,
    assetSymbol: 'WETH',
    amountWei: FULL_BAL,
    rawBalanceWei: FULL_BAL,
    tokenAddress: WETH,
    contractOwner: OWNER_EOA,
    hasRescueTokensTo: true,
  });
  assert.equal(wrongOwnerPlan.ok, false);
  if (!wrongOwnerPlan.ok) {
    assert.match(wrongOwnerPlan.error, /owned by/i);
  }
});

test('resolveVaultTransferExecutionPlan: supports executeDirectFlashArb() native ETH sweep from owned FlashArb contract', () => {
  const FLASH_ARB_CONTRACT = '0x5901B4B159Ea0Cab54effcbF00F0076c96AD898D';
  const OWNER_EOA = '0xF1d765d693f9e6fAb0c4a2FCa942d9D54233C966';
  const KRAKEN_DEPOSIT = '0x03c48b70752a9ce222daef328b56e7c68e52ff79';

  const plan = resolveVaultTransferExecutionPlan({
    isNativeTransfer: true,
    sourceVaultAddress: FLASH_ARB_CONTRACT,
    depositAddress: KRAKEN_DEPOSIT,
    activeSignerAddress: null,
    isSourceContract: true,
    assetSymbol: 'ETH',
    amountWei: 0n,
    rawBalanceWei: 1000000000000000000n,
    contractOwner: OWNER_EOA,
    hasDirectFlashArb: true,
  });

  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.usesContractRescue, true);
    assert.equal(plan.callTarget.toLowerCase(), FLASH_ARB_CONTRACT.toLowerCase());
    assert.equal(plan.effectiveSender.toLowerCase(), OWNER_EOA.toLowerCase());
    assert.equal(plan.methodLabel, 'executeDirectFlashArb(recipient)');
  }
});

test('resolveVaultTransferExecutionPlan: uses transferFrom when mismatched EOA has sufficient ERC-20 allowance', () => {
  const VAULT_EOA = '0x1111111111111111111111111111111111111111';
  const DELEGATE_SIGNER = '0x779569ab6e57dd1c3e2dd0d36b17c577eb924848';
  const KRAKEN_DEPOSIT = '0x03c48b70752a9ce222daef328b56e7c68e52ff79';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const AMOUNT = 1000000000000000000n;

  assert.ok(encodeErc20Allowance(VAULT_EOA, DELEGATE_SIGNER).startsWith('0xdd62ed3e'));
  assert.ok(encodeErc20TransferFrom(VAULT_EOA, KRAKEN_DEPOSIT, AMOUNT).startsWith('0x23b872dd'));

  const plan = resolveVaultTransferExecutionPlan({
    isNativeTransfer: false,
    sourceVaultAddress: VAULT_EOA,
    depositAddress: KRAKEN_DEPOSIT,
    activeSignerAddress: DELEGATE_SIGNER,
    isSourceContract: false,
    assetSymbol: 'WETH',
    amountWei: AMOUNT,
    tokenAddress: WETH,
    allowanceWei: AMOUNT,
    formattedAllowance: '1.0',
  });

  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.effectiveSender.toLowerCase(), DELEGATE_SIGNER.toLowerCase());
    assert.equal(plan.callTarget.toLowerCase(), WETH.toLowerCase());
    assert.equal(plan.usesTransferFrom, true);
    assert.ok(plan.calldata.startsWith('0x23b872dd'));
  }
});

test('resolveVaultTransferExecutionPlan: allows matching signer with direct ERC-20 transfer and blocks mismatched native transfer', () => {
  const SIGNER = '0x779569ab6e57dd1c3e2dd0d36b17c577eb924848';
  const OTHER = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const DEPOSIT = '0x03c48b70752a9ce222daef328b56e7c68e52ff79';

  const matched = resolveVaultTransferExecutionPlan({
    isNativeTransfer: false,
    sourceVaultAddress: SIGNER,
    depositAddress: DEPOSIT,
    activeSignerAddress: SIGNER,
    isSourceContract: false,
    assetSymbol: 'WETH',
    amountWei: 500000000000000000n,
    tokenAddress: OTHER,
  });
  assert.equal(matched.ok, true);
  if (matched.ok) {
    assert.equal(matched.usesTransferFrom, false);
    assert.ok(matched.calldata.startsWith('0xa9059cbb'));
    assert.equal(matched.effectiveSender.toLowerCase(), SIGNER.toLowerCase());
  }

  const mismatchedNative = resolveVaultTransferExecutionPlan({
    isNativeTransfer: true,
    sourceVaultAddress: OTHER,
    depositAddress: DEPOSIT,
    activeSignerAddress: SIGNER,
    isSourceContract: true,
    assetSymbol: 'ETH',
    amountWei: 100000000000000000n,
    hasDirectFlashArb: false,
  });
  assert.equal(mismatchedNative.ok, false);
  if (!mismatchedNative.ok) {
    assert.equal(mismatchedNative.signerMismatch, true);
    assert.match(mismatchedNative.error, /0 gas spent/i);
  }
});
