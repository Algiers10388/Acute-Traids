import { ethers } from 'ethers';
import {
  encodeErc20Transfer,
  normalizeValidContractAddress,
} from './flashArbExecutor.ts';

export interface OwnerGetterProbe {
  name: 'owner' | 'admin' | 'governance' | 'getOwner';
  signature: string;
  selector: string;
}

export const OWNER_GETTER_PROBES: OwnerGetterProbe[] = [
  { name: 'owner', signature: 'owner()', selector: '0x8da5cb5b' },
  { name: 'admin', signature: 'admin()', selector: '0xf851a440' },
  { name: 'governance', signature: 'governance()', selector: '0x5aa6e675' },
  { name: 'getOwner', signature: 'getOwner()', selector: '0x893d20e8' },
];

export function decodeAddressReturn(rawHex: unknown): string | null {
  if (typeof rawHex !== 'string' || !rawHex.startsWith('0x') || rawHex.length < 42) {
    return null;
  }
  const clean = rawHex.slice(2);
  if (clean.length < 40) return null;
  // ABI address return is 32 bytes (64 hex chars), right-aligned 20 bytes (40 hex chars)
  const candidate = `0x${clean.slice(-40)}`;
  return normalizeValidContractAddress(candidate);
}

export type RescueSweepParamRole = 'TOKEN' | 'RECIPIENT' | 'AMOUNT' | 'OTHER';

export interface RescueSweepFunctionSpec {
  name: string;
  signature: string;
  selector: string;
  source: 'ABI' | 'BYTECODE';
  paramTypes: string[];
  paramRoles: RescueSweepParamRole[];
  directToRecipient: boolean;
  supportsToken: boolean;
  supportsNative: boolean;
  requiresOwnerFollowUpTransfer: boolean;
  encodable: boolean;
  priorityScore: number;
  stateMutability: string;
}

interface KnownRescueTemplate {
  fragment: string;
  priorityScore: number;
  supportsToken: boolean;
  supportsNative: boolean;
  directToRecipient: boolean;
  paramRoles: RescueSweepParamRole[];
}

const KNOWN_RESCUE_TEMPLATES: KnownRescueTemplate[] = [
  {
    fragment: 'function rescueTokensTo(address token, address recipient)',
    priorityScore: 100,
    supportsToken: true,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT'],
  },
  {
    fragment: 'function sweep(address token, address recipient)',
    priorityScore: 98,
    supportsToken: true,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT'],
  },
  {
    fragment: 'function sweepToken(address token, address recipient)',
    priorityScore: 97,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT'],
  },
  {
    fragment: 'function sweepTokens(address token, address recipient)',
    priorityScore: 96,
    supportsToken: true,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT'],
  },
  {
    fragment: 'function rescueToken(address token, address recipient)',
    priorityScore: 95,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT'],
  },
  {
    fragment: 'function rescueToken(address token, address recipient, uint256 amount)',
    priorityScore: 94,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT', 'AMOUNT'],
  },
  {
    fragment: 'function rescueERC20(address token, address recipient, uint256 amount)',
    priorityScore: 93,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT', 'AMOUNT'],
  },
  {
    fragment: 'function sweepERC20(address token, address recipient, uint256 amount)',
    priorityScore: 92,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT', 'AMOUNT'],
  },
  {
    fragment: 'function recoverERC20(address token, address recipient, uint256 amount)',
    priorityScore: 91,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT', 'AMOUNT'],
  },
  {
    fragment: 'function withdrawToken(address token, address recipient, uint256 amount)',
    priorityScore: 90,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: true,
    paramRoles: ['TOKEN', 'RECIPIENT', 'AMOUNT'],
  },
  {
    fragment: 'function executeDirectFlashArb(address recipient)',
    priorityScore: 89,
    supportsToken: false,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['RECIPIENT'],
  },
  {
    fragment: 'function rescueETH(address recipient)',
    priorityScore: 88,
    supportsToken: false,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['RECIPIENT'],
  },
  {
    fragment: 'function sweepETH(address recipient)',
    priorityScore: 87,
    supportsToken: false,
    supportsNative: true,
    directToRecipient: true,
    paramRoles: ['RECIPIENT'],
  },
  {
    fragment: 'function rescueTokens(address token)',
    priorityScore: 75,
    supportsToken: true,
    supportsNative: true,
    directToRecipient: false,
    paramRoles: ['TOKEN'],
  },
  {
    fragment: 'function sweep(address token)',
    priorityScore: 74,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: false,
    paramRoles: ['TOKEN'],
  },
  {
    fragment: 'function sweepTokens(address token)',
    priorityScore: 73,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: false,
    paramRoles: ['TOKEN'],
  },
  {
    fragment: 'function sweepToken(address token)',
    priorityScore: 72,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: false,
    paramRoles: ['TOKEN'],
  },
  {
    fragment: 'function recoverERC20(address token, uint256 amount)',
    priorityScore: 70,
    supportsToken: true,
    supportsNative: false,
    directToRecipient: false,
    paramRoles: ['TOKEN', 'AMOUNT'],
  },
];

export const KNOWN_RESCUE_SWEEP_SIGNATURES: RescueSweepFunctionSpec[] = KNOWN_RESCUE_TEMPLATES.map((tpl) => {
  const iface = new ethers.Interface([tpl.fragment]);
  const fn = iface.fragments[0] as ethers.FunctionFragment;
  const sig = fn.format('sighash');
  return {
    name: fn.name,
    signature: sig,
    selector: fn.selector.toLowerCase(),
    source: 'BYTECODE',
    paramTypes: fn.inputs.map((p) => p.type),
    paramRoles: tpl.paramRoles,
    directToRecipient: tpl.directToRecipient,
    supportsToken: tpl.supportsToken,
    supportsNative: tpl.supportsNative,
    requiresOwnerFollowUpTransfer: !tpl.directToRecipient && tpl.supportsToken,
    encodable: true,
    priorityScore: tpl.priorityScore,
    stateMutability: fn.stateMutability || 'nonpayable',
  };
});

const RESCUE_SWEEP_NAME_REGEX =
  /^(rescue|sweep|recover|emergencyWithdraw|withdrawToken|withdrawERC20|drain|executeDirectFlashArb)/i;

const BROAD_RESCUE_REGEX =
  /(rescue|sweep|recover|emergency.*withdraw|withdraw.*token|withdraw.*erc20|executeDirectFlashArb)/i;

function classifyAbiParameters(fnName: string, inputs: readonly ethers.ParamType[]): {
  paramRoles: RescueSweepParamRole[];
  directToRecipient: boolean;
  supportsToken: boolean;
  supportsNative: boolean;
  encodable: boolean;
} {
  const lowerFn = fnName.toLowerCase();
  const isNativeOnlyName =
    /(eth|native|ether|bnb|matic|avax)$/i.test(lowerFn) || lowerFn === 'executedirectflasharb';
  const paramRoles: RescueSweepParamRole[] = [];
  let addressSeen = 0;

  for (const param of inputs) {
    const type = param.type;
    const pName = (param.name || '').toLowerCase();

    if (type === 'address') {
      addressSeen += 1;
      const explicitlyRecipient =
        /^(to|_to|recipient|_recipient|dest|destination|beneficiary|vault|profit|receiver|target|owner)$/.test(
          pName
        ) || /(recipient|dest|beneficiary|vault|profit|receiver)/.test(pName);
      const explicitlyToken =
        /^(token|_token|asset|_asset|erc20|coin|tokenaddress)$/.test(pName) ||
        /(token|asset|erc20|coin)/.test(pName);

      if (explicitlyRecipient) {
        paramRoles.push('RECIPIENT');
      } else if (explicitlyToken) {
        paramRoles.push('TOKEN');
      } else if (isNativeOnlyName) {
        paramRoles.push('RECIPIENT');
      } else if (addressSeen === 1) {
        paramRoles.push('TOKEN');
      } else if (addressSeen === 2) {
        paramRoles.push('RECIPIENT');
      } else {
        paramRoles.push('OTHER');
      }
    } else if (/^uint\d*$/.test(type)) {
      paramRoles.push('AMOUNT');
    } else {
      paramRoles.push('OTHER');
    }
  }

  const hasToken = paramRoles.includes('TOKEN');
  const hasRecipient = paramRoles.includes('RECIPIENT');
  const hasOther = paramRoles.includes('OTHER');

  const supportsToken = hasToken;
  const supportsNative =
    isNativeOnlyName ||
    lowerFn === 'rescuetokensto' ||
    lowerFn === 'rescuetokens' ||
    lowerFn === 'sweep' ||
    lowerFn === 'sweeptokens';

  return {
    paramRoles,
    directToRecipient: hasRecipient,
    supportsToken,
    supportsNative,
    encodable: !hasOther && (hasToken || hasRecipient),
  };
}

export function inspectAbiForRescueSweep(abiInput: unknown): RescueSweepFunctionSpec[] {
  let parsedAbi: unknown = abiInput;
  if (typeof abiInput === 'string') {
    const trimmed = abiInput.trim();
    if (!trimmed) return [];
    try {
      parsedAbi = JSON.parse(trimmed);
    } catch {
      throw new Error('Provided ABI string is not valid JSON.');
    }
  }

  if (parsedAbi && typeof parsedAbi === 'object' && !Array.isArray(parsedAbi)) {
    const obj = parsedAbi as Record<string, unknown>;
    if (Array.isArray(obj.abi)) {
      parsedAbi = obj.abi;
    } else if (typeof obj.result === 'string') {
      try {
        parsedAbi = JSON.parse(obj.result);
      } catch {
        return [];
      }
    }
  }

  if (!Array.isArray(parsedAbi) || parsedAbi.length === 0) {
    return [];
  }

  let iface: ethers.Interface;
  try {
    iface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
  } catch (err: any) {
    throw new Error(`Invalid contract ABI format: ${err?.message || 'Unable to parse ABI fragments.'}`);
  }

  const results: RescueSweepFunctionSpec[] = [];
  const seenSelectors = new Set<string>();

  for (const frag of iface.fragments) {
    if (frag.type !== 'function') continue;
    const fn = frag as ethers.FunctionFragment;
    if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') continue;
    if (!RESCUE_SWEEP_NAME_REGEX.test(fn.name) && !BROAD_RESCUE_REGEX.test(fn.name)) continue;

    const selector = fn.selector.toLowerCase();
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    const classified = classifyAbiParameters(fn.name, fn.inputs);
    const knownMatch = KNOWN_RESCUE_SWEEP_SIGNATURES.find((k) => k.selector === selector);

    let priorityScore = knownMatch?.priorityScore ?? 60;
    if (!knownMatch) {
      if (classified.directToRecipient) priorityScore += 25;
      if (classified.supportsToken && !classified.paramRoles.includes('AMOUNT')) priorityScore += 6; // full-balance sweep saves calldata + RPC ops
      if (fn.name.toLowerCase().includes('rescue') || fn.name.toLowerCase().includes('sweep')) {
        priorityScore += 5;
      }
    }

    results.push({
      name: fn.name,
      signature: fn.format('sighash'),
      selector,
      source: 'ABI',
      paramTypes: fn.inputs.map((p) => p.type),
      paramRoles: classified.paramRoles,
      directToRecipient: classified.directToRecipient,
      supportsToken: classified.supportsToken,
      supportsNative: classified.supportsNative,
      requiresOwnerFollowUpTransfer: !classified.directToRecipient && classified.supportsToken,
      encodable: classified.encodable,
      priorityScore,
      stateMutability: fn.stateMutability || 'nonpayable',
    });
  }

  return results.sort((a, b) => b.priorityScore - a.priorityScore);
}

export function detectBytecodeRescueSweepFunctions(bytecodeHex: string): RescueSweepFunctionSpec[] {
  if (typeof bytecodeHex !== 'string' || bytecodeHex === '0x' || bytecodeHex.length < 10) {
    return [];
  }
  const lower = bytecodeHex.toLowerCase();
  return KNOWN_RESCUE_SWEEP_SIGNATURES.filter((spec) => {
    const selNoPrefix = spec.selector.slice(2).toLowerCase();
    return lower.includes(selNoPrefix);
  }).sort((a, b) => b.priorityScore - a.priorityScore);
}

export function mergeDetectedRescueSweepFunctions(
  abiFunctions: RescueSweepFunctionSpec[],
  bytecodeFunctions: RescueSweepFunctionSpec[]
): RescueSweepFunctionSpec[] {
  const bySelector = new Map<string, RescueSweepFunctionSpec>();

  for (const fn of bytecodeFunctions) {
    bySelector.set(fn.selector.toLowerCase(), fn);
  }
  for (const fn of abiFunctions) {
    // Verified / supplied ABI overrides bytecode guesswork on metadata & param names
    bySelector.set(fn.selector.toLowerCase(), fn);
  }

  return Array.from(bySelector.values()).sort((a, b) => b.priorityScore - a.priorityScore);
}

export function encodeRescueSweepCall(
  fnSpec: RescueSweepFunctionSpec,
  params: {
    tokenAddress: string | null;
    recipient: string;
    amountWei: bigint;
  }
): { ok: true; data: string } | { ok: false; error: string } {
  if (!fnSpec.encodable) {
    return {
      ok: false,
      error: `Function ${fnSpec.signature} has unsupported parameter types for automated recovery.`,
    };
  }

  const recipientAddr = normalizeValidContractAddress(params.recipient);
  if (!recipientAddr && fnSpec.paramRoles.includes('RECIPIENT')) {
    return { ok: false, error: 'Valid non-zero recipient address is required.' };
  }

  const tokenArg =
    params.tokenAddress === null
      ? ethers.ZeroAddress
      : normalizeValidContractAddress(params.tokenAddress);

  if (fnSpec.paramRoles.includes('TOKEN') && params.tokenAddress !== null && !tokenArg) {
    return { ok: false, error: `Invalid token address '${params.tokenAddress}'.` };
  }

  const args: any[] = [];
  for (let i = 0; i < fnSpec.paramRoles.length; i++) {
    const role = fnSpec.paramRoles[i];
    if (role === 'TOKEN') {
      args.push(tokenArg ?? ethers.ZeroAddress);
    } else if (role === 'RECIPIENT') {
      args.push(recipientAddr);
    } else if (role === 'AMOUNT') {
      args.push(params.amountWei);
    } else {
      return {
        ok: false,
        error: `Unsupported parameter role at index ${i} in ${fnSpec.signature}.`,
      };
    }
  }

  try {
    const iface = new ethers.Interface([`function ${fnSpec.signature}`]);
    const data = iface.encodeFunctionData(fnSpec.signature, args);
    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      error: `Failed to ABI-encode ${fnSpec.signature}: ${err?.message || 'Encoding error'}`,
    };
  }
}

export interface TrappedAssetCandidate {
  symbol: string;
  address: string | null;
  decimals: number;
  rawBalance: bigint;
  formattedBalance: string;
  usdValue: number | null;
  isNative: boolean;
}

export interface RecoveryPlanStep {
  id: string;
  stepIndex: number;
  actionType: 'CONTRACT_RESCUE_DIRECT' | 'CONTRACT_RESCUE_TO_OWNER' | 'OWNER_FORWARD_TRANSFER';
  functionName: string;
  functionSignature: string;
  selector: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  amountWei: string;
  amountFormatted: string;
  usdValue: number | null;
  targetContract: string;
  from: string;
  to: string;
  recipient: string;
  calldata: string;
  estimatedGasUnits: string;
  estimatedGasCostWei: string;
  estimatedGasCostEth: string;
  estimatedGasCostUsd: number | null;
  singleTxToProfitVault: boolean;
  status: 'PLANNED' | 'SKIPPED_DUST' | 'UNSUPPORTED_ASSET' | 'SIMULATION_FAILED';
  reason?: string;
}

export interface GasOptimizedRecoveryPlan {
  contractAddress: string;
  contractOwner: string | null;
  profitWallet: string;
  gasOptimizationStrategy: string;
  executableSteps: RecoveryPlanStep[];
  skippedSteps: RecoveryPlanStep[];
  totalEstimatedGasUnits: string;
  totalEstimatedGasCostWei: string;
  totalEstimatedGasCostEth: string;
  totalEstimatedGasCostUsd: number | null;
  totalRecoverableUsd: number;
  gasSavedByDirectCallUnits: string;
}

export function planGasOptimizedRecovery(params: {
  contractAddress: string;
  contractOwner: string | null;
  profitWallet: string;
  detectedFunctions: RescueSweepFunctionSpec[];
  trappedAssets: TrappedAssetCandidate[];
  effectiveGasPriceWei: bigint;
  ethPriceUsd?: number | null;
  skipGasNegativeDust?: boolean;
}): GasOptimizedRecoveryPlan {
  const skipDust = params.skipGasNegativeDust !== false;
  const ethUsd =
    typeof params.ethPriceUsd === 'number' && Number.isFinite(params.ethPriceUsd) && params.ethPriceUsd > 0
      ? params.ethPriceUsd
      : null;

  const ownerAddr = params.contractOwner || ethers.ZeroAddress;
  const ownerIsProfitWallet =
    Boolean(params.contractOwner) &&
    params.contractOwner!.toLowerCase() === params.profitWallet.toLowerCase();

  const encodableFuncs = params.detectedFunctions
    .filter((f) => f.encodable)
    .sort((a, b) => b.priorityScore - a.priorityScore);

  const rawSteps: RecoveryPlanStep[] = [];
  const skippedSteps: RecoveryPlanStep[] = [];
  let directTxCount = 0;
  let gasSavedByDirectCall = 0n;

  for (const asset of params.trappedAssets) {
    if (asset.rawBalance <= 0n) continue;

    const candidates = encodableFuncs.filter((fn) =>
      asset.isNative ? fn.supportsNative : fn.supportsToken
    );

    if (candidates.length === 0) {
      skippedSteps.push({
        id: `skip-${asset.symbol.toLowerCase()}`,
        stepIndex: 0,
        actionType: 'CONTRACT_RESCUE_DIRECT',
        functionName: 'none',
        functionSignature: 'N/A',
        selector: '0x00000000',
        tokenSymbol: asset.symbol,
        tokenAddress: asset.address,
        amountWei: asset.rawBalance.toString(),
        amountFormatted: asset.formattedBalance,
        usdValue: asset.usdValue,
        targetContract: params.contractAddress,
        from: ownerAddr,
        to: params.contractAddress,
        recipient: params.profitWallet,
        calldata: '0x',
        estimatedGasUnits: '0',
        estimatedGasCostWei: '0',
        estimatedGasCostEth: '0',
        estimatedGasCostUsd: null,
        singleTxToProfitVault: false,
        status: 'UNSUPPORTED_ASSET',
        reason: asset.isNative
          ? 'No native ETH/gas coin rescue or sweep function detected in ABI/bytecode.'
          : `No ERC-20 token rescue or sweep function detected in ABI/bytecode for ${asset.symbol}.`,
      });
      continue;
    }

    const chosen = candidates[0];
    const encoded = encodeRescueSweepCall(chosen, {
      tokenAddress: asset.isNative ? null : asset.address,
      recipient: params.profitWallet,
      amountWei: asset.rawBalance,
    });

    if (!encoded.ok) {
      skippedSteps.push({
        id: `err-${asset.symbol.toLowerCase()}`,
        stepIndex: 0,
        actionType: 'CONTRACT_RESCUE_DIRECT',
        functionName: chosen.name,
        functionSignature: chosen.signature,
        selector: chosen.selector,
        tokenSymbol: asset.symbol,
        tokenAddress: asset.address,
        amountWei: asset.rawBalance.toString(),
        amountFormatted: asset.formattedBalance,
        usdValue: asset.usdValue,
        targetContract: params.contractAddress,
        from: ownerAddr,
        to: params.contractAddress,
        recipient: params.profitWallet,
        calldata: '0x',
        estimatedGasUnits: '0',
        estimatedGasCostWei: '0',
        estimatedGasCostEth: '0',
        estimatedGasCostUsd: null,
        singleTxToProfitVault: false,
        status: 'SIMULATION_FAILED',
        reason: encoded.error,
      });
      continue;
    }

    const needsSecondHop = !chosen.directToRecipient && !ownerIsProfitWallet;
    const baseGasRescue = chosen.directToRecipient ? 54_000n : 52_000n;
    const followUpGas = needsSecondHop ? (asset.isNative ? 21_000n : 65_000n) : 0n;
    const totalEstGasForAsset = baseGasRescue + followUpGas;
    const estCostWei = totalEstGasForAsset * params.effectiveGasPriceWei;
    const estCostEthNum = Number(ethers.formatEther(estCostWei));
    const estCostUsd = ethUsd !== null ? Number((estCostEthNum * ethUsd).toFixed(4)) : null;

    if (
      skipDust &&
      asset.usdValue !== null &&
      estCostUsd !== null &&
      estCostUsd > asset.usdValue
    ) {
      skippedSteps.push({
        id: `dust-${asset.symbol.toLowerCase()}`,
        stepIndex: 0,
        actionType: chosen.directToRecipient ? 'CONTRACT_RESCUE_DIRECT' : 'CONTRACT_RESCUE_TO_OWNER',
        functionName: chosen.name,
        functionSignature: chosen.signature,
        selector: chosen.selector,
        tokenSymbol: asset.symbol,
        tokenAddress: asset.address,
        amountWei: asset.rawBalance.toString(),
        amountFormatted: asset.formattedBalance,
        usdValue: asset.usdValue,
        targetContract: params.contractAddress,
        from: ownerAddr,
        to: params.contractAddress,
        recipient: chosen.directToRecipient || ownerIsProfitWallet ? params.profitWallet : ownerAddr,
        calldata: encoded.data,
        estimatedGasUnits: totalEstGasForAsset.toString(),
        estimatedGasCostWei: estCostWei.toString(),
        estimatedGasCostEth: ethers.formatEther(estCostWei),
        estimatedGasCostUsd: estCostUsd,
        singleTxToProfitVault: !needsSecondHop,
        status: 'SKIPPED_DUST',
        reason: `Gas optimization skipped dust: est. gas ($${estCostUsd.toFixed(4)}) exceeds ${asset.symbol} value ($${asset.usdValue.toFixed(4)}).`,
      });
      continue;
    }

    if (!needsSecondHop) {
      directTxCount += 1;
      // Direct 1-tx rescue/sweep saves a 65k ERC-20 transfer (or 21k ETH transfer) + 21k tx base overhead vs two-step owner hop
      gasSavedByDirectCall += asset.isNative ? 21_000n : 65_000n;
    }

    const rescueGasWei = baseGasRescue * params.effectiveGasPriceWei;
    const rescueGasUsd = ethUsd !== null ? Number((Number(ethers.formatEther(rescueGasWei)) * ethUsd).toFixed(4)) : null;

    rawSteps.push({
      id: `rescue-${asset.symbol.toLowerCase()}-1`,
      stepIndex: 0,
      actionType: chosen.directToRecipient || ownerIsProfitWallet ? 'CONTRACT_RESCUE_DIRECT' : 'CONTRACT_RESCUE_TO_OWNER',
      functionName: chosen.name,
      functionSignature: chosen.signature,
      selector: chosen.selector,
      tokenSymbol: asset.symbol,
      tokenAddress: asset.address,
      amountWei: asset.rawBalance.toString(),
      amountFormatted: asset.formattedBalance,
      usdValue: asset.usdValue,
      targetContract: params.contractAddress,
      from: ownerAddr,
      to: params.contractAddress,
      recipient: chosen.directToRecipient || ownerIsProfitWallet ? params.profitWallet : ownerAddr,
      calldata: encoded.data,
      estimatedGasUnits: baseGasRescue.toString(),
      estimatedGasCostWei: rescueGasWei.toString(),
      estimatedGasCostEth: ethers.formatEther(rescueGasWei),
      estimatedGasCostUsd: rescueGasUsd,
      singleTxToProfitVault: !needsSecondHop,
      status: 'PLANNED',
    });

    if (needsSecondHop && !asset.isNative && asset.address) {
      const fwdData = encodeErc20Transfer(params.profitWallet, asset.rawBalance);
      const fwdGasWei = followUpGas * params.effectiveGasPriceWei;
      const fwdGasUsd = ethUsd !== null ? Number((Number(ethers.formatEther(fwdGasWei)) * ethUsd).toFixed(4)) : null;

      rawSteps.push({
        id: `forward-${asset.symbol.toLowerCase()}-2`,
        stepIndex: 0,
        actionType: 'OWNER_FORWARD_TRANSFER',
        functionName: 'transfer',
        functionSignature: 'transfer(address,uint256)',
        selector: '0xa9059cbb',
        tokenSymbol: asset.symbol,
        tokenAddress: asset.address,
        amountWei: asset.rawBalance.toString(),
        amountFormatted: asset.formattedBalance,
        usdValue: asset.usdValue,
        targetContract: asset.address,
        from: ownerAddr,
        to: asset.address,
        recipient: params.profitWallet,
        calldata: fwdData,
        estimatedGasUnits: followUpGas.toString(),
        estimatedGasCostWei: fwdGasWei.toString(),
        estimatedGasCostEth: ethers.formatEther(fwdGasWei),
        estimatedGasCostUsd: fwdGasUsd,
        singleTxToProfitVault: false,
        status: 'PLANNED',
        reason: `2-step forward because ${chosen.signature} withdraws to contract owner (${ownerAddr.slice(0, 6)}...${ownerAddr.slice(-4)}) before forwarding to FLASH_ARB_PROFIT_WALLET.`,
      });
    } else if (needsSecondHop && asset.isNative) {
      const fwdGasWei = followUpGas * params.effectiveGasPriceWei;
      const fwdGasUsd = ethUsd !== null ? Number((Number(ethers.formatEther(fwdGasWei)) * ethUsd).toFixed(4)) : null;

      rawSteps.push({
        id: `forward-${asset.symbol.toLowerCase()}-2`,
        stepIndex: 0,
        actionType: 'OWNER_FORWARD_TRANSFER',
        functionName: 'transferNative',
        functionSignature: 'transfer(address,uint256)',
        selector: '0x00000000',
        tokenSymbol: asset.symbol,
        tokenAddress: null,
        amountWei: asset.rawBalance.toString(),
        amountFormatted: asset.formattedBalance,
        usdValue: asset.usdValue,
        targetContract: params.profitWallet,
        from: ownerAddr,
        to: params.profitWallet,
        recipient: params.profitWallet,
        calldata: '0x',
        estimatedGasUnits: followUpGas.toString(),
        estimatedGasCostWei: fwdGasWei.toString(),
        estimatedGasCostEth: ethers.formatEther(fwdGasWei),
        estimatedGasCostUsd: fwdGasUsd,
        singleTxToProfitVault: false,
        status: 'PLANNED',
        reason: `2-step native forward because ${chosen.signature} withdraws to contract owner (${ownerAddr.slice(0, 6)}...${ownerAddr.slice(-4)}) before forwarding to FLASH_ARB_PROFIT_WALLET.`,
      });
    }
  }

  // Order highest-USD value recoveries first, keeping step-1 before step-2 for same token
  rawSteps.sort((a, b) => {
    const usdDiff = (b.usdValue ?? 0) - (a.usdValue ?? 0);
    if (Math.abs(usdDiff) > 0.0001) return usdDiff;
    if (a.tokenSymbol === b.tokenSymbol) {
      return a.actionType === 'OWNER_FORWARD_TRANSFER' ? 1 : -1;
    }
    return a.tokenSymbol.localeCompare(b.tokenSymbol);
  });

  const executableSteps = rawSteps.map((step, idx) => ({
    ...step,
    stepIndex: idx + 1,
  }));

  const totalEstGas = executableSteps.reduce((acc, s) => acc + BigInt(s.estimatedGasUnits), 0n);
  const totalEstCostWei = executableSteps.reduce((acc, s) => acc + BigInt(s.estimatedGasCostWei), 0n);
  const totalEstCostUsd =
    ethUsd !== null ? Number((Number(ethers.formatEther(totalEstCostWei)) * ethUsd).toFixed(4)) : null;

  const recoveredTokenKeys = new Set<string>();
  let totalRecoverableUsd = 0;
  for (const s of executableSteps) {
    const key = s.tokenAddress || s.tokenSymbol;
    if (!recoveredTokenKeys.has(key)) {
      recoveredTokenKeys.add(key);
      totalRecoverableUsd += s.usdValue ?? 0;
    }
  }

  const strategyParts: string[] = [];
  if (directTxCount > 0) {
    strategyParts.push(
      `Direct 1-tx Profit Vault routing selected for ${directTxCount} asset${directTxCount > 1 ? 's' : ''} (~${gasSavedByDirectCall.toString()} gas saved vs owner-hop)`
    );
  }
  if (skippedSteps.some((s) => s.status === 'SKIPPED_DUST')) {
    strategyParts.push('gas-negative dust filtered out');
  }
  if (strategyParts.length === 0) {
    strategyParts.push('EIP-1559 priority fee capping + live pre-flight simulation');
  }

  return {
    contractAddress: params.contractAddress,
    contractOwner: params.contractOwner,
    profitWallet: params.profitWallet,
    gasOptimizationStrategy: strategyParts.join(' · '),
    executableSteps,
    skippedSteps,
    totalEstimatedGasUnits: totalEstGas.toString(),
    totalEstimatedGasCostWei: totalEstCostWei.toString(),
    totalEstimatedGasCostEth: ethers.formatEther(totalEstCostWei),
    totalEstimatedGasCostUsd: totalEstCostUsd,
    totalRecoverableUsd: Number(totalRecoverableUsd.toFixed(2)),
    gasSavedByDirectCallUnits: gasSavedByDirectCall.toString(),
  };
}
