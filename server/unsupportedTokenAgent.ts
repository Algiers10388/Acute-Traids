import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyDetectedErcStandard,
  ERC165_INTERFACE_IDS,
  normalizeValidContractAddress,
  type SupportedArbChain,
} from './flashArbExecutor.ts';
import { fetchRpcSingleWithFailover } from './flashArbRoutes.ts';

export interface UnsupportedTokenScanItem {
  address: string;
  chain: SupportedArbChain;
  tokenId?: string;
  label: string;
  isDeployed: boolean;
  bytecodeSize: number;
  ercStandard: 'ERC-20' | 'ERC-4626' | 'ERC-721' | 'ERC-1155' | 'UNKNOWN';
  isCompatible: boolean;
  symbol: string;
  name: string;
  decimals: number;
  balanceFormatted: string;
  compatibilityNote: string;
  scannedAt: number;
}

const REGISTRY_STORAGE_FILE = path.resolve(process.cwd(), '.data', 'pooled-compatible-tokens.json');

export function loadPooledCompatibleTokens(): UnsupportedTokenScanItem[] {
  try {
    if (fs.existsSync(REGISTRY_STORAGE_FILE)) {
      const raw = fs.readFileSync(REGISTRY_STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return [];
}

export function savePooledCompatibleTokens(items: UnsupportedTokenScanItem[]): void {
  try {
    const dir = path.dirname(REGISTRY_STORAGE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_STORAGE_FILE, JSON.stringify(items, null, 2), 'utf-8');
  } catch {}
}

/**
 * Scans, detects, and probes an unsupported contract or token (e.g. 0x54F4...437f)
 * to verify whether it implements ERC-20, ERC-4626, ERC-721, or ERC-1155,
 * and pools it into a clean registry if compatible.
 */
export async function scanAndClassifyUnsupportedTarget(params: {
  chain: SupportedArbChain;
  rawTarget: string;
  label?: string;
}): Promise<UnsupportedTokenScanItem> {
  const chain = params.chain;
  const rawClean = String(params.rawTarget || '').trim();
  const [addressPart, tokenIdPart] = rawClean.includes(':') ? rawClean.split(':') : [rawClean, undefined];
  const address = normalizeValidContractAddress(addressPart) || addressPart;
  const tokenId = tokenIdPart && /^\d+$/.test(tokenIdPart.trim()) ? tokenIdPart.trim() : undefined;
  const label = params.label || (tokenId ? `Token #${tokenId}` : 'Custom Asset');

  const now = Date.now();
  const defaultResult: UnsupportedTokenScanItem = {
    address,
    chain,
    tokenId,
    label,
    isDeployed: false,
    bytecodeSize: 0,
    ercStandard: 'UNKNOWN',
    isCompatible: false,
    symbol: 'UNKNOWN',
    name: 'Unknown Asset',
    decimals: 18,
    balanceFormatted: '0.00',
    compatibilityNote: 'Incompatible: contract does not expose ERC-20, ERC-4626, ERC-721, or ERC-1155 interfaces.',
    scannedAt: now,
  };

  if (!ethers.isAddress(address)) {
    return {
      ...defaultResult,
      compatibilityNote: `Invalid EVM address format "${addressPart}". Provide a valid 42-character 0x address.`,
    };
  }

  try {
    const [codeRes, decimalsRes, symbolRes, nameRes, erc1155ProbeRes, erc721ProbeRes, totalSupplyRes] = await Promise.all([
      fetchRpcSingleWithFailover(chain, 'eth_getCode', [address, 'latest'], true),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest'], true).catch(() => ({ result: '0x' })),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: '0x95d89b41' }, 'latest'], true).catch(() => ({ result: '0x' })),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: '0x06fdde03' }, 'latest'], true).catch(() => ({ result: '0x' })),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: `0x01ffc9a7${ERC165_INTERFACE_IDS.ERC1155.replace('0x', '').padStart(64, '0')}` }, 'latest'], true).catch(() => ({ result: '0x' })),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: `0x01ffc9a7${ERC165_INTERFACE_IDS.ERC721.replace('0x', '').padStart(64, '0')}` }, 'latest'], true).catch(() => ({ result: '0x' })),
      fetchRpcSingleWithFailover(chain, 'eth_call', [{ to: address, data: '0x18160ddd' }, 'latest'], true).catch(() => ({ result: '0x' })),
    ]);

    const code = String(codeRes.result || '0x');
    const isDeployed = code !== '0x' && code.length > 2;
    const bytecodeSize = isDeployed ? (code.length - 2) / 2 : 0;

    if (!isDeployed) {
      return {
        ...defaultResult,
        compatibilityNote: `Incompatible / Unknown: No bytecode deployed at address ${address} on ${chain}.`,
        scannedAt: now,
      };
    }

    let decimals = 18;
    if (typeof decimalsRes.result === 'string' && decimalsRes.result.length >= 66) {
      try {
        decimals = Number(BigInt(decimalsRes.result));
        if (decimals > 36 || decimals < 0) decimals = 18;
      } catch {}
    }

    let symbol = 'UNKNOWN';
    if (typeof symbolRes.result === 'string' && symbolRes.result.length > 2) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], symbolRes.result);
        if (decoded[0]) symbol = String(decoded[0]).trim();
      } catch {
        try {
          const rawHex = symbolRes.result.replace('0x', '');
          const bytes = Buffer.from(rawHex, 'hex');
          symbol = bytes.toString('utf8').replace(/\u0000/g, '').trim();
        } catch {}
      }
    }

    let name = 'Unknown Token';
    if (typeof nameRes.result === 'string' && nameRes.result.length > 2) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], nameRes.result);
        if (decoded[0]) name = String(decoded[0]).trim();
      } catch {
        try {
          const rawHex = nameRes.result.replace('0x', '');
          const bytes = Buffer.from(rawHex, 'hex');
          name = bytes.toString('utf8').replace(/\u0000/g, '').trim();
        } catch {}
      }
    }

    const decodeBool = (hexRes: unknown): boolean => {
      if (typeof hexRes !== 'string' || hexRes.length < 66) return false;
      try {
        return BigInt(hexRes) === 1n;
      } catch {
        return false;
      }
    };

    const isErc1155 = decodeBool(erc1155ProbeRes.result);
    const isErc721 = decodeBool(erc721ProbeRes.result);
    const hasTotalSupply = Boolean(totalSupplyRes.result && totalSupplyRes.result !== '0x' && totalSupplyRes.result.length >= 66);

    const classification = classifyDetectedErcStandard({
      isErc1155,
      isErc721,
      isErc4626: false,
      isErc777: false,
      isErc2612: false,
      hasErc20TotalSupply: hasTotalSupply && !isErc1155 && !isErc721,
    });

    const rawStandard = classification.ercStandard;
    const mappedStandard: 'ERC-20' | 'ERC-4626' | 'ERC-721' | 'ERC-1155' | 'UNKNOWN' =
      rawStandard === 'ERC-1155'
        ? 'ERC-1155'
        : rawStandard === 'ERC-721'
        ? 'ERC-721'
        : rawStandard === 'ERC-4626'
        ? 'ERC-4626'
        : rawStandard === 'UNKNOWN'
        ? 'UNKNOWN'
        : 'ERC-20';

    const isCompatible = mappedStandard !== 'UNKNOWN';
    const note = isCompatible
      ? `Compatible: Successfully exposed standard ${mappedStandard} interface (${symbol}, decimals ${decimals}). Pooled into active token registry.`
      : `Incompatible: contract does not expose ERC-20, ERC-4626, ERC-721, or ERC-1155 interfaces. Detected bytecode size: ${bytecodeSize} bytes.`;

    const item: UnsupportedTokenScanItem = {
      address,
      chain,
      tokenId,
      label: symbol !== 'UNKNOWN' ? symbol : label,
      isDeployed,
      bytecodeSize,
      ercStandard: mappedStandard,
      isCompatible,
      symbol: symbol !== 'UNKNOWN' ? symbol : 'UNSUPPORTED',
      name,
      decimals,
      balanceFormatted: '0.00',
      compatibilityNote: note,
      scannedAt: now,
    };

    if (isCompatible) {
      const existing = loadPooledCompatibleTokens();
      const idx = existing.findIndex(
        (e) => e.address.toLowerCase() === address.toLowerCase() && e.chain === chain && (e.tokenId || '') === (tokenId || '')
      );
      if (idx >= 0) {
        existing[idx] = item;
      } else {
        existing.unshift(item);
      }
      savePooledCompatibleTokens(existing);
    }

    return item;
  } catch (err: any) {
    return {
      ...defaultResult,
      isDeployed: false,
      compatibilityNote: `Scan probe failed: ${err?.message || 'RPC timeout or network error'}`,
      scannedAt: now,
    };
  }
}
