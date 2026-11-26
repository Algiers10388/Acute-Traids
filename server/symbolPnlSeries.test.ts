import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSymbolPnlSeries,
  computeRealizedPnlForSymbol,
  computeUnrealizedPnlForSymbol,
} from '../src/utils/symbolPnlSeries.ts';
import type { Candle, Order, Position } from '../src/types.ts';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'ord-1',
    timestamp: 1_000_000,
    symbol: 'BTC/USDT',
    side: 'SELL',
    type: 'TAKE_PROFIT',
    price: 90000,
    amount: 0.1,
    notional: 9000,
    fee: 5,
    exchange: 'BINANCE',
    exchangeName: 'Binance',
    reason: 'TP hit',
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position>): Position {
  return {
    id: 'pos-1',
    symbol: 'BTC/USDT',
    entryPrice: 90000,
    currentPrice: 91800,
    amount: 0.1,
    margin: 4500,
    leverage: 2,
    notional: 9000,
    unrealizedPnl: 180,
    unrealizedPnlPercent: 4,
    highestPrice: 92000,
    liquidationPrice: 45000,
    openTime: 1_020_000,
    takeProfitPrice: 95000,
    stopLossPrice: 87000,
    strategyTrigger: 'TRIPLE_CONFLUENCE_PRO',
    exchange: 'BINANCE',
    exchangeName: 'Binance',
    ...overrides,
  };
}

test('computeRealizedPnlForSymbol and computeUnrealizedPnlForSymbol scope strictly to selected symbol', () => {
  const orders: Order[] = [
    makeOrder({ id: 'o1', symbol: 'BTC/USDT', pnl: 120 }),
    makeOrder({ id: 'o2', symbol: 'ETH/USDT', pnl: 999 }),
    makeOrder({ id: 'o3', symbol: 'BTC/USDT', pnl: -20 }),
  ];
  const positions: Position[] = [
    makePosition({ id: 'p1', symbol: 'BTC/USDT', unrealizedPnl: 75 }),
    makePosition({ id: 'p2', symbol: 'ETH/USDT', unrealizedPnl: -400 }),
    makePosition({ id: 'p3', symbol: 'BTC/USDT', unrealizedPnl: 25 }),
  ];

  assert.equal(computeRealizedPnlForSymbol(orders, 'BTC/USDT'), 100);
  assert.equal(computeRealizedPnlForSymbol(orders, 'ETH/USDT'), 999);
  assert.equal(computeUnrealizedPnlForSymbol(positions, 'BTC/USDT'), 100);
  assert.equal(computeUnrealizedPnlForSymbol(positions, 'ETH/USDT'), -400);
});

test('buildSymbolPnlSeries constructs chronological realized and candle-aligned unrealized PnL points', () => {
  const orders: Order[] = [
    makeOrder({ id: 'o1', symbol: 'BTC/USDT', timestamp: 1_000_000, pnl: 150 }),
    makeOrder({ id: 'o2', symbol: 'ETH/USDT', timestamp: 1_010_000, pnl: 500 }),
    makeOrder({ id: 'o3', symbol: 'BTC/USDT', timestamp: 1_030_000, pnl: -30 }),
  ];
  const positions: Position[] = [
    makePosition({
      id: 'p1',
      symbol: 'BTC/USDT',
      entryPrice: 100,
      currentPrice: 110,
      margin: 1000,
      leverage: 2,
      unrealizedPnl: 200,
      openTime: 1_020_000,
    }),
  ];
  const candles: Candle[] = [
    { time: 1_025_000, open: 100, high: 106, low: 99, close: 105, volume: 10 },
    { time: 1_035_000, open: 105, high: 112, low: 104, close: 108, volume: 12 },
  ];

  const series = buildSymbolPnlSeries({
    symbol: 'BTC/USDT',
    positions,
    orders,
    candles,
    liveSnapshots: [],
    now: 1_040_000,
  });

  // Verify chronological order and excluded ETH/USDT order
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i].timestamp > series[i - 1].timestamp);
  }
  assert.equal(series.some((pt) => pt.realizedPnl === 500), false);

  const candle1 = series.find((p) => p.timestamp === 1_025_000);
  assert.ok(candle1);
  assert.equal(candle1.realizedPnl, 150);
  assert.equal(candle1.unrealizedPnl, 100); // +5% * 2x * $1000 = $100

  const last = series[series.length - 1];
  assert.equal(last.timestamp, 1_040_000);
  assert.equal(last.realizedPnl, 120); // 150 - 30
  assert.equal(last.unrealizedPnl, 200);
});
