import crypto from 'crypto';
import { fetchLiveTickers, fetchLiveTickerFor, getAssetDefinition } from './liveMarketData.ts';

export type SpotExchangeId = 'KRAKEN' | 'BINANCE' | 'COINBASE' | 'NONKYC' | 'OKX';

export interface WalletCredential {
  apiKey: string;
  apiSecret: string;
  depositAddress?: string;
  walletLabel?: string;
  passphrase?: string;
  linkedAt?: number;
  isAddressOnly?: boolean;
  customBalances?: Record<string, string | number>;
  authError?: string;
  isVerified?: boolean;
  verificationSource?: 'EXCHANGE_API' | 'ONCHAIN_RPC' | 'UNLINKED' | 'AUTH_ERROR';
}

export const SUPPORTED_SPOT_EXCHANGES: SpotExchangeId[] = [
  'KRAKEN',
  'COINBASE',
  'BINANCE',
  'NONKYC',
  'OKX',
];

export const EXCHANGE_TAKER_FEE_RATES: Record<SpotExchangeId, number> = {
  KRAKEN: 0.0026,
  COINBASE: 0.004,
  BINANCE: 0.001,
  NONKYC: 0.002,
  OKX: 0.001,
};

export const runtimeCredentials: Record<SpotExchangeId, WalletCredential> = {
  KRAKEN: {
    apiKey: process.env.KRAKEN_API_KEY || '',
    apiSecret: process.env.KRAKEN_API_SECRET || '',
    depositAddress: '',
  },
  BINANCE: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    depositAddress: '',
  },
  COINBASE: {
    apiKey: process.env.COINBASE_API_KEY || '',
    apiSecret: process.env.COINBASE_API_SECRET || '',
    depositAddress: '',
  },
  NONKYC: {
    apiKey: process.env.NONKYC_API_KEY || '',
    apiSecret: process.env.NONKYC_API_SECRET || '',
    depositAddress: '',
  },
  OKX: {
    apiKey: process.env.OKX_API_KEY || '',
    apiSecret: process.env.OKX_API_SECRET || '',
    passphrase: process.env.OKX_PASSPHRASE || '',
    depositAddress: '',
  },
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function liveTradingAllowed(): boolean {
  return process.env.ENABLE_LIVE_TRADING === '1';
}

export const LIVE_TRADING_DISABLED_MSG =
  'Live order placement is disabled on this server. Set ENABLE_LIVE_TRADING=1 in .env to allow real spot liquidations.';

export function getExchangeCredentials(ex: SpotExchangeId): {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
} {
  const c = runtimeCredentials[ex];
  const envMap: Record<SpotExchangeId, { key?: string; secret?: string; pass?: string }> = {
    KRAKEN: { key: process.env.KRAKEN_API_KEY, secret: process.env.KRAKEN_API_SECRET },
    BINANCE: { key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET },
    COINBASE: { key: process.env.COINBASE_API_KEY, secret: process.env.COINBASE_API_SECRET },
    NONKYC: { key: process.env.NONKYC_API_KEY, secret: process.env.NONKYC_API_SECRET },
    OKX: { key: process.env.OKX_API_KEY, secret: process.env.OKX_API_SECRET, pass: process.env.OKX_PASSPHRASE },
  };
  return {
    apiKey: (c.apiKey || envMap[ex].key || '').trim(),
    apiSecret: (c.apiSecret || envMap[ex].secret || '').trim(),
    passphrase: (c.passphrase || envMap[ex].pass || '').trim(),
  };
}

export function isExchangeConfigured(ex: SpotExchangeId): boolean {
  const { apiKey, apiSecret, passphrase } = getExchangeCredentials(ex);
  if (!apiKey || !apiSecret) return false;
  if (ex === 'OKX' && !passphrase) return false;
  return true;
}

export function getExchangeTradingReadiness() {
  const exchanges: Record<SpotExchangeId, { configured: boolean; takerFeeRate: number }> = {
    KRAKEN: { configured: isExchangeConfigured('KRAKEN'), takerFeeRate: EXCHANGE_TAKER_FEE_RATES.KRAKEN },
    COINBASE: { configured: isExchangeConfigured('COINBASE'), takerFeeRate: EXCHANGE_TAKER_FEE_RATES.COINBASE },
    BINANCE: { configured: isExchangeConfigured('BINANCE'), takerFeeRate: EXCHANGE_TAKER_FEE_RATES.BINANCE },
    NONKYC: { configured: isExchangeConfigured('NONKYC'), takerFeeRate: EXCHANGE_TAKER_FEE_RATES.NONKYC },
    OKX: { configured: isExchangeConfigured('OKX'), takerFeeRate: EXCHANGE_TAKER_FEE_RATES.OKX },
  };
  const configuredExchanges = SUPPORTED_SPOT_EXCHANGES.filter((e) => exchanges[e].configured);
  return {
    liveTradingEnabled: liveTradingAllowed(),
    configuredExchanges,
    exchanges,
  };
}

/**
 * Authoritative live USD unit price for an asset or symbol (e.g. BTC, BTC/USDT, ETH-USD).
 * Never uses stale hardcoded fallbacks.
 */
export async function getLiveUsdPrice(symbolOrAsset: string): Promise<number | null> {
  const clean = String(symbolOrAsset || '').trim().toUpperCase();
  if (!clean) return null;

  try {
    const normalizedPair = clean.includes('/') ? clean : `${clean.split(/[-_]/)[0]}/USDT`;
    const ticker = await fetchLiveTickerFor(normalizedPair);
    if (ticker && Number.isFinite(ticker.price) && ticker.price > 0) {
      return ticker.price;
    }
  } catch {
    // Fall back to full ticker list lookup below
  }

  try {
    const { tickers } = await fetchLiveTickers();
    const base = clean.split(/[/\-_]/)[0];
    const hit =
      tickers.find((t) => t.symbol.toUpperCase() === clean) ||
      tickers.find((t) => t.symbol.split('/')[0].toUpperCase() === base);
    return hit && Number.isFinite(hit.price) && hit.price > 0 ? hit.price : null;
  } catch {
    return null;
  }
}

export async function quoteSpotSellUsd(params: {
  exchange: SpotExchangeId;
  symbol: string;
  quantity: number;
}) {
  const cleanSymbol = String(params.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}(?:[\/\-_][A-Z0-9]{1,12})?$/.test(cleanSymbol)) {
    throw Object.assign(new Error('Invalid crypto symbol format. Use a standard pair like BTC/USDT.'), { status: 400 });
  }
  const baseAsset = cleanSymbol.split(/[/\-_]/)[0];
  const qty = Number(params.quantity);
  if (!baseAsset || !Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error('Quantity must be a positive number of crypto units.'), { status: 400 });
  }

  const unitPriceUsd = await getLiveUsdPrice(cleanSymbol);
  if (!unitPriceUsd || !Number.isFinite(unitPriceUsd) || unitPriceUsd <= 0) {
    throw Object.assign(
      new Error(`No live USD market price available for ${cleanSymbol}; refusing to estimate proceeds.`),
      { status: 502 }
    );
  }

  const feeRate = EXCHANGE_TAKER_FEE_RATES[params.exchange] ?? 0.0026;
  const grossUsd = round2(qty * unitPriceUsd);
  const estimatedFeeUsd = round2(grossUsd * feeRate);
  const netUsd = round2(Math.max(0, grossUsd - estimatedFeeUsd));

  return {
    exchange: params.exchange,
    symbol: cleanSymbol.includes('/') ? cleanSymbol : `${baseAsset}/USDT`,
    baseAsset,
    quantity: qty,
    unitPriceUsd,
    grossUsd,
    feeRate,
    estimatedFeeUsd,
    netUsd,
  };
}

export interface SpotSellExecutionResult {
  exchangeOrderId: string;
  exchange: SpotExchangeId;
  symbol: string;
  quantity: number;
  unitPriceUsd: number;
  grossUsd: number;
  exchangeFeeUsd: number;
  netProceedsUsd: number;
  cryptographicReceipt: string;
  note: string;
}

/**
 * Executes a real authenticated spot market SELL order on the configured exchange.
 * Refuses to simulate or fake fills when live trading is disabled or credentials are missing.
 */
export async function executeAuthenticatedSpotSell(params: {
  exchange: SpotExchangeId;
  symbol: string;
  quantity: number;
  maxSingleOrderUsd: number;
}): Promise<SpotSellExecutionResult> {
  const { exchange, symbol, quantity, maxSingleOrderUsd } = params;

  if (!SUPPORTED_SPOT_EXCHANGES.includes(exchange)) {
    throw Object.assign(new Error(`Unsupported spot exchange '${exchange}'.`), { status: 400 });
  }
  if (!liveTradingAllowed()) {
    throw Object.assign(new Error(LIVE_TRADING_DISABLED_MSG), { status: 403 });
  }

  const quote = await quoteSpotSellUsd({ exchange, symbol, quantity });
  if (quote.grossUsd > maxSingleOrderUsd) {
    throw Object.assign(
      new Error(`Spot sale $${quote.grossUsd.toFixed(2)} exceeds single-order risk cap ($${maxSingleOrderUsd.toLocaleString()}).`),
      { status: 400 }
    );
  }
  const envMax = Number(process.env.MAX_ORDER_NOTIONAL_USD || 0);
  if (envMax > 0 && quote.grossUsd > envMax) {
    throw Object.assign(
      new Error(`Spot sale $${quote.grossUsd.toFixed(2)} exceeds MAX_ORDER_NOTIONAL_USD ($${envMax.toLocaleString()}).`),
      { status: 400 }
    );
  }

  const creds = getExchangeCredentials(exchange);
  if (!creds.apiKey || !creds.apiSecret || (exchange === 'OKX' && !creds.passphrase)) {
    throw Object.assign(
      new Error(`${exchange} API credentials are required to liquidate spot crypto. Link your ${exchange} API key & secret first.`),
      { status: 400, requiresCredentials: true }
    );
  }

  const now = Date.now();
  const def = getAssetDefinition(quote.symbol);
  const receipt =
    '0x' +
    crypto
      .createHash('sha256')
      .update(`${now}-${exchange}-${quote.symbol}-SELL-${quantity}`)
      .digest('hex')
      .slice(0, 32);

  if (exchange === 'KRAKEN') {
    const reqPath = '/0/private/AddOrder';
    const nonce = Date.now().toString() + '000';
    const cleanPair = quote.symbol.replace('/USDT', 'USD').replace('/USD', 'USD');
    const pairCode =
      def.krakenKey ||
      def.krakenPair ||
      (cleanPair.includes('BTC') ? 'XXBTZUSD' : cleanPair.includes('ETH') ? 'XETHZUSD' : cleanPair);

    const postParams = new URLSearchParams({
      nonce,
      ordertype: 'market',
      type: 'sell',
      volume: quantity.toFixed(6),
      pair: pairCode,
    });
    const postData = postParams.toString();
    const hash = crypto.createHash('sha256').update(nonce + postData).digest();
    const hmac = crypto
      .createHmac('sha512', Buffer.from(creds.apiSecret, 'base64'))
      .update(Buffer.concat([Buffer.from(reqPath), hash]))
      .digest('base64');

    const kRes = await fetch('https://api.kraken.com' + reqPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': creds.apiKey,
        'API-Sign': hmac,
      },
      body: postData,
      signal: AbortSignal.timeout(12_000),
    });
    const kJson: any = await kRes.json().catch(() => ({}));
    if (!kRes.ok || !kJson?.result?.txid?.[0]) {
      const msg = kJson?.error?.[0] || `Kraken returned HTTP ${kRes.status}`;
      throw Object.assign(new Error(`Kraken spot sell rejected: ${msg}`), { status: kRes.status >= 500 ? 502 : 400 });
    }
    return {
      exchangeOrderId: String(kJson.result.txid[0]),
      exchange,
      symbol: quote.symbol,
      quantity,
      unitPriceUsd: quote.unitPriceUsd,
      grossUsd: quote.grossUsd,
      exchangeFeeUsd: quote.estimatedFeeUsd,
      netProceedsUsd: quote.netUsd,
      cryptographicReceipt: receipt,
      note: `Sold ${quantity} ${quote.baseAsset} on Kraken (${kJson.result.txid[0]})`,
    };
  }

  if (exchange === 'COINBASE') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const requestPath = '/api/v3/brokerage/orders';
    const cleanProd = quote.symbol.includes('BTC')
      ? 'BTC-USD'
      : quote.symbol.includes('ETH')
        ? 'ETH-USD'
        : quote.symbol.replace('/USDT', '-USD').replace('/', '-');
    const orderBody = {
      client_order_id: `ctc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      product_id: cleanProd,
      side: 'SELL',
      order_configuration: {
        market_market_ioc: {
          base_size: quantity.toFixed(6),
        },
      },
    };
    const bodyStr = JSON.stringify(orderBody);
    const sig = crypto.createHmac('sha256', creds.apiSecret).update(timestamp + 'POST' + requestPath + bodyStr).digest('hex');

    const cbRes = await fetch('https://api.coinbase.com' + requestPath, {
      method: 'POST',
      headers: {
        'CB-ACCESS-KEY': creds.apiKey,
        'CB-ACCESS-SIGN': sig,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
      },
      body: bodyStr,
      signal: AbortSignal.timeout(12_000),
    });
    const cbData: any = await cbRes.json().catch(() => ({}));
    if (!cbRes.ok || !cbData?.success || !cbData?.order_id) {
      const msg = cbData?.error_response?.message || cbData?.message || `Coinbase returned HTTP ${cbRes.status}`;
      throw Object.assign(new Error(`Coinbase spot sell rejected: ${msg}`), { status: cbRes.status >= 500 ? 502 : 400 });
    }
    return {
      exchangeOrderId: `cb-${cbData.order_id}`,
      exchange,
      symbol: quote.symbol,
      quantity,
      unitPriceUsd: quote.unitPriceUsd,
      grossUsd: quote.grossUsd,
      exchangeFeeUsd: quote.estimatedFeeUsd,
      netProceedsUsd: quote.netUsd,
      cryptographicReceipt: receipt,
      note: `Sold ${quantity} ${quote.baseAsset} on Coinbase (${cbData.order_id})`,
    };
  }

  if (exchange === 'BINANCE') {
    const timestamp = Date.now();
    const cleanSymbol = (def.binanceSymbol || quote.symbol.replace('/', '')).replace(/[^A-Z0-9]/g, '');
    const qtyStr = quantity.toFixed(8).replace(/\.?0+$/, '');
    const queryParams = `symbol=${encodeURIComponent(cleanSymbol)}&side=SELL&type=MARKET&quantity=${encodeURIComponent(qtyStr)}&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(queryParams).digest('hex');

    const bRes = await fetch(`https://api.binance.com/api/v3/order?${queryParams}&signature=${signature}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    const bJson: any = await bRes.json().catch(() => ({}));
    if (!bRes.ok || !bJson?.orderId) {
      const msg = bJson?.msg || `Binance returned HTTP ${bRes.status}`;
      throw Object.assign(new Error(`Binance spot sell rejected: ${msg}`), { status: bRes.status >= 500 ? 502 : 400 });
    }
    const filledQuote = Number(bJson.cummulativeQuoteQty || 0);
    const grossUsd = filledQuote > 0 ? round2(filledQuote) : quote.grossUsd;
    const feeUsd = round2(grossUsd * EXCHANGE_TAKER_FEE_RATES.BINANCE);
    const netProceedsUsd = round2(Math.max(0, grossUsd - feeUsd));
    return {
      exchangeOrderId: `bin-${bJson.orderId}`,
      exchange,
      symbol: quote.symbol,
      quantity,
      unitPriceUsd: quote.unitPriceUsd,
      grossUsd,
      exchangeFeeUsd: feeUsd,
      netProceedsUsd,
      cryptographicReceipt: receipt,
      note: `Sold ${quantity} ${quote.baseAsset} on Binance (${bJson.orderId})`,
    };
  }

  if (exchange === 'NONKYC') {
    const url = 'https://api.nonkyc.io/api/v2/createorder';
    const nonce = Date.now();
    const body = {
      symbol: def.nonkycPair || quote.symbol.replace('/', '_'),
      side: 'sell',
      type: 'market',
      quantity,
      price: 0,
    };
    const bodyStr = JSON.stringify(body);
    const signPayload = creds.apiKey + url + bodyStr + nonce;
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(signPayload).digest('hex');

    const nkRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': creds.apiKey,
        'X-API-NONCE': nonce.toString(),
        'X-API-SIGN': signature,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(12_000),
    });
    const nkJson: any = await nkRes.json().catch(() => ({}));
    if (!nkRes.ok || !nkJson || nkJson.error || !nkJson.orderId) {
      const msg = nkJson?.error || `NonKYC returned HTTP ${nkRes.status}`;
      throw Object.assign(new Error(`NonKYC spot sell rejected: ${msg}`), { status: nkRes.status >= 500 ? 502 : 400 });
    }
    return {
      exchangeOrderId: `nk-${nkJson.orderId}`,
      exchange,
      symbol: quote.symbol,
      quantity,
      unitPriceUsd: quote.unitPriceUsd,
      grossUsd: quote.grossUsd,
      exchangeFeeUsd: quote.estimatedFeeUsd,
      netProceedsUsd: quote.netUsd,
      cryptographicReceipt: receipt,
      note: `Sold ${quantity} ${quote.baseAsset} on NonKYC (${nkJson.orderId})`,
    };
  }

  // OKX V5
  const timestamp = new Date().toISOString();
  const requestPath = '/api/v5/trade/order';
  const cleanInstId = quote.symbol.replace('/', '-');
  const okxBody = {
    instId: cleanInstId,
    tdMode: 'cash',
    side: 'sell',
    ordType: 'market',
    sz: String(quantity),
  };
  const bodyStr = JSON.stringify(okxBody);
  const sign = crypto.createHmac('sha256', creds.apiSecret).update(timestamp + 'POST' + requestPath + bodyStr).digest('base64');

  const okxRes = await fetch('https://www.okx.com' + requestPath, {
    method: 'POST',
    headers: {
      'OK-ACCESS-KEY': creds.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': creds.passphrase,
      'Content-Type': 'application/json',
    },
    body: bodyStr,
    signal: AbortSignal.timeout(12_000),
  });
  const okxJson: any = await okxRes.json().catch(() => ({}));
  if (!okxRes.ok || okxJson?.code !== '0' || !okxJson?.data?.[0]?.ordId) {
    const msg = okxJson?.msg || okxJson?.data?.[0]?.sMsg || `OKX returned HTTP ${okxRes.status}`;
    throw Object.assign(new Error(`OKX spot sell rejected: ${msg}`), { status: okxRes.status >= 500 ? 502 : 400 });
  }
  return {
    exchangeOrderId: `okx-${okxJson.data[0].ordId}`,
    exchange,
    symbol: quote.symbol,
    quantity,
    unitPriceUsd: quote.unitPriceUsd,
    grossUsd: quote.grossUsd,
    exchangeFeeUsd: quote.estimatedFeeUsd,
    netProceedsUsd: quote.netUsd,
    cryptographicReceipt: receipt,
    note: `Sold ${quantity} ${quote.baseAsset} on OKX (${okxJson.data[0].ordId})`,
  };
}
