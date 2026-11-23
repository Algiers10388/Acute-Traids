import { ETHEREUM_LISTS_CANONICAL_CHAINS, type EthereumListChainMetadata } from './ethereumLists.ts';
import {
  getEffectiveRpcPool,
  isQuotaOrRateLimitHttpStatus,
  isRpcQuotaOrRateLimitError,
  redactRpcUrlForDisplay,
} from './rpcSourceRegistry.ts';

export interface RpcEndpointBenchmarkResult {
  url: string;
  chainKey: string;
  latencyMs: number;
  blockNumber: number;
  healthy: boolean;
  error?: string;
  lastCheckedAt: number;
}

export interface ChainRpcLatencyReport {
  chainKey: string;
  chainName: string;
  fastestUrl: string | null;
  bestLatencyMs: number;
  endpoints: RpcEndpointBenchmarkResult[];
  scannedAt: number;
}

interface LatencyCacheEntry {
  latencyMs: number;
  blockNumber: number;
  healthy: boolean;
  checkedAt: number;
  consecutiveFailures: number;
  lastError?: string;
}

const latencyCache = new Map<string, LatencyCacheEntry>();

const DEFAULT_UNMEASURED_LATENCY_MS = 250;
const UNHEALTHY_PENALTY_MS = 2500;

function makeCacheKey(chainKey: string, rpcUrl: string): string {
  return `${chainKey.toLowerCase()}:${rpcUrl}`;
}

export function getRpcLatencyEntry(chainKey: string, rpcUrl: string): LatencyCacheEntry | null {
  return latencyCache.get(makeCacheKey(chainKey, rpcUrl)) || null;
}

export function clearRpcLatencyEntry(chainKey: string, rpcUrl: string): void {
  latencyCache.delete(makeCacheKey(chainKey, rpcUrl));
}

/**
 * Records a live RPC response latency (in ms) from any operational call or benchmark
 * using an exponential moving average so the fastest endpoints bubble up dynamically.
 */
export function recordRpcLatencySuccess(
  chainKey: string,
  rpcUrl: string,
  latencyMs: number,
  blockNumber?: number
): void {
  if (!rpcUrl || !Number.isFinite(latencyMs)) return;
  const clampedMs = Math.max(1, Math.min(9999, Math.round(latencyMs)));
  const key = makeCacheKey(chainKey, rpcUrl);
  const prev = latencyCache.get(key);
  const smoothed =
    prev && prev.healthy && prev.latencyMs < 9000
      ? Math.round(prev.latencyMs * 0.6 + clampedMs * 0.4)
      : clampedMs;

  latencyCache.set(key, {
    latencyMs: smoothed,
    blockNumber: blockNumber && blockNumber > 0 ? blockNumber : prev?.blockNumber || 0,
    healthy: true,
    checkedAt: Date.now(),
    consecutiveFailures: 0,
  });
}

/**
 * Marks an RPC endpoint as degraded/failing so failover routing skips it in favor of healthy low-latency nodes.
 */
export function recordRpcLatencyFailure(chainKey: string, rpcUrl: string, reason?: string): void {
  if (!rpcUrl) return;
  const key = makeCacheKey(chainKey, rpcUrl);
  const prev = latencyCache.get(key);
  latencyCache.set(key, {
    latencyMs: 9999,
    blockNumber: prev?.blockNumber || 0,
    healthy: false,
    checkedAt: Date.now(),
    consecutiveFailures: (prev?.consecutiveFailures || 0) + 1,
    lastError: reason || prev?.lastError,
  });
}

/**
 * Returns the current adaptive score (lower is faster/better) for sorting RPC endpoints.
 */
export function getEffectiveRpcScoreMs(chainKey: string, rpcUrl: string, now = Date.now()): number {
  const entry = latencyCache.get(makeCacheKey(chainKey, rpcUrl));
  if (!entry) return DEFAULT_UNMEASURED_LATENCY_MS;

  // Expire stale failure penalties after 90 seconds so endpoints can recover cleanly
  const ageMs = now - entry.checkedAt;
  if (!entry.healthy) {
    if (ageMs > 90_000) return DEFAULT_UNMEASURED_LATENCY_MS + 100;
    return UNHEALTHY_PENALTY_MS + Math.min(5, entry.consecutiveFailures) * 500;
  }

  // Gently decay very old measurements (> 5m) toward neutral so fresher endpoints get tested
  if (ageMs > 300_000) {
    return Math.round(entry.latencyMs * 0.5 + DEFAULT_UNMEASURED_LATENCY_MS * 0.5);
  }
  return entry.latencyMs;
}

/**
 * Sorts an RPC pool by:
 * 1) Non-cooled-down endpoints before actively cooled-down endpoints
 * 2) Among available endpoints, lowest measured RTT latency first
 * 3) Among cooled-down endpoints, earliest cooldown expiry first
 */
export function sortRpcUrlsByEfficiency(
  chainKey: string,
  urls: string[],
  cooldowns: Map<string, number>,
  now = Date.now()
): string[] {
  const indexed = urls.map((url, idx) => ({
    url,
    idx,
    cooldownUntil: cooldowns.get(url) || 0,
    scoreMs: getEffectiveRpcScoreMs(chainKey, url, now),
  }));

  indexed.sort((a, b) => {
    const aCooling = a.cooldownUntil > now;
    const bCooling = b.cooldownUntil > now;
    if (aCooling !== bCooling) {
      return aCooling ? 1 : -1;
    }
    if (aCooling && bCooling) {
      if (a.cooldownUntil !== b.cooldownUntil) {
        return a.cooldownUntil - b.cooldownUntil;
      }
      return a.idx - b.idx;
    }
    if (a.scoreMs !== b.scoreMs) {
      return a.scoreMs - b.scoreMs;
    }
    return a.idx - b.idx;
  });

  return indexed.map((item) => item.url);
}

/**
 * Benchmarks a single RPC endpoint URL by timing an `eth_blockNumber` JSON-RPC call.
 */
export async function benchmarkSingleRpcEndpoint(chainKey: string, rpcUrl: string): Promise<RpcEndpointBenchmarkResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  const displayUrl = redactRpcUrlForDisplay(rpcUrl);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errLabel = isQuotaOrRateLimitHttpStatus(res.status)
        ? `Quota / HTTP ${res.status}`
        : `HTTP ${res.status}`;
      recordRpcLatencyFailure(chainKey, rpcUrl, errLabel);
      return {
        url: displayUrl,
        chainKey,
        latencyMs: 9999,
        blockNumber: 0,
        healthy: false,
        error: errLabel,
        lastCheckedAt: Date.now(),
      };
    }

    const data: any = await res.json();
    if (data?.error) {
      const quotaCheck = isRpcQuotaOrRateLimitError(data.error.code, data.error.message);
      const errLabel = quotaCheck.matched
        ? `Usage/Rate Limit: ${String(data.error.message || data.error.code).slice(0, 90)}`
        : String(data.error.message || `RPC error ${data.error.code}`).slice(0, 90);
      recordRpcLatencyFailure(chainKey, rpcUrl, errLabel);
      return {
        url: displayUrl,
        chainKey,
        latencyMs: 9999,
        blockNumber: 0,
        healthy: false,
        error: errLabel,
        lastCheckedAt: Date.now(),
      };
    }

    const blockNumber = typeof data?.result === 'string' && data.result.startsWith('0x') ? parseInt(data.result, 16) : 0;
    const healthy = blockNumber > 0;

    if (healthy) {
      recordRpcLatencySuccess(chainKey, rpcUrl, latencyMs, blockNumber);
    } else {
      recordRpcLatencyFailure(chainKey, rpcUrl, 'Invalid blockNumber');
    }

    return {
      url: displayUrl,
      chainKey,
      latencyMs,
      blockNumber,
      healthy,
      lastCheckedAt: Date.now(),
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const errLabel = err?.message || 'Timeout / Network Error';
    recordRpcLatencyFailure(chainKey, rpcUrl, errLabel);
    return {
      url: displayUrl,
      chainKey,
      latencyMs: 9999,
      blockNumber: 0,
      healthy: false,
      error: errLabel,
      lastCheckedAt: Date.now(),
    };
  }
}

/**
 * Benchmarks all RPC endpoints for a given chain and identifies the most efficient (lowest latency) call.
 */
export async function benchmarkChainRpcEndpoints(chainKey: string): Promise<ChainRpcLatencyReport> {
  const meta: EthereumListChainMetadata | undefined = ETHEREUM_LISTS_CANONICAL_CHAINS[chainKey];
  const pool = getEffectiveRpcPool(chainKey);
  if (!meta || pool.length === 0) {
    return {
      chainKey,
      chainName: chainKey.toUpperCase(),
      fastestUrl: null,
      bestLatencyMs: 9999,
      endpoints: [],
      scannedAt: Date.now(),
    };
  }

  const results = await Promise.all(pool.map((url) => benchmarkSingleRpcEndpoint(chainKey, url)));
  results.sort((a, b) => {
    if (a.healthy && !b.healthy) return -1;
    if (!a.healthy && b.healthy) return 1;
    return a.latencyMs - b.latencyMs;
  });

  const healthyResults = results.filter((r) => r.healthy);
  const fastest = healthyResults.length > 0 ? healthyResults[0] : null;

  return {
    chainKey,
    chainName: meta.name,
    fastestUrl: fastest ? fastest.url : null,
    bestLatencyMs: fastest ? fastest.latencyMs : 9999,
    endpoints: results,
    scannedAt: Date.now(),
  };
}

/**
 * Benchmarks priority chains in the background without blocking startup so live routing starts warm.
 */
export async function warmRpcLatencyRankings(
  chainKeys: string[] = ['arbitrum', 'base', 'optimism', 'ethereum']
): Promise<void> {
  await Promise.allSettled(chainKeys.map((k) => benchmarkChainRpcEndpoints(k)));
}

/**
 * Benchmarks all supported chains to maximize RPC call efficiency and minimize MEV execution latency.
 */
export async function benchmarkAllRpcEndpoints(): Promise<{
  reports: ChainRpcLatencyReport[];
  overallFastestChain: string;
  averageLatencyMs: number;
  timestamp: number;
}> {
  const chainKeys = Object.keys(ETHEREUM_LISTS_CANONICAL_CHAINS);
  const reports = await Promise.all(chainKeys.map((k) => benchmarkChainRpcEndpoints(k)));

  let totalLatency = 0;
  let healthyCount = 0;
  let bestGlobalLatency = 99999;
  let overallFastestChain = 'arbitrum';

  for (const rep of reports) {
    if (rep.bestLatencyMs < bestGlobalLatency && rep.bestLatencyMs > 0 && rep.bestLatencyMs < 9999) {
      bestGlobalLatency = rep.bestLatencyMs;
      overallFastestChain = rep.chainKey;
    }
    for (const ep of rep.endpoints) {
      if (ep.healthy && ep.latencyMs < 5000) {
        totalLatency += ep.latencyMs;
        healthyCount += 1;
      }
    }
  }

  const averageLatencyMs = healthyCount > 0 ? Math.round(totalLatency / healthyCount) : 145;

  return {
    reports,
    overallFastestChain,
    averageLatencyMs,
    timestamp: Date.now(),
  };
}
