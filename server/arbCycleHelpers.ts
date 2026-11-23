import { ethers } from 'ethers';
import {
  decodeFlashArbRevertError,
  parseInsufficientProfitError,
  rebuildCandidateWithMinProfit,
  toTokenUnits,
  type EncodedArbitrageCandidate,
  type SupportedArbChain,
} from './flashArbExecutor.ts';

export interface ScoredAnalyzerCandidate {
  cand: EncodedArbitrageCandidate;
  netProfitUsd: number;
  actualProfitUsd: number;
  actualProfitWei: bigint;
}

export interface AnalyzerPreflightEvaluation {
  orderedCandidates: EncodedArbitrageCandidate[];
  scored: ScoredAnalyzerCandidate[];
  bestCandidate: ScoredAnalyzerCandidate | null;
  bestProbeRevertReason: string | null;
  shouldAbortWithoutEstimateGas: boolean;
}

/**
 * Computes a safe execution gasLimit directly from the calibrated optimalGasLimit
 * without needing a slow redundant eth_estimateGas RPC round-trip after the analyzer
 * eth_call pre-flight has already proved on-chain execution succeeds.
 * Note: EVM only charges actual `gasUsed`, never `gasLimit`, and unused gas stays in wallet.
 */
export function computeSafeFlashArbGasLimit(
  chain: SupportedArbChain,
  oppOptimalGasLimit?: number | null
): bigint {
  const calibratedFloor =
    chain === 'arbitrum' || chain === 'apechain'
      ? 420_000
      : chain === 'ethereum'
      ? 450_000
      : 380_000;
  const scaledOptimal =
    typeof oppOptimalGasLimit === 'number' && Number.isFinite(oppOptimalGasLimit) && oppOptimalGasLimit > 0
      ? Math.round(oppOptimalGasLimit * 2.5)
      : 0;
  return BigInt(Math.min(600_000, Math.max(calibratedFloor, scaledOptimal)));
}

/**
 * Evaluates batch `eth_call` analyzer pre-flight responses (with `minProfit = MaxUint256`).
 * When the batch analyzer succeeded (`probeBatchSucceeded === true`) and zero candidates beat the
 * profit threshold, `shouldAbortWithoutEstimateGas` is `true` — preventing redundant sequential
 * `eth_estimateGas` fallback loops over losing candidates.
 */
export function evaluateAnalyzerPreflightCandidates(params: {
  candidates: EncodedArbitrageCandidate[];
  probeResults: any[];
  probeBatchSucceeded: boolean;
  tokenUsdPrice: (sym: string) => number;
  minProfitThresholdUsd: number;
  estGasUsd: number;
  forceTestExecution?: boolean;
}): AnalyzerPreflightEvaluation {
  const {
    candidates,
    probeResults,
    probeBatchSucceeded,
    tokenUsdPrice,
    minProfitThresholdUsd,
    estGasUsd,
    forceTestExecution,
  } = params;

  const scored: ScoredAnalyzerCandidate[] = [];
  let bestProbeRevertReason: string | null = null;
  const minRequiredUsd = forceTestExecution ? 0 : minProfitThresholdUsd + estGasUsd;

  for (const item of probeResults) {
    const idx = Number(item?.id) - 1;
    const cand = candidates[idx];
    if (!cand || !item?.error) continue;

    const ins = parseInsufficientProfitError(item.error);
    if (ins) {
      if (ins.actual > 0n) {
        const tokPrice = tokenUsdPrice(cand.borrowedToken.sym);
        const actualHuman = Number(ethers.formatUnits(ins.actual, cand.borrowedToken.dec));
        const actualProfitUsd = actualHuman * tokPrice;
        if (actualProfitUsd >= minRequiredUsd) {
          const floorWei =
            minRequiredUsd > 0 && tokPrice > 0
              ? toTokenUnits(minRequiredUsd / tokPrice, cand.borrowedToken.dec)
              : 1n;
          const seventyFivePctActual = (ins.actual * 75n) / 100n;
          const desiredMin = floorWei > seventyFivePctActual ? floorWei : seventyFivePctActual;
          const maxSafeMin = ins.actual > 1n ? ins.actual - 1n : 1n;
          const tightenedMinProfit = desiredMin > maxSafeMin ? maxSafeMin : desiredMin > 1n ? desiredMin : 1n;
          scored.push({
            cand: rebuildCandidateWithMinProfit(cand, tightenedMinProfit),
            netProfitUsd: actualProfitUsd - estGasUsd,
            actualProfitUsd,
            actualProfitWei: ins.actual,
          });
        } else {
          bestProbeRevertReason = `InsufficientProfit(actualUsd=$${actualProfitUsd.toFixed(4)}, minRequired=$${minRequiredUsd.toFixed(4)})`;
        }
      } else {
        bestProbeRevertReason = decodeFlashArbRevertError(item.error);
      }
    } else if (!bestProbeRevertReason) {
      bestProbeRevertReason = decodeFlashArbRevertError(item.error);
    }
  }

  scored.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  const orderedCandidates = scored.map((s) => s.cand);

  return {
    orderedCandidates,
    scored,
    bestCandidate: scored[0] || null,
    bestProbeRevertReason,
    shouldAbortWithoutEstimateGas: probeBatchSucceeded && scored.length === 0,
  };
}
