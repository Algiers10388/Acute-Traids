import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSweepDirection, resolveSweepPipelineEndpoints } from './sweepPipeline.ts';

const PROFIT_WALLET = '0xD5503C876a5DFeE057727cfacb6a59E8C7554f5b';
const GAS_WALLET = '0xF1d765d693f9e6fAb0c4a2FCa942d9D54233C966';
const CONNECTED_WALLET = '0x1111111111111111111111111111111111111111';

test('parseSweepDirection defaults to TO_PROFIT_VAULT and recognizes reverse aliases', () => {
  assert.equal(parseSweepDirection(undefined), 'TO_PROFIT_VAULT');
  assert.equal(parseSweepDirection(''), 'TO_PROFIT_VAULT');
  assert.equal(parseSweepDirection('TO_PROFIT_VAULT'), 'TO_PROFIT_VAULT');
  assert.equal(parseSweepDirection('TO_GAS_WALLET'), 'TO_GAS_WALLET');
  assert.equal(parseSweepDirection('reverse'), 'TO_GAS_WALLET');
  assert.equal(parseSweepDirection('to_gas'), 'TO_GAS_WALLET');
});

test('resolveSweepPipelineEndpoints in forward mode routes Gas Wallet + Contracts to Profit Vault', () => {
  const res = resolveSweepPipelineEndpoints({
    rawDirection: 'TO_PROFIT_VAULT',
    requestedRecipient: PROFIT_WALLET,
    defaultProfitWallet: PROFIT_WALLET,
    defaultGasWallet: GAS_WALLET,
    signerAddress: GAS_WALLET,
    hasServerKey: true,
    includeGasWalletTokens: true,
    includeGasWalletEthSurplus: true,
    includeProfitVaultTokens: true,
    includeProfitVaultEthSurplus: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.sweepDirection, 'TO_PROFIT_VAULT');
  assert.equal(res.recipient, PROFIT_WALLET);
  assert.equal(res.includeGasWalletTokensEffective, true);
  assert.equal(res.includeGasWalletEthSurplusEffective, true);
  assert.equal(res.includeProfitVaultTokensEffective, false);
  assert.equal(res.includeProfitVaultEthSurplusEffective, false);
  assert.equal(res.hasWalletSweepTarget, true);
});

test('resolveSweepPipelineEndpoints in reverse mode routes Profit Vault + Contracts to Gas Wallet and disables gas wallet drain', () => {
  const res = resolveSweepPipelineEndpoints({
    rawDirection: 'TO_GAS_WALLET',
    requestedProfitWallet: PROFIT_WALLET,
    requestedGasWallet: GAS_WALLET,
    defaultProfitWallet: PROFIT_WALLET,
    defaultGasWallet: GAS_WALLET,
    signerAddress: null,
    hasServerKey: false,
    includeGasWalletTokens: true,
    includeGasWalletEthSurplus: true,
    includeProfitVaultTokens: true,
    includeProfitVaultEthSurplus: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.sweepDirection, 'TO_GAS_WALLET');
  assert.equal(res.recipient, GAS_WALLET);
  assert.equal(res.profitVaultSource, PROFIT_WALLET);
  assert.equal(res.includeGasWalletTokensEffective, false);
  assert.equal(res.includeGasWalletEthSurplusEffective, false);
  assert.equal(res.includeProfitVaultTokensEffective, true);
  assert.equal(res.includeProfitVaultEthSurplusEffective, true);
  assert.equal(res.hasWalletSweepTarget, true);
  assert.equal(res.canPrepareReverseWithoutServerKey, true);
});

test('resolveSweepPipelineEndpoints prevents self-sweep when Profit Vault equals Gas Wallet in reverse mode', () => {
  const res = resolveSweepPipelineEndpoints({
    rawDirection: 'TO_GAS_WALLET',
    requestedProfitWallet: GAS_WALLET,
    requestedGasWallet: GAS_WALLET,
    signerAddress: GAS_WALLET,
    hasServerKey: true,
    validConnectedAddr: CONNECTED_WALLET,
    includeProfitVaultTokens: true,
    includeProfitVaultEthSurplus: true,
    includeConnectedWalletTokens: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.recipient, GAS_WALLET);
  assert.equal(res.includeProfitVaultTokensEffective, false);
  assert.equal(res.includeProfitVaultEthSurplusEffective, false);
  assert.equal(res.hasWalletSweepTarget, true);
});

test('resolveSweepPipelineEndpoints rejects missing recipient address cleanly', () => {
  const res = resolveSweepPipelineEndpoints({
    rawDirection: 'TO_GAS_WALLET',
    requestedProfitWallet: PROFIT_WALLET,
    requestedGasWallet: 'invalid',
    defaultGasWallet: '',
    signerAddress: null,
  });

  assert.equal(res.ok, false);
  assert.match(res.error || '', /Gas Execution Wallet recipient/i);
});
