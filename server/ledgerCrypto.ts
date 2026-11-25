import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Authenticated encryption-at-rest helper for server data stores (./data/*.json).
 *
 * Uses AES-256-GCM with scrypt key derivation (N=16384, r=8, p=1) and a fresh
 * 96-bit random IV per write, bound to the store context via Additional Authenticated Data (AAD).
 * Every file is written atomically via temp file + rename with POSIX mode 0600.
 */

export const ENVELOPE_FORMAT = "onset-encrypted-at-rest";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "aes-256-gcm";
export const ENVELOPE_KDF = "scrypt";

const DEFAULT_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const MIN_KEY_LENGTH = 12;

export interface EncryptedEnvelope {
  format: typeof ENVELOPE_FORMAT;
  version: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  kdf: typeof ENVELOPE_KDF;
  kdfParams: { N: number; r: number; p: number };
  aad: string;
  salt: string; // base64 (16 bytes)
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (16 bytes)
  ciphertext: string; // base64
}

export interface ReadStoreResult<T> {
  data: T;
  wasPlaintext: boolean;
  encrypted: boolean;
}

// Cache derived 256-bit keys and session salt by sha256(passphrase) + context
// so frequent ledger saves do not repeatedly pay scrypt CPU cost while every write gets a fresh random IV.
const derivedKeyCache = new Map<string, Buffer>();
const sessionSaltCache = new Map<string, { passphraseHash: string; salt: Buffer }>();
const MAX_CACHE_ENTRIES = 32;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function getDerivedKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  const cacheKey = `${sha256Hex(passphrase)}:${salt.toString("base64")}:${params.N}:${params.r}:${params.p}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;

  const key = crypto.scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });

  if (derivedKeyCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = derivedKeyCache.keys().next().value;
    if (firstKey) derivedKeyCache.delete(firstKey);
  }
  derivedKeyCache.set(cacheKey, key);
  return key;
}

export function getLedgerEncryptionPassphrase(): string | null {
  const raw = process.env.FIAT_LEDGER_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (raw.length < MIN_KEY_LENGTH) {
    throw new Error(`FIAT_LEDGER_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters (recommended: 64 hex chars / 32 random bytes).`);
  }
  return raw;
}

export function isLedgerEncryptionEnabled(): boolean {
  return Boolean(getLedgerEncryptionPassphrase());
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.format === ENVELOPE_FORMAT && v.alg === ENVELOPE_ALG && typeof v.ciphertext === "string";
}

function aadBuffer(context: string): Buffer {
  return Buffer.from(`${ENVELOPE_FORMAT}:v${ENVELOPE_VERSION}:${context}`, "utf8");
}

export function encryptJson(data: unknown, context: string, passphrase?: string): EncryptedEnvelope {
  const secret = passphrase ?? getLedgerEncryptionPassphrase();
  if (!secret) {
    throw new Error("Cannot encrypt without FIAT_LEDGER_ENCRYPTION_KEY.");
  }
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`Encryption key must be at least ${MIN_KEY_LENGTH} characters.`);
  }

  const pHash = sha256Hex(secret);
  let saltEntry = sessionSaltCache.get(context);
  if (!saltEntry || saltEntry.passphraseHash !== pHash) {
    saltEntry = { passphraseHash: pHash, salt: crypto.randomBytes(16) };
    sessionSaltCache.set(context, saltEntry);
  }

  const key = getDerivedKey(secret, saltEntry.salt, DEFAULT_SCRYPT_PARAMS);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENVELOPE_ALG, key, iv);
  cipher.setAAD(aadBuffer(context));

  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    kdf: ENVELOPE_KDF,
    kdfParams: { ...DEFAULT_SCRYPT_PARAMS },
    aad: context,
    salt: saltEntry.salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

export function decryptJson<T = unknown>(envelope: EncryptedEnvelope, expectedContext: string, passphrase?: string): T {
  const secret = passphrase ?? getLedgerEncryptionPassphrase();
  if (!secret) {
    throw new Error(`Store '${expectedContext}' is encrypted at rest. Set FIAT_LEDGER_ENCRYPTION_KEY in .env to decrypt it.`);
  }

  if (envelope.version !== ENVELOPE_VERSION || envelope.alg !== ENVELOPE_ALG || envelope.kdf !== ENVELOPE_KDF) {
    throw new Error(`Unsupported encrypted store format/version (${String(envelope.version)}/${String(envelope.alg)}).`);
  }
  if (envelope.aad !== expectedContext) {
    throw new Error(`Encrypted store context mismatch (expected '${expectedContext}', got '${String(envelope.aad)}').`);
  }

  const N = Number(envelope.kdfParams?.N);
  const r = Number(envelope.kdfParams?.r);
  const p = Number(envelope.kdfParams?.p);
  if (!Number.isInteger(N) || N < 1024 || N > 65536 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 8) {
    throw new Error("Invalid KDF parameters in encrypted store envelope.");
  }

  const salt = Buffer.from(envelope.salt || "", "base64");
  const iv = Buffer.from(envelope.iv || "", "base64");
  const tag = Buffer.from(envelope.tag || "", "base64");
  const ciphertext = Buffer.from(envelope.ciphertext || "", "base64");

  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error("Malformed cryptographic header in encrypted store.");
  }

  const key = getDerivedKey(secret, salt, { N, r, p });
  const decipher = crypto.createDecipheriv(ENVELOPE_ALG, key, iv);
  decipher.setAAD(aadBuffer(expectedContext));
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch {
    throw new Error(`Failed to decrypt '${expectedContext}': incorrect FIAT_LEDGER_ENCRYPTION_KEY or tampered file.`);
  }
}

export function readStoreJson<T = unknown>(filePath: string, context: string): ReadStoreResult<T> | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (isEncryptedEnvelope(parsed)) {
    const data = decryptJson<T>(parsed, context);
    return { data, wasPlaintext: false, encrypted: true };
  }
  return { data: parsed as T, wasPlaintext: true, encrypted: false };
}

export function writeStoreJson(filePath: string, data: unknown, context: string): { encrypted: boolean } {
  const passphrase = getLedgerEncryptionPassphrase();

  if (!passphrase && fs.existsSync(filePath)) {
    try {
      const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (isEncryptedEnvelope(current)) {
        throw new Error(`Refusing to overwrite encrypted file at ${filePath} without FIAT_LEDGER_ENCRYPTION_KEY.`);
      }
    } catch (err: any) {
      if (err?.message?.includes("Refusing to overwrite encrypted")) throw err;
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = passphrase ? encryptJson(data, context, passphrase) : data;
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  return { encrypted: Boolean(passphrase) };
}

export const KNOWN_DATA_STORES = [
  { filename: "fiat-ledger.json", context: "fiat-ledger" },
  { filename: "fiat-totp.json", context: "fiat-totp" },
  { filename: "plaid-items.json", context: "plaid-items" },
] as const;

export interface StoreInspection {
  filePath: string;
  context: string;
  status: "encrypted" | "plaintext" | "missing" | "invalid";
}

export function inspectDataDirectory(dirPath: string): StoreInspection[] {
  const resolvedDir = path.resolve(dirPath);
  return KNOWN_DATA_STORES.map((store) => {
    const filePath = path.join(resolvedDir, store.filename);
    if (!fs.existsSync(filePath)) {
      return { filePath, context: store.context, status: "missing" as const };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        filePath,
        context: store.context,
        status: isEncryptedEnvelope(parsed) ? ("encrypted" as const) : ("plaintext" as const),
      };
    } catch {
      return { filePath, context: store.context, status: "invalid" as const };
    }
  });
}

export interface StoreMigrationResult {
  filePath: string;
  context: string;
  action: "migrated-to-encrypted" | "verified-encrypted" | "missing";
}

export function encryptDataDirectoryAtRest(dirPath: string): StoreMigrationResult[] {
  const passphrase = getLedgerEncryptionPassphrase();
  if (!passphrase) {
    throw new Error("FIAT_LEDGER_ENCRYPTION_KEY is not set. Add it to .env before encrypting data stores.");
  }

  const resolvedDir = path.resolve(dirPath);
  const results: StoreMigrationResult[] = [];

  for (const store of KNOWN_DATA_STORES) {
    const filePath = path.join(resolvedDir, store.filename);
    const loaded = readStoreJson(filePath, store.context);
    if (!loaded) {
      results.push({ filePath, context: store.context, action: "missing" });
      continue;
    }

    if (loaded.wasPlaintext) {
      writeStoreJson(filePath, loaded.data, store.context);
      results.push({ filePath, context: store.context, action: "migrated-to-encrypted" });
    } else {
      results.push({ filePath, context: store.context, action: "verified-encrypted" });
    }
  }

  return results;
}
