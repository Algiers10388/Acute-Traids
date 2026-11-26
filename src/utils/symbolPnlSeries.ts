import { Candle, Order, Position } from '../types';

export interface PnlDataPoint {
  timestamp: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export function computeRealizedPnlForSymbol(orders: Order[], symbol: string): number {
  return orders
    .filter((o) => o.symbol === symbol && typeof o.pnl === 'number' && Number.isFinite(o.pnl))
    .reduce((sum, o) => sum + (o.pnl ?? 0), 0);
}

export function computeUnrealizedPnlForSymbol(positions: Position[], symbol: string): number {
  return positions
    .filter((p) => p.symbol === symbol && Number.isFinite(p.unrealizedPnl))
    .reduce((sum, p) => sum + p.unrealizedPnl, 0);
}

export function buildSymbolPnlSeries(params: {
  symbol: string;
  positions: Position[];
  orders: Order[];
  candles?: Candle[];
  liveSnapshots: PnlDataPoint[];
  now?: number;
}): PnlDataPoint[] {
  const { symbol, positions, orders, candles = [], liveSnapshots } = params;
  const now = params.now ?? Date.now();

  const symbolOrders = orders
    .filter((o) => o.symbol === symbol)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  const symbolPositions = positions.filter((p) => p.symbol === symbol);
  const currentUnrealized = computeUnrealizedPnlForSymbol(positions, symbol);
  const currentRealized = computeRealizedPnlForSymbol(orders, symbol);

  let cumulativeRealized = 0;
  const realizedEvents: Array<{ timestamp: number; realizedPnl: number }> = [];
  for (const ord of symbolOrders) {
    if (typeof ord.pnl === 'number' && Number.isFinite(ord.pnl)) {
      cumulativeRealized += ord.pnl;
      realizedEvents.push({
        timestamp: ord.timestamp,
        realizedPnl: Number(cumulativeRealized.toFixed(4)),
      });
    }
  }

  const getRealizedAt = (ts: number): number => {
    let val = 0;
    for (const ev of realizedEvents) {
      if (ev.timestamp <= ts) val = ev.realizedPnl;
      else break;
    }
    return val;
  };

  const pointsByTime = new Map<number, PnlDataPoint>();

  const earliestOrderTs = symbolOrders[0]?.timestamp;
  const earliestPosTs = symbolPositions.reduce<number | null>(
    (min, p) => (min === null || p.openTime < min ? p.openTime : min),
    null
  );
  const earliestEventTs =
    earliestOrderTs !== undefined && earliestPosTs !== null
      ? Math.min(earliestOrderTs, earliestPosTs)
      : earliestOrderTs ?? earliestPosTs;

  if (earliestEventTs !== null) {
    pointsByTime.set(Math.max(0, earliestEventTs - 5_000), {
      timestamp: Math.max(0, earliestEventTs - 5_000),
      realizedPnl: 0,
      unrealizedPnl: 0,
    });
  }

  if (symbolPositions.length > 0 && candles.length > 0) {
    const oldestOpenTime = Math.min(...symbolPositions.map((p) => p.openTime));
    for (const c of candles) {
      if (c.time >= oldestOpenTime && c.time <= now) {
        let historicalUnrealized = 0;
        for (const pos of symbolPositions) {
          if (pos.openTime <= c.time && pos.entryPrice > 0) {
            const rawPct = ((c.close - pos.entryPrice) / pos.entryPrice) * 100;
            const levPct = rawPct * pos.leverage;
            historicalUnrealized += (pos.margin * levPct) / 100;
          }
        }
        pointsByTime.set(c.time, {
          timestamp: c.time,
          realizedPnl: getRealizedAt(c.time),
          unrealizedPnl: Number(historicalUnrealized.toFixed(4)),
        });
      }
    }
  }

  for (const ev of realizedEvents) {
    const existing = pointsByTime.get(ev.timestamp);
    pointsByTime.set(ev.timestamp, {
      timestamp: ev.timestamp,
      realizedPnl: ev.realizedPnl,
      unrealizedPnl: existing ? existing.unrealizedPnl : 0,
    });
  }

  for (const snap of liveSnapshots) {
    pointsByTime.set(snap.timestamp, {
      timestamp: snap.timestamp,
      realizedPnl: Number(snap.realizedPnl.toFixed(4)),
      unrealizedPnl: Number(snap.unrealizedPnl.toFixed(4)),
    });
  }

  pointsByTime.set(now, {
    timestamp: now,
    realizedPnl: Number(currentRealized.toFixed(4)),
    unrealizedPnl: Number(currentUnrealized.toFixed(4)),
  });

  const sorted = Array.from(pointsByTime.values()).sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length < 2) {
    const sole = sorted[0] ?? {
      timestamp: now,
      realizedPnl: currentRealized,
      unrealizedPnl: currentUnrealized,
    };
    return [
      {
        timestamp: sole.timestamp - 60_000,
        realizedPnl: sole.realizedPnl,
        unrealizedPnl: sole.unrealizedPnl,
      },
      sole,
    ];
  }

  return sorted;
}
