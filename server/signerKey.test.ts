import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { parseEvmPrivateKey, resolveServerSigner } from './signerKey.ts';

test('parseEvmPrivateKey accepts valid 0x, bare, 0X, and quoted private keys', () => {
  const sampleWallet = ethers.Wallet.createRandom();
  const bare = sampleWallet.privateKey.slice(2);

  const r1 = parseEvmPrivateKey(sampleWallet.privateKey);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.format, 'privateKey');
    assert.equal(r1.address, sampleWallet.address);
    assert.equal(r1.privateKey, sampleWallet.privateKey);
  }

  const r2 = parseEvmPrivateKey(`  ${bare}  `);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.address, sampleWallet.address);
    assert.equal(r2.privateKey, sampleWallet.privateKey);
  }

  const r3 = parseEvmPrivateKey(`"0X${bare}"`);
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.address, sampleWallet.address);
    assert.equal(r3.privateKey, sampleWallet.privateKey);
  }
});

test('parseEvmPrivateKey accepts BIP-39 mnemonic phrases with and without passphrase', () => {
  const randomWallet = ethers.Wallet.createRandom();
  const phrase = randomWallet.mnemonic!.phrase;

  const noPass = parseEvmPrivateKey(phrase);
  assert.equal(noPass.ok, true);
  if (noPass.ok) {
    assert.equal(noPass.format, 'mnemonic');
    assert.equal(noPass.address, randomWallet.address);
    assert.equal(noPass.privateKey, randomWallet.privateKey);
  }

  const withPass = parseEvmPrivateKey(phrase, { passphrase: 'my-bip39-passphrase' });
  assert.equal(withPass.ok, true);
  if (withPass.ok) {
    assert.equal(withPass.format, 'mnemonic');
    assert.notEqual(withPass.address, randomWallet.address);
    const expected = ethers.HDNodeWallet.fromPhrase(phrase, 'my-bip39-passphrase');
    assert.equal(withPass.address, expected.address);
    assert.equal(withPass.privateKey, expected.privateKey);
  }
});

test('parseEvmPrivateKey decrypts encrypted JSON keystore with passphrase and rejects missing/wrong passphrase', () => {
  const randomWallet = ethers.Wallet.createRandom();
  const keystoreJson = randomWallet.encryptSync('strong-keystore-pass');

  const missingPass = parseEvmPrivateKey(keystoreJson);
  assert.equal(missingPass.ok, false);
  assert.equal(missingPass.configured, true);
  assert.match(missingPass.error, /passphrase is required/i);

  const wrongPass = parseEvmPrivateKey(keystoreJson, { passphrase: 'wrong-pass' });
  assert.equal(wrongPass.ok, false);
  assert.equal(wrongPass.configured, true);

  const decrypted = parseEvmPrivateKey(keystoreJson, { passphrase: 'strong-keystore-pass' });
  assert.equal(decrypted.ok, true);
  if (decrypted.ok) {
    assert.equal(decrypted.format, 'keystoreJson');
    assert.equal(decrypted.address, randomWallet.address);
    assert.equal(decrypted.privateKey, randomWallet.privateKey);
  }
});

test('parseEvmPrivateKey rejects empty, address-like, malformed, zero, and out-of-range keys without throwing', () => {
  const empty = parseEvmPrivateKey('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.configured, false);

  const addr = parseEvmPrivateKey('0xF1d765d693f9e6fAb0c4a2FCa942d9D54233C966');
  assert.equal(addr.ok, false);
  assert.equal(addr.configured, true);
  assert.match(addr.error, /public wallet address/i);

  const badLen = parseEvmPrivateKey('0x1234');
  assert.equal(badLen.ok, false);
  assert.equal(badLen.configured, true);
  assert.match(badLen.error, /invalid signer credential/i);

  const zeroKey = parseEvmPrivateKey('0x' + '0'.repeat(64));
  assert.equal(zeroKey.ok, false);
  assert.equal(zeroKey.configured, true);
  assert.match(zeroKey.error, /secp256k1/i);

  const maxHex = parseEvmPrivateKey('0x' + 'f'.repeat(64));
  assert.equal(maxHex.ok, false);
  assert.equal(maxHex.configured, true);
  assert.match(maxHex.error, /secp256k1/i);
});

test('resolveServerSigner supports FLASH_ARB_SIGNER_PASSPHRASE and explicit override options', () => {
  const w1 = ethers.Wallet.createRandom();
  const phrase = w1.mnemonic!.phrase;

  const fromEnvWithPass = resolveServerSigner(undefined, {
    FLASH_ARB_SIGNER_KEY: phrase,
    FLASH_ARB_SIGNER_PASSPHRASE: 'env-secret-passphrase',
  });
  assert.equal(fromEnvWithPass.ok, true);
  if (fromEnvWithPass.ok) {
    const expected = ethers.HDNodeWallet.fromPhrase(phrase, 'env-secret-passphrase');
    assert.equal(fromEnvWithPass.address, expected.address);
  }

  const fromOverride = resolveServerSigner(
    phrase,
    { FLASH_ARB_SIGNER_KEY: 'invalid' },
    { passphrase: 'override-passphrase' }
  );
  assert.equal(fromOverride.ok, true);
  if (fromOverride.ok) {
    const expected = ethers.HDNodeWallet.fromPhrase(phrase, 'override-passphrase');
    assert.equal(fromOverride.address, expected.address);
  }
});
