import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface CustomRpcSourceRecord {
  id: string;
  chain: string;
  url: string;
  label: string;
  txCapable: boolean;
  addedAt: number;
  lastVerifiedBlock?: number;
  lastMeasuredLatencyMs?: number;
}

export interface RpcSourceDescriptor {
  id: string;
  chain: string;
  displayUrl: string;
  sourceType: 'custom' | 'env' | 'public';
  label: string;
  txCapable: boolean;
  addedAt?: number;
}

/**
 * Verified zero-key batch & JSON-RPC public pools per chain (tested live against eth_chainId + eth_blockNumber).
 * Higher-capacity keyless providers come first; strict-quota public gateways (e.g., 1rpc.io) stay at the tail as failover-only.
 */
export const DEFAULT_VERIFIED_RPC_POOLS: Record<string, string[]> = {
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.flashbots.net',
    'https://eth.meowrpc.com',
    'https://1rpc.io/eth',
  ],
  ethereum_tx: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.flashbots.net',
    'https://eth.meowrpc.com',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.meowrpc.com',
    'https://arb-pokt.nodies.app',
    'https://arbitrum-one.public.blastapi.io',
    'https://arbitrum.drpc.org',
    'https://1rpc.io/arb',
  ],
  arbitrum_tx: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.meowrpc.com',
    'https://arb-pokt.nodies.app',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one.public.blastapi.io',
    'https://1rpc.io/arb',
  ],
  base: [
    'https://base-pokt.nodies.app',
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.meowrpc.com',
    'https://base.drpc.org',
    'https://base-mainnet.public.blastapi.io',
    'https://1rpc.io/base',
  ],
  optimism: [
    'https://optimism-rpc.publicnode.com',
    'https://mainnet.optimism.io',
    'https://op-pokt.nodies.app',
    'https://optimism.drpc.org',
    'https://1rpc.io/op',
  ],
  polygon: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
  ],
  bsc: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc.drpc.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed.bnbchain.org',
    'https://1rpc.io/bnb',
  ],
  avalanche: [
    'https://avalanche.drpc.org',
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://api.avax.network/ext/bc/C/rpc',
    'https://1rpc.io/avax/c',
  ],
  linea: [
    'https://linea-rpc.publicnode.com',
    'https://linea.drpc.org',
    'https://rpc.linea.build',
    'https://1rpc.io/linea',
  ],
  scroll: [
    'https://scroll.drpc.org',
    'https://scroll-rpc.publicnode.com',
    'https://rpc.scroll.io',
    'https://1rpc.io/scroll',
  ],
  apechain: [
    'https://apechain.drpc.org',
    'https://rpc.apechain.com/http',
    'https://apechain.calderachain.xyz/http',
  ],
};

export const CHAIN_ID_BY_KEY: Record<string, number> = {
  ethereum: 1,
  optimism: 10,
  bsc: 56,
  polygon: 137,
  apechain: 33139,
  arbitrum: 42161,
  avalanche: 43114,
  linea: 59144,
  base: 8453,
  scroll: 534352,
};

const ENV_VAR_BY_CHAIN: Record<string, string> = {
  ethereum: 'ETHEREUM_RPC_URL',
  arbitrum: 'ARBITRUM_RPC_URL',
  base: 'BASE_RPC_URL',
  optimism: 'OPTIMISM_RPC_URL',
  polygon: 'POLYGON_RPC_URL',
  bsc: 'BSC_RPC_URL',
  avalanche: 'AVALANCHE_RPC_URL',
  linea: 'LINEA_RPC_URL',
  scroll: 'SCROLL_RPC_URL',
  apechain: 'APECHAIN_RPC_URL',
};

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CUSTOM_SOURCES_PATH = path.resolve(DATA_DIR, 'custom-rpc-sources.json');
if (!CUSTOM_SOURCES_PATH.startsWith(DATA_DIR + path.sep)) {
  throw new Error('Invalid custom RPC sources store path');
}

let customSourcesLoaded = false;
const customSourcesByChain = new Map<string, CustomRpcSourceRecord[]>();

function makeSourceId(chain: string, url: string): string {
  return crypto.createHash('sha256').update(`${chain.toLowerCase()}:${url}`).digest('hex').slice(0, 12);
}

/**
 * Redacts potential embedded API key path segments / query strings when rendering RPC URLs to logs or API responses,
 * while preserving readable hostnames and keyless public RPC routes.
 */
export function redactRpcUrlForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').map((seg) => {
      if (!seg) return '';
      // Mask token-like segments (long alphanumeric keys, hex keys, UUIDs, Base64-like tokens)
      const isLikelyKey =
        seg.length >= 16 ||
        (/[0-9]/.test(seg) && /[a-zA-Z]/.test(seg) && seg.length >= 10) ||
        /^[a-fA-F0-9_-]{12,}$/.test(seg);
      if (isLikelyKey && !['public', 'mainnet', 'v1', 'v2', 'v3', 'rpc', 'http', 'ext', 'bc'].includes(seg.toLowerCase())) {
        return `••••${seg.slice(-4)}`;
      }
      return seg;
    });
    const hasSearch = Boolean(parsed.search && parsed.search.length > 1);
    const cleanPath = segments.join('/') || '/';
    return `${parsed.protocol}//${parsed.host}${cleanPath === '/' ? '' : cleanPath}${hasSearch ? '?•••' : ''}`;
  } catch {
    return rawUrl.length > 32 ? `${rawUrl.slice(0, 24)}••••${rawUrl.slice(-4)}` : rawUrl;
  }
}

export function isQuotaOrRateLimitHttpStatus(status: number): boolean {
  return status === 402 || status === 403 || status === 429 || status === 502 || status === 503;
}

/**
 * Distinguishes RPC usage-limit / rate-limit / authorization / transport errors from EVM execution reverts.
 */
export function isRpcQuotaOrRateLimitError(code: unknown, message: unknown): { matched: boolean; cooldownMs: number } {
  const numCode = typeof code === 'number' ? code : Number(code);
  const msg = String(message || '');

  // EVM execution revert is NEVER a quota/transport failure
  if (numCode === 3 || /execution reverted|InsufficientProfit/i.test(msg)) {
    return { matched: false, cooldownMs: 0 };
  }

  const isHardQuota =
    numCode === -32001 ||
    numCode === -32005 ||
    numCode === -32016 ||
    numCode === 429 ||
    /usage limit|daily request count|monthly capacity|exceeded.*quota|quota.*exceeded|limit reached|paid subscription|apikey not found|api key|unauthorized|upgrade your plan|compute units/i.test(
      msg
    );

  if (isHardQuota) {
    return { matched: true, cooldownMs: 180_000 };
  }

  const isTransientRateLimit =
    /rate limit|too many requests|throttl|overloaded|try again|requests per second|\brps\b/i.test(msg);

  if (isTransientRateLimit) {
    return { matched: true, cooldownMs: 45_000 };
  }

  return { matched: false, cooldownMs: 0 };
}

/**
 * Inspects a JSON-RPC batch array response for quota/rate-limit/key errors that providers sometimes return under HTTP 200.
 */
export function inspectBatchResponseForQuotaError(results: any[]): {
  isQuotaError: boolean;
  cooldownMs: number;
  reason?: string;
} {
  if (!Array.isArray(results) || results.length === 0) {
    return { isQuotaError: true, cooldownMs: 20_000, reason: 'Empty batch response' };
  }

  let maxCooldown = 0;
  let firstReason: string | undefined;

  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    if (item.error) {
      const check = isRpcQuotaOrRateLimitError(item.error.code, item.error.message);
      if (check.matched) {
        if (check.cooldownMs > maxCooldown) maxCooldown = check.cooldownMs;
        if (!firstReason) {
          firstReason = String(item.error.message || `RPC error ${item.error.code}`);
        }
      }
    }
  }

  if (maxCooldown > 0) {
    return { isQuotaError: true, cooldownMs: maxCooldown, reason: firstReason };
  }
  return { isQuotaError: false, cooldownMs: 0 };
}

function isPrivateOrBlockedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (!normalized) return true;

  if (normalized.startsWith('::ffff:')) {
    return isPrivateOrBlockedIp(normalized.slice(7));
  }

  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // link-local fe80::/10
    }
    return false;
  }

  return true;
}

/**
 * Validates that a user-supplied RPC URL is a public HTTPS endpoint (preventing SSRF against internal hosts/metadata).
 */
export async function validatePublicHttpsRpcUrl(rawUrl: string): Promise<URL> {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('RPC URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format. Expected an https:// JSON-RPC endpoint URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only https:// RPC URLs are permitted for security.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Embedded URL username/password credentials are not supported.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error('Private or loopback RPC hostnames are blocked.');
  }

  if (net.isIP(host)) {
    if (isPrivateOrBlockedIp(host)) {
      throw new Error('Private or reserved IP addresses are blocked.');
    }
    return parsed;
  }

  try {
    const lookedUp = await dns.lookup(host, { all: true });
    if (!lookedUp || lookedUp.length === 0) {
      throw new Error(`DNS lookup returned no addresses for ${host}`);
    }
    for (const addr of lookedUp) {
      if (isPrivateOrBlockedIp(addr.address)) {
        throw new Error('RPC hostname resolves to a private or reserved network address.');
      }
    }
  } catch (err: any) {
    if (err?.message?.includes('private') || err?.message?.includes('blocked')) {
      throw err;
    }
    throw new Error(`Unable to resolve RPC host "${host}": ${err?.message || 'DNS error'}`);
  }

  return parsed;
}

function loadCustomSourcesIfNeeded(): void {
  if (customSourcesLoaded) return;
  customSourcesLoaded = true;
  try {
    if (!fs.existsSync(CUSTOM_SOURCES_PATH)) return;
    const raw = fs.readFileSync(CUSTOM_SOURCES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const chain = String(item.chain || '').toLowerCase().trim();
      const url = String(item.url || '').trim();
      if (!CHAIN_ID_BY_KEY[chain] || !url.startsWith('https://')) continue;
      const list = customSourcesByChain.get(chain) || [];
      if (list.some((x) => x.url === url)) continue;
      list.push({
        id: String(item.id || makeSourceId(chain, url)),
        chain,
        url,
        label: String(item.label || 'Custom RPC').slice(0, 48),
        txCapable: item.txCapable !== false,
        addedAt: Number(item.addedAt) || Date.now(),
        lastVerifiedBlock: typeof item.lastVerifiedBlock === 'number' ? item.lastVerifiedBlock : undefined,
        lastMeasuredLatencyMs: typeof item.lastMeasuredLatencyMs === 'number' ? item.lastMeasuredLatencyMs : undefined,
      });
      customSourcesByChain.set(chain, list);
    }
  } catch {
    // Non-fatal if store unreadable
  }
}

function saveCustomSources(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const allRecords: CustomRpcSourceRecord[] = [];
    for (const list of customSourcesByChain.values()) {
      allRecords.push(...list);
    }
    fs.writeFileSync(CUSTOM_SOURCES_PATH, JSON.stringify(allRecords, null, 2), { mode: 0o600 });
  } catch {
    // Keep runtime registry active even if filesystem is read-only
  }
}

function getEnvRpcUrlsForChain(chain: string): string[] {
  const c = chain.toLowerCase().trim();
  const out: string[] = [];
  const envName = ENV_VAR_BY_CHAIN[c];
  if (envName && process.env[envName]) {
    for (const part of String(process.env[envName]).split(',')) {
      const clean = part.trim();
      if (clean) out.push(clean);
    }
  }
  const fallbackEnvName = envName ? envName.replace(/_RPC_URL$/, '_RPC_FALLBACK_URLS') : '';
  if (fallbackEnvName && process.env[fallbackEnvName]) {
    for (const part of String(process.env[fallbackEnvName]).split(',')) {
      const clean = part.trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}

/**
 * Returns the live deduplicated RPC pool for a chain, ordered:
 * 1) User-added custom RPC sources
 * 2) Configured environment RPC URLs (*_RPC_URL)
 * 3) Verified public keyless RPC pool
 */
export function getEffectiveRpcPool(chain: string, options?: { txCapable?: boolean }): string[] {
  loadCustomSourcesIfNeeded();
  const c = chain.toLowerCase().trim();
  const custom = (customSourcesByChain.get(c) || [])
    .filter((rec) => !options?.txCapable || rec.txCapable)
    .map((rec) => rec.url);
  const envUrls = getEnvRpcUrlsForChain(c);
  const poolKey = options?.txCapable && DEFAULT_VERIFIED_RPC_POOLS[`${c}_tx`] ? `${c}_tx` : c;
  const defaults = DEFAULT_VERIFIED_RPC_POOLS[poolKey] || DEFAULT_VERIFIED_RPC_POOLS.arbitrum || [];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const url of [...custom, ...envUrls, ...defaults]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push(url);
  }
  return deduped;
}

export function listCustomRpcSources(chain?: string): CustomRpcSourceRecord[] {
  loadCustomSourcesIfNeeded();
  if (chain) {
    return [...(customSourcesByChain.get(chain.toLowerCase().trim()) || [])];
  }
  const all: CustomRpcSourceRecord[] = [];
  for (const list of customSourcesByChain.values()) {
    all.push(...list);
  }
  return all;
}

export function getRpcSourceDescriptors(chain: string): RpcSourceDescriptor[] {
  loadCustomSourcesIfNeeded();
  const c = chain.toLowerCase().trim();
  const customList = customSourcesByChain.get(c) || [];
  const customByUrl = new Map(customList.map((r) => [r.url, r]));
  const envSet = new Set(getEnvRpcUrlsForChain(c));
  const pool = getEffectiveRpcPool(c, { txCapable: false });

  return pool.map((url) => {
    const customRec = customByUrl.get(url);
    if (customRec) {
      return {
        id: customRec.id,
        chain: c,
        displayUrl: redactRpcUrlForDisplay(url),
        sourceType: 'custom' as const,
        label: customRec.label,
        txCapable: customRec.txCapable,
        addedAt: customRec.addedAt,
      };
    }
    if (envSet.has(url)) {
      let host = 'Env RPC';
      try {
        host = new URL(url).hostname;
      } catch {}
      return {
        id: makeSourceId(c, url),
        chain: c,
        displayUrl: redactRpcUrlForDisplay(url),
        sourceType: 'env' as const,
        label: `Env (${host})`,
        txCapable: true,
      };
    }
    let host = 'Public RPC';
    try {
      host = new URL(url).hostname;
    } catch {}
    return {
      id: makeSourceId(c, url),
      chain: c,
      displayUrl: redactRpcUrlForDisplay(url),
      sourceType: 'public' as const,
      label: host,
      txCapable: true,
    };
  });
}

/**
 * Verifies a user-supplied HTTPS JSON-RPC source live (`eth_chainId` + `eth_blockNumber`) and activates it.
 */
export async function verifyAndAddCustomRpcSource(params: {
  chain: string;
  url: string;
  label?: string;
  txCapable?: boolean;
}): Promise<{
  record: CustomRpcSourceRecord;
  displayUrl: string;
  chainId: number;
  blockNumber: number;
  latencyMs: number;
}> {
  loadCustomSourcesIfNeeded();
  const c = String(params.chain || '').toLowerCase().trim();
  const expectedChainId = CHAIN_ID_BY_KEY[c];
  if (!expectedChainId) {
    throw new Error(`Unsupported chain "${params.chain}". Supported: ${Object.keys(CHAIN_ID_BY_KEY).join(', ')}`);
  }

  const parsedUrl = await validatePublicHttpsRpcUrl(params.url);
  const cleanUrl = parsedUrl.toString();

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let resp: globalThis.Response;
  try {
    resp = await fetch(cleanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      ]),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  if (!resp.ok) {
    throw new Error(`RPC endpoint responded with HTTP ${resp.status}. Verify endpoint URL and plan limits.`);
  }

  const json: any = await resp.json();
  if (!Array.isArray(json)) {
    if (json?.error) {
      throw new Error(`RPC error: ${json.error.message || json.error.code}`);
    }
    throw new Error('RPC endpoint did not return a valid JSON-RPC batch response.');
  }

  const quotaErr = inspectBatchResponseForQuotaError(json);
  if (quotaErr.isQuotaError) {
    throw new Error(`RPC endpoint reported usage/rate limit: ${quotaErr.reason}`);
  }

  const byId = new Map<number, any>();
  for (const item of json) {
    if (item && item.id !== undefined) byId.set(Number(item.id), item);
  }
  const chainIdHex = byId.get(1)?.result;
  const blockHex = byId.get(2)?.result;
  if (typeof chainIdHex !== 'string' || !chainIdHex.startsWith('0x')) {
    throw new Error('RPC endpoint failed eth_chainId check.');
  }
  if (typeof blockHex !== 'string' || !blockHex.startsWith('0x')) {
    throw new Error('RPC endpoint failed eth_blockNumber check.');
  }

  const remoteChainId = parseInt(chainIdHex, 16);
  const blockNumber = parseInt(blockHex, 16);
  if (remoteChainId !== expectedChainId) {
    throw new Error(
      `Chain ID mismatch: expected ${expectedChainId} (${c}), but endpoint returned chainId ${remoteChainId}.`
    );
  }
  if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
    throw new Error('RPC endpoint returned invalid blockNumber 0.');
  }

  const id = makeSourceId(c, cleanUrl);
  const label = String(params.label || '').trim().slice(0, 48) || `Custom (${parsedUrl.hostname})`;
  const record: CustomRpcSourceRecord = {
    id,
    chain: c,
    url: cleanUrl,
    label,
    txCapable: params.txCapable !== false,
    addedAt: Date.now(),
    lastVerifiedBlock: blockNumber,
    lastMeasuredLatencyMs: latencyMs,
  };

  const existing = (customSourcesByChain.get(c) || []).filter((r) => r.url !== cleanUrl && r.id !== id);
  existing.unshift(record);
  customSourcesByChain.set(c, existing);
  saveCustomSources();

  return {
    record,
    displayUrl: redactRpcUrlForDisplay(cleanUrl),
    chainId: remoteChainId,
    blockNumber,
    latencyMs,
  };
}

export function removeCustomRpcSource(chain: string, idOrUrl: string): { removed: boolean; removedUrl?: string } {
  loadCustomSourcesIfNeeded();
  const c = String(chain || '').toLowerCase().trim();
  const target = String(idOrUrl || '').trim();
  const list = customSourcesByChain.get(c) || [];
  const match = list.find((r) => r.id === target || r.url === target);
  if (!match) {
    return { removed: false };
  }
  customSourcesByChain.set(
    c,
    list.filter((r) => r.id !== match.id)
  );
  saveCustomSources();
  return { removed: true, removedUrl: match.url };
}
