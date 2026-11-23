import { ethers } from 'ethers';

export type SignerKeyFormat = 'privateKey' | 'mnemonic' | 'keystoreJson';

export interface ParseEvmPrivateKeyOptions {
  passphrase?: string;
  derivationPath?: string;
}

export interface ParsedEvmPrivateKeySuccess {
  ok: true;
  configured: true;
  format: SignerKeyFormat;
  privateKey: string;
  address: string;
  wallet: ethers.Wallet;
  keyLast4: string;
}

export interface ParsedEvmPrivateKeyFailure {
  ok: false;
  configured: boolean;
  error: string;
}

export type ParsedEvmPrivateKeyResult = ParsedEvmPrivateKeySuccess | ParsedEvmPrivateKeyFailure;

const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0/0";

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length >= 2) ||
    (out.startsWith("'") && out.endsWith("'") && out.length >= 2)
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * Normalizes and validates an EVM signer credential without leaking the raw secret in errors.
 * Accepts:
 *  1) 64-character hex private keys (with or without 0x/0X prefix)
 *  2) BIP-39 mnemonic / seed phrases (12–24 words) with optional BIP-39 passphrase & derivation path
 *  3) Encrypted Ethereum V3 JSON keystores with decryption passphrase
 */
export function parseEvmPrivateKey(
  raw: unknown,
  options: ParseEvmPrivateKeyOptions = {}
): ParsedEvmPrivateKeyResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      configured: false,
      error: 'Signer private key or passphrase credential is not configured.',
    };
  }

  let candidate = stripWrappingQuotes(raw);
  if (!candidate) {
    return {
      ok: false,
      configured: false,
      error: 'Signer private key or passphrase credential is not configured.',
    };
  }

  const passphrase = typeof options.passphrase === 'string' ? options.passphrase : '';
  const derivationPath =
    typeof options.derivationPath === 'string' && options.derivationPath.trim()
      ? options.derivationPath.trim()
      : DEFAULT_DERIVATION_PATH;

  // 1. Encrypted Ethereum JSON Keystore ({ "crypto": ... } or { "Crypto": ... })
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(candidate);
      if (parsedJson && (parsedJson.crypto || parsedJson.Crypto)) {
        if (!passphrase) {
          return {
            ok: false,
            configured: true,
            error: 'Passphrase is required to decrypt an encrypted Ethereum JSON keystore.',
          };
        }
        const decrypted = ethers.Wallet.fromEncryptedJsonSync(candidate, passphrase);
        const wallet = new ethers.Wallet(decrypted.privateKey);
        return {
          ok: true,
          configured: true,
          format: 'keystoreJson',
          privateKey: wallet.privateKey,
          address: wallet.address,
          wallet,
          keyLast4: wallet.privateKey.slice(-4),
        };
      }
    } catch (err: any) {
      return {
        ok: false,
        configured: true,
        error:
          err?.message && /incorrect password|wrong password/i.test(String(err.message))
            ? 'Incorrect passphrase for encrypted JSON keystore.'
            : 'Invalid encrypted JSON keystore or passphrase.',
      };
    }
  }

  // 2. BIP-39 Mnemonic / Seed Phrase (multi-word phrase, optionally with BIP-39 passphrase)
  const normalizedWords = candidate.replace(/\s+/g, ' ').trim();
  const wordParts = normalizedWords.split(' ');
  if (wordParts.length >= 12 && wordParts.length <= 24 && wordParts.length % 3 === 0) {
    try {
      const hdWallet = ethers.HDNodeWallet.fromPhrase(
        normalizedWords.toLowerCase(),
        passphrase || undefined,
        derivationPath
      );
      const wallet = new ethers.Wallet(hdWallet.privateKey);
      return {
        ok: true,
        configured: true,
        format: 'mnemonic',
        privateKey: wallet.privateKey,
        address: wallet.address,
        wallet,
        keyLast4: wallet.privateKey.slice(-4),
      };
    } catch {
      return {
        ok: false,
        configured: true,
        error: 'Invalid BIP-39 recovery phrase or derivation path.',
      };
    }
  }

  // 3. Standard Hex Private Key
  if (candidate.startsWith('0X')) {
    candidate = `0x${candidate.slice(2)}`;
  }

  if (/^(0x)?[a-fA-F0-9]{40}$/.test(candidate)) {
    return {
      ok: false,
      configured: true,
      error:
        'Configured FLASH_ARB_SIGNER_KEY appears to be a 40-character public wallet address, not a 64-character hex private key or recovery phrase.',
    };
  }

  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(candidate)) {
    return {
      ok: false,
      configured: true,
      error:
        'Invalid signer credential. Enter a 64-character hex private key (with or without 0x), a 12-24 word recovery phrase (with optional passphrase), or an encrypted JSON keystore.',
    };
  }

  const normalized = candidate.startsWith('0x') ? candidate : `0x${candidate}`;

  try {
    const wallet = new ethers.Wallet(normalized);
    return {
      ok: true,
      configured: true,
      format: 'privateKey',
      privateKey: normalized,
      address: wallet.address,
      wallet,
      keyLast4: normalized.slice(-4),
    };
  } catch {
    return {
      ok: false,
      configured: true,
      error:
        'Invalid EVM private key scalar (must be between 1 and the secp256k1 curve order - 1).',
    };
  }
}

/**
 * Resolves and validates either an explicit override credential or process.env.FLASH_ARB_SIGNER_KEY
 * (with optional FLASH_ARB_SIGNER_PASSPHRASE / FLASH_ARB_SIGNER_PATH).
 */
export function resolveServerSigner(
  overrideKey?: unknown,
  env: Record<string, string | undefined> = process.env,
  overrideOptions: ParseEvmPrivateKeyOptions = {}
): ParsedEvmPrivateKeyResult {
  const passphrase =
    typeof overrideOptions.passphrase === 'string' && overrideOptions.passphrase.length > 0
      ? overrideOptions.passphrase
      : env.FLASH_ARB_SIGNER_PASSPHRASE;
  const derivationPath =
    typeof overrideOptions.derivationPath === 'string' && overrideOptions.derivationPath.trim()
      ? overrideOptions.derivationPath.trim()
      : env.FLASH_ARB_SIGNER_PATH;

  if (typeof overrideKey === 'string' && overrideKey.trim().length > 0) {
    return parseEvmPrivateKey(overrideKey, { passphrase, derivationPath });
  }
  return parseEvmPrivateKey(env.FLASH_ARB_SIGNER_KEY, { passphrase, derivationPath });
}
