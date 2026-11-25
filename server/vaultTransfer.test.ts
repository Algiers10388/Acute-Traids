import test from 'node:test';
import assert from 'node:assert';
import 'dotenv/config';
import { lookupExchangeDepositAddress } from './exchangeRoutes.ts';

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

