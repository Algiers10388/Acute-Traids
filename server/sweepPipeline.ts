import { normalizeValidContractAddress, type SupportedArbChain } from './flashArbExecutor.ts';

export type SweepDirection = 'TO_PROFIT_VAULT' | 'TO_GAS_WALLET';

export interface ResolveSweepPipelineInput {
  rawDirection?: unknown;
  requestedRecipient?: unknown;
  requestedGasWallet?: unknown;
  requestedProfitWallet?: unknown;
  defaultProfitWallet?: string | null;
  defaultGasWallet?: string | null;
  signerAddress?: string | null;
  hasServerKey?: boolean;
  validConnectedAddr?: string | null;
  includeGasWalletTokens?: boolean;
  includeGasWalletEthSurplus?: boolean;
  includeProfitVaultTokens?: boolean;
  includeProfitVaultEthSurplus?: boolean;
  includeConnectedWalletTokens?: boolean;
  hasSourcePrivateKey?: boolean;
}

export interface ResolveSweepPipelineResult {
  ok: boolean;
  sweepDirection: SweepDirection;
  recipient: string | null;
  profitVaultSource: string | null;
  gasWalletTarget: string | null;
  includeGasWalletTokensEffective: boolean;
  includeGasWalletEthSurplusEffective: boolean;
  includeProfitVaultTokensEffective: boolean;
  includeProfitVaultEthSurplusEffective: boolean;
  hasWalletSweepTarget: boolean;
  canPrepareReverseWithoutServerKey: boolean;
  error?: string;
}

export interface PendingSweepWalletTx {
  chain: SupportedArbChain;
  chainIdHex: string;
  to: string;
  data: string;
  value?: string;
  gas: string;
  source: string;
  sourceLabel: string;
  asset: string;
  amount: string;
  method: string;
  recipient: string;
  signerRequired: string;
}

export function parseSweepDirection(raw: unknown): SweepDirection {
  const normalized = String(raw || '').trim().toUpperCase();
  if (normalized === 'TO_GAS_WALLET' || normalized === 'REVERSE' || normalized === 'TO_GAS') {
    return 'TO_GAS_WALLET';
  }
  return 'TO_PROFIT_VAULT';
}

export function resolveSweepPipelineEndpoints(
  input: ResolveSweepPipelineInput
): ResolveSweepPipelineResult {
  const sweepDirection = parseSweepDirection(input.rawDirection);

  const profitVaultCandidate = normalizeValidContractAddress(
    input.requestedProfitWallet ||
      (sweepDirection === 'TO_PROFIT_VAULT' ? input.requestedRecipient : '') ||
      input.defaultProfitWallet ||
      ''
  );
  const gasWalletCandidate = normalizeValidContractAddress(
    input.requestedGasWallet ||
      (sweepDirection === 'TO_GAS_WALLET' ? input.requestedRecipient : '') ||
      input.signerAddress ||
      input.defaultGasWallet ||
      ''
  );

  if (sweepDirection === 'TO_PROFIT_VAULT') {
    const recipient = profitVaultCandidate;
    if (!recipient) {
      return {
        ok: false,
        sweepDirection,
        recipient: null,
        profitVaultSource: null,
        gasWalletTarget: gasWalletCandidate,
        includeGasWalletTokensEffective: false,
        includeGasWalletEthSurplusEffective: false,
        includeProfitVaultTokensEffective: false,
        includeProfitVaultEthSurplusEffective: false,
        hasWalletSweepTarget: false,
        canPrepareReverseWithoutServerKey: false,
        error: 'Valid non-zero Profit Vault recipient address (0x...) is required.',
      };
    }

    const includeGasWalletTokensEffective = Boolean(input.includeGasWalletTokens && input.signerAddress);
    const includeGasWalletEthSurplusEffective = Boolean(
      input.includeGasWalletEthSurplus && input.signerAddress && input.hasServerKey
    );
    const hasWalletSweepTarget =
      includeGasWalletTokensEffective ||
      includeGasWalletEthSurplusEffective ||
      Boolean(input.includeConnectedWalletTokens && input.validConnectedAddr);

    return {
      ok: true,
      sweepDirection,
      recipient,
      profitVaultSource: profitVaultCandidate,
      gasWalletTarget: gasWalletCandidate,
      includeGasWalletTokensEffective,
      includeGasWalletEthSurplusEffective,
      includeProfitVaultTokensEffective: false,
      includeProfitVaultEthSurplusEffective: false,
      hasWalletSweepTarget,
      canPrepareReverseWithoutServerKey: false,
    };
  }

  // Reverse direction: Contracts + Profit Vault / Connected Wallet -> Gas Execution Wallet
  const recipient = gasWalletCandidate;
  if (!recipient) {
    return {
      ok: false,
      sweepDirection,
      recipient: null,
      profitVaultSource: profitVaultCandidate,
      gasWalletTarget: null,
      includeGasWalletTokensEffective: false,
      includeGasWalletEthSurplusEffective: false,
      includeProfitVaultTokensEffective: false,
      includeProfitVaultEthSurplusEffective: false,
      hasWalletSweepTarget: false,
      canPrepareReverseWithoutServerKey: false,
      error: 'Valid non-zero Gas Execution Wallet recipient address (0x...) is required for reverse sweep.',
    };
  }

  const profitVaultDiffers = Boolean(
    profitVaultCandidate && profitVaultCandidate.toLowerCase() !== recipient.toLowerCase()
  );
  const includeProfitVaultTokensEffective = Boolean(input.includeProfitVaultTokens && profitVaultDiffers);
  const includeProfitVaultEthSurplusEffective = Boolean(
    input.includeProfitVaultEthSurplus && profitVaultDiffers
  );
  const hasConnectedTarget = Boolean(
    input.includeConnectedWalletTokens &&
      input.validConnectedAddr &&
      input.validConnectedAddr.toLowerCase() !== recipient.toLowerCase()
  );
  const hasWalletSweepTarget =
    includeProfitVaultTokensEffective || includeProfitVaultEthSurplusEffective || hasConnectedTarget;

  const canPrepareReverseWithoutServerKey = Boolean(
    includeProfitVaultTokensEffective ||
      includeProfitVaultEthSurplusEffective ||
      hasConnectedTarget ||
      input.hasSourcePrivateKey
  );

  return {
    ok: true,
    sweepDirection,
    recipient,
    profitVaultSource: profitVaultCandidate,
    gasWalletTarget: recipient,
    includeGasWalletTokensEffective: false,
    includeGasWalletEthSurplusEffective: false,
    includeProfitVaultTokensEffective,
    includeProfitVaultEthSurplusEffective,
    hasWalletSweepTarget,
    canPrepareReverseWithoutServerKey,
  };
}
