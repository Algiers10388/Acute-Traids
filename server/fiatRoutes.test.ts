// Offline tests for the fiat ledger. Run: npx tsx --test server/fiatRoutes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fiat-'));
process.env.FIAT_LEDGER_PATH = path.join(tmp, 'ledger.json');
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.PLAID_CLIENT_ID = 'plaid_client_test';
process.env.PLAID_SECRET = 'plaid_secret_test';
process.env.PLAID_ENV = 'sandbox';
process.env.PLAID_STORE_PATH = path.join(tmp, 'plaid-items.json');
process.env.PAYPAL_CLIENT_ID = 'pp_client_test';
process.env.PAYPAL_CLIENT_SECRET = 'pp_secret_test';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_PAYOUT_RECIPIENTS = 'Me@Example.com, other@example.com, not-an-email';
process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD = '300';
process.env.FIAT_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 test key "12345678901234567890"

const mod = await import('./fiatRoutes.ts');

// --- minimal express stand-in: records handlers, lets tests call them -----------------------------------------
type H = (req: any, res: any) => any;
const routes = new Map<string, H>();
const app: any = {};
for (const m of ['get', 'post', 'put', 'delete']) app[m] = (p: string, h: H) => routes.set(`${m.toUpperCase()} ${p}`, h);
mod.setupFiatRoutes(app);

async function call(key: string, body: any = {}, headers: any = {}, rawBody?: Buffer, params: any = {}) {
  const h = routes.get(key);
  assert.ok(h, `route ${key} exists`);
  const out: any = { status: 200, body: undefined };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
  await h({ body, headers, rawBody, params }, res);
  return out;
}

const code = (offsetSteps = 0) => mod.totpAt(process.env.FIAT_TOTP_SECRET!, Math.floor(Date.now() / 30000) + offsetSteps);

function mockStripe(handler: (url: string, init: any) => any) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const r = handler(String(url), init);
    // Only a numeric `status` is an HTTP status; a PaymentIntent's own `status` is a string like 'succeeded'.
    const http = typeof r.status === 'number' ? r.status : 200;
    return { ok: http < 400, status: http, json: async () => r.json ?? r };
  }) as any;
  return () => { globalThis.fetch = real; };
}

const piSucceeded = (id: string, cents: number, extra: any = {}) => ({
  id, status: 'succeeded', currency: 'usd', amount: cents, amount_received: cents,
  metadata: { purpose: 'fiat_deposit', direct_to_bot: '0' },
  latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } }, balance_transaction: { fee: Math.round(cents * 0.029 + 30), net: cents - Math.round(cents * 0.029 + 30) } },
  ...extra,
});

test('TOTP matches RFC 6238 SHA-1 vectors (8-digit vector truncated to 6)', () => {
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(mod.totpAt(key, Math.floor(59 / 30)), '287082');
  assert.equal(mod.totpAt(key, Math.floor(1111111109 / 30)), '081804');
  assert.equal(mod.totpAt(key, Math.floor(20000000000 / 30)), '353130');
  assert.equal(mod.verifyTotp(key, '287082', 59_000), Math.floor(59 / 30));
  assert.equal(mod.verifyTotp(key, '000000', 59_000), null);
});

test('fresh ledger is empty: nothing can be spent before a real deposit', async () => {
  const r = await call('GET /api/fiat/account');
  assert.equal(r.body.account.availableBalance, 0);
  const t = await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 10 });
  assert.equal(t.status, 400);
});

test('raw card data is rejected; no Stripe call is made', async () => {
  let called = false;
  const restore = mockStripe(() => { called = true; return {}; });
  try {
    const r = await call('POST /api/fiat/deposit/card', { amount: 50, newCard: { cardNumber: '4242424242424242', cvc: '123' } });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  } finally { restore(); }
});

test('client-minted funds are impossible: unconfigured check returns 503, fake 3DS/withdraw/link routes are 501, sync is read-only', async () => {
  for (const k of ['POST /api/fiat/3ds/initiate', 'POST /api/fiat/3ds/verify', 'POST /api/fiat/withdraw', 'POST /api/fiat/link-card']) {
    const r = await call(k, { amount: 1e9, authCode: '123456', biometricConfirmed: true, endorsementConfirmed: true, payerName: 'Alice', routingNumber: '021000021', accountNumber: '1234' });
    assert.equal(r.status, 501, k);
  }
  const checkUnconfigured = await call('POST /api/fiat/deposit/check', { amount: 100, checkNumber: '101', payerName: 'Alice', endorsementConfirmed: true });
  assert.equal(checkUnconfigured.status, 503);
  assert.equal((await call('GET /api/fiat/config')).body.rails.check, false);

  // bank rails are real now, but a forged request still cannot mint funds: no authorization / no linked bank => rejected
  const forgedLink = await call('POST /api/fiat/link-bank', { publicToken: 'public-x', accountId: 'a', accountHolderName: 'X Y', amount: 1e9 });
  assert.ok(forgedLink.status >= 400);
  const forgedDeposit = await call('POST /api/fiat/deposit/bank', { amount: 1e9, linkedBankId: 'bank-forged' });
  assert.ok(forgedDeposit.status >= 400);
  const s = await call('POST /api/fiat/sync-bot-capital', { botCash: 1e9 });
  assert.equal(s.body.allocatedToTrading, 0);
});

test('card deposit credits NET of Stripe fee only after Stripe says succeeded, and only once', async () => {
  const restore = mockStripe((url) => url.includes('/payment_intents') ? piSucceeded('pi_1', 10000) : {});
  try {
    const r = await call('POST /api/fiat/deposit/card', { amount: 100, paymentMethodId: 'pm_abc' });
    assert.equal(r.status, 200);
    const fee = Math.round(10000 * 0.029 + 30) / 100;
    assert.equal(r.body.account.availableBalance, 100 - fee);
    // same PaymentIntent arriving again (retry / webhook) must not double credit
    const again = await call('POST /api/fiat/deposit/card', { amount: 100, paymentMethodId: 'pm_abc' });
    assert.equal(again.body.account.availableBalance, 100 - fee);
  } finally { restore(); }
});

test('requires_action returns clientSecret and does NOT credit', async () => {
  const before = (await call('GET /api/fiat/account')).body.account.availableBalance;
  const restore = mockStripe(() => ({ id: 'pi_2', status: 'requires_action', client_secret: 'cs_x', metadata: { purpose: 'fiat_deposit' } }));
  try {
    const r = await call('POST /api/fiat/deposit/card', { amount: 20, paymentMethodId: 'pm_abc' });
    assert.equal(r.status, 202);
    assert.equal(r.body.requiresAction, true);
    assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, before);
  } finally { restore(); }
});

test('declined/failed payment credits nothing', async () => {
  const before = (await call('GET /api/fiat/account')).body.account.availableBalance;
  const restore = mockStripe(() => ({ status: 402, json: { error: { message: 'Your card was declined.', code: 'card_declined' } } }));
  try {
    const r = await call('POST /api/fiat/deposit/card', { amount: 20, paymentMethodId: 'pm_abc' });
    assert.ok(r.status >= 400);
    assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, before);
  } finally { restore(); }
});

function signed(body: string, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { raw: Buffer.from(body), header: `t=${t},v1=${sig}` };
}

test('webhook: bad signature rejected; good signature credits once', async () => {
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_hook' } } });
  const bad = signed(body, 'whsec_wrong');
  assert.equal((await call('POST /api/fiat/stripe/webhook', {}, { 'stripe-signature': bad.header }, bad.raw)).status, 400);
  const stale = signed(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await call('POST /api/fiat/stripe/webhook', {}, { 'stripe-signature': stale.header }, stale.raw)).status, 400);

  const restore = mockStripe(() => piSucceeded('pi_hook', 5000));
  try {
    const before = (await call('GET /api/fiat/account')).body.account.availableBalance;
    const ok = signed(body);
    assert.equal((await call('POST /api/fiat/stripe/webhook', {}, { 'stripe-signature': ok.header }, ok.raw)).status, 200);
    const mid = (await call('GET /api/fiat/account')).body.account.availableBalance;
    assert.ok(mid > before);
    const ok2 = signed(body);
    await call('POST /api/fiat/stripe/webhook', {}, { 'stripe-signature': ok2.header }, ok2.raw);
    assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, mid);
  } finally { restore(); }
});

test('transfer-bot: bounded both ways, 2FA required >= $2000 and codes are single-use', async () => {
  const acct = (await call('GET /api/fiat/account')).body.account;
  const avail = acct.availableBalance;
  assert.equal((await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: avail + 1 })).status, 400);
  assert.equal((await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 30 })).status, 200);
  // cannot mint by "returning" more than was allocated
  assert.equal((await call('POST /api/fiat/transfer-bot', { direction: 'FROM_BOT', amount: 31 })).status, 400);
  assert.equal((await call('POST /api/fiat/transfer-bot', { direction: 'FROM_BOT', amount: 30 })).status, 200);
  assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, avail);

  // 2FA gate (balance is too small to execute, but the gate runs first)
  const noCode = await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 2500 });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.requires2FA, true);
  const fake = await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 2500, twoFactorCode: '123456' });
  assert.equal(fake.status, 403);
  const c = code();
  const good = await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 2500, twoFactorCode: c });
  assert.equal(good.status, 400); // passed 2FA, then failed on insufficient funds
  const replay = await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 2500, twoFactorCode: c });
  assert.equal(replay.status, 403); // same code cannot be reused
});

test('kill switch: freezing is free, unfreezing needs a fresh 2FA code; frozen blocks funding the bot', async () => {
  assert.equal((await call('POST /api/fiat/security/update-bot-protection', { emergencyFreezeActive: true })).status, 200);
  assert.equal(mod.isBotEmergencyFrozen(), true);
  assert.equal((await call('POST /api/fiat/transfer-bot', { direction: 'TO_BOT', amount: 1 })).status, 403);
  assert.equal((await call('POST /api/fiat/security/update-bot-protection', { emergencyFreezeActive: false })).status, 403);
  assert.equal((await call('POST /api/fiat/security/update-bot-protection', { emergencyFreezeActive: false, twoFactorCode: '000000' })).status, 403);
  // use the next time-step so it is newer than the code consumed above
  const r = await call('POST /api/fiat/security/update-bot-protection', { emergencyFreezeActive: false, twoFactorCode: code(1) });
  assert.equal(r.status, 200);
  assert.equal(mod.isBotEmergencyFrozen(), false);
});

test('ledger persists to disk and survives a reload', async () => {
  const saved = JSON.parse(fs.readFileSync(process.env.FIAT_LEDGER_PATH!, 'utf8'));
  assert.ok(saved.account.availableBalance > 0);
  assert.ok(saved.processedPaymentIntents.includes('pi_1'));
  assert.equal(fs.statSync(process.env.FIAT_LEDGER_PATH!).mode & 0o777, 0o600);
});

test('audit report makes no fixed compliance claims', async () => {
  const { report } = (await call('GET /api/fiat/security/audit')).body;
  assert.equal(report.pciDssLevel1Compliant, false);
  assert.equal(report.fdicCustodyInsured, false);
  assert.notEqual(report.securityGrade, 'FORTRESS_A_PLUS');
});

test('deposit/confirm (after browser 3DS): validates ids, re-reads Stripe, credits once, refuses foreign PaymentIntents', async () => {
  // malformed id
  assert.equal((await call('POST /api/fiat/deposit/confirm', { paymentIntentId: 'nope' })).status, 400);

  // PaymentIntent that this app did not create
  let restore = mockStripe(() => piSucceeded('pi_foreign1', 5000, { metadata: {} }));
  try {
    assert.equal((await call('POST /api/fiat/deposit/confirm', { paymentIntentId: 'pi_foreign1' })).status, 400);
  } finally { restore(); }

  // still requires action -> 202, nothing credited
  const before = (await call('GET /api/fiat/account')).body.account.availableBalance;
  restore = mockStripe(() => ({ id: 'pi_3ds1', status: 'requires_action', client_secret: 'pi_3ds1_secret_x', currency: 'usd', amount: 5000, metadata: { purpose: 'fiat_deposit', direct_to_bot: '0' } }));
  try {
    const r = await call('POST /api/fiat/deposit/confirm', { paymentIntentId: 'pi_3ds1' });
    assert.equal(r.status, 202);
    assert.equal(r.body.requiresAction, true);
  } finally { restore(); }
  assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, before);

  // succeeded -> credited (net of fee) exactly once, even if confirm is called twice
  restore = mockStripe(() => piSucceeded('pi_ok_confirm1', 10000));
  try {
    const first = await call('POST /api/fiat/deposit/confirm', { paymentIntentId: 'pi_ok_confirm1' });
    assert.equal(first.status, 200);
    assert.equal(first.body.success, true);
    const afterFirst = (await call('GET /api/fiat/account')).body.account.availableBalance;
    assert.ok(afterFirst > before);
    const second = await call('POST /api/fiat/deposit/confirm', { paymentIntentId: 'pi_ok_confirm1' });
    assert.equal(second.status, 200);
    assert.equal((await call('GET /api/fiat/account')).body.account.availableBalance, afterFirst);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Plaid Link + Stripe ACH
// ---------------------------------------------------------------------------------------------------------------
const signedWebhook = (event: any) => {
  const raw = Buffer.from(JSON.stringify(event));
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.`).update(raw).digest('hex');
  return { raw, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } };
};

const ROUTING = '110000000';
const ACCOUNT = '000123456789';
const ACCESS = 'access-sandbox-secret-token';

function plaidAndStripe(extra: (url: string, init: any) => any = () => undefined, seen: { url: string; body: string }[] = []) {
  return mockStripe((url, init) => {
    seen.push({ url, body: String(init?.body ?? '') });
    const custom = extra(url, init);
    if (custom !== undefined) return custom;
    if (url.endsWith('/item/public_token/exchange')) return { access_token: ACCESS, item_id: 'item_1' };
    if (url.endsWith('/auth/get')) {
      return {
        accounts: [{ account_id: 'acc_1', subtype: 'checking', verification_status: null }],
        numbers: { ach: [{ account_id: 'acc_1', routing: ROUTING, account: ACCOUNT }] },
        item: { institution_id: 'ins_1' },
      };
    }
    if (url.endsWith('/institutions/get_by_id')) return { institution: { name: 'Test Bank' } };
    if (url.endsWith('/item/remove')) return { removed: true };
    if (url.endsWith('/customers')) return { id: 'cus_1' };
    if (url.endsWith('/setup_intents')) return { status: 'succeeded', payment_method: 'pm_bank1', mandate: 'mandate_1' };
    if (url.includes('/detach')) return { id: 'pm_bank1' };
    throw new Error(`unexpected fetch ${url}`);
  });
}

test('link-bank: needs explicit authorization; keeps access token + account numbers off the ledger and out of responses', async () => {
  const base = { publicToken: 'public-sandbox-abc', accountId: 'acc_1', accountHolderName: 'Jane Q Public' };
  assert.equal((await call('POST /api/fiat/link-bank', base)).status, 400); // no authorization flag
  assert.equal((await call('POST /api/fiat/link-bank', { ...base, authorizationAccepted: true, accountHolderName: 'J' })).status, 400);

  const seen: { url: string; body: string }[] = [];
  const restore = plaidAndStripe(() => undefined, seen);
  try {
    const r = await call('POST /api/fiat/link-bank', { ...base, authorizationAccepted: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    const bank = r.body.account.linkedBanks[0];
    assert.equal(bank.bankName, 'Test Bank');
    assert.equal(bank.accountNumberMasked, '•••• 6789');
    assert.equal(bank.status, 'VERIFIED');
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(ACCOUNT) && !wire.includes(ACCESS), 'response must not leak numbers or tokens');

    const ledgerFile = fs.readFileSync(process.env.FIAT_LEDGER_PATH!, 'utf8');
    assert.ok(!ledgerFile.includes(ACCOUNT) && !ledgerFile.includes(ACCESS), 'ledger file must not hold secrets');
    assert.ok(fs.readFileSync(process.env.PLAID_STORE_PATH!, 'utf8').includes(ACCESS), 'access token lives in the private store');

    const si = seen.find((c) => c.url.endsWith('/setup_intents'))!;
    assert.ok(si.body.includes('mandate_data%5Bcustomer_acceptance%5D%5Btype%5D=offline'));
    assert.ok(si.body.includes('verification_method%5D=skip'));
    assert.ok(si.body.includes(`routing_number%5D=${ROUTING}`));

    // linking the same account again does not create a second record
    const again = await call('POST /api/fiat/link-bank', { ...base, authorizationAccepted: true });
    assert.equal(again.body.alreadyLinked, true);
    assert.equal(again.body.account.linkedBanks.length, 1);
  } finally { restore(); }
});

test('link-bank: refuses micro-deposit (unverified) accounts and non-depository subtypes, and removes the Plaid item', async () => {
  let removed = 0;
  const restore = plaidAndStripe((url) => {
    if (url.endsWith('/auth/get')) {
      return { accounts: [{ account_id: 'acc_9', subtype: 'checking', verification_status: 'pending_manual_verification' }], numbers: { ach: [{ account_id: 'acc_9', routing: '021000021', account: '999988887777' }] }, item: {} };
    }
    if (url.endsWith('/item/remove')) { removed++; return { removed: true }; }
    return undefined;
  });
  try {
    const r = await call('POST /api/fiat/link-bank', { publicToken: 'public-sandbox-zzz', accountId: 'acc_9', accountHolderName: 'Jane Q Public', authorizationAccepted: true });
    assert.equal(r.status, 409);
    assert.equal(removed, 1);
  } finally { restore(); }
});

test('bank deposit: ACH is PROCESSING (pending hold, no credit) until the signed webhook says succeeded; credited once', async () => {
  const bankId = (await call('GET /api/fiat/account')).body.account.linkedBanks[0].id;
  const before = { ...(await call('GET /api/fiat/account')).body.account };

  // never to the bot, never without a real linked bank, never under $1
  assert.equal((await call('POST /api/fiat/deposit/bank', { amount: 50, linkedBankId: bankId, directToBot: true })).status, 400);
  assert.equal((await call('POST /api/fiat/deposit/bank', { amount: 50, linkedBankId: 'bank-nope' })).status, 404);
  assert.equal((await call('POST /api/fiat/deposit/bank', { amount: 0.5, linkedBankId: bankId })).status, 400);

  const seen: { url: string; body: string }[] = [];
  let restore = plaidAndStripe((url) => (url.includes('/payment_intents') ? { id: 'pi_ach1', status: 'processing' } : undefined), seen);
  try {
    const r = await call('POST /api/fiat/deposit/bank', { amount: 100, linkedBankId: bankId });
    assert.equal(r.status, 202);
    assert.equal(r.body.processing, true);
    const pi = seen.find((c) => c.url.includes('/payment_intents'))!;
    assert.ok(pi.body.includes('customer=cus_1') && pi.body.includes('payment_method=pm_bank1') && pi.body.includes('mandate=mandate_1'));
    assert.ok(pi.body.includes('metadata%5Brail%5D=ach') && pi.body.includes('direct_to_bot%5D=0'));
  } finally { restore(); }

  let acct = { ...(await call('GET /api/fiat/account')).body.account };
  assert.equal(acct.availableBalance, before.availableBalance, 'not credited yet');
  assert.equal(acct.pendingBalance, before.pendingBalance + 100);

  // webhook with a bad signature is rejected
  const evt = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_ach1' } } };
  const bad = signedWebhook(evt);
  assert.equal((await call('POST /api/fiat/stripe/webhook', {}, { 'stripe-signature': 't=1,v1=00' }, bad.raw)).status, 400);

  const achPi = {
    id: 'pi_ach1', status: 'succeeded', currency: 'usd', amount: 10000, amount_received: 10000,
    metadata: { purpose: 'fiat_deposit', rail: 'ach', direct_to_bot: '0', linked_bank_id: bankId },
    latest_charge: { payment_method_details: { us_bank_account: { bank_name: 'Test Bank', last4: '6789' } }, balance_transaction: { fee: 80, net: 9920 } },
  };
  restore = plaidAndStripe((url) => (url.includes('/payment_intents/pi_ach1') ? achPi : undefined));
  try {
    const ok = signedWebhook(evt);
    assert.equal((await call('POST /api/fiat/stripe/webhook', {}, ok.headers, ok.raw)).status, 200);
    const again = signedWebhook(evt); // Stripe retries: must not double credit
    assert.equal((await call('POST /api/fiat/stripe/webhook', {}, again.headers, again.raw)).status, 200);
  } finally { restore(); }

  acct = { ...(await call('GET /api/fiat/account')).body.account };
  assert.equal(Math.round((acct.availableBalance - before.availableBalance) * 100), 9920);
  assert.equal(acct.pendingBalance, before.pendingBalance);
  const txs = (await call('GET /api/fiat/transactions')).body.transactions.filter((t: any) => t.referenceHash === 'pi_ach1');
  assert.equal(txs.length, 1, 'the PROCESSING row is completed in place, not duplicated');
  assert.equal(txs[0].status, 'COMPLETED');
  assert.equal(txs[0].rail, 'ACH_TRANSFER');
  assert.equal(txs[0].fee, 0.8);
});

test('bank deposit: a failed ACH debit releases the pending hold and credits nothing', async () => {
  const bankId = (await call('GET /api/fiat/account')).body.account.linkedBanks[0].id;
  const before = { ...(await call('GET /api/fiat/account')).body.account };
  let restore = plaidAndStripe((url) => (url.includes('/payment_intents') ? { id: 'pi_ach2', status: 'processing' } : undefined));
  try {
    assert.equal((await call('POST /api/fiat/deposit/bank', { amount: 40, linkedBankId: bankId })).status, 202);
  } finally { restore(); }
  assert.equal((await call('GET /api/fiat/account')).body.account.pendingBalance, before.pendingBalance + 40);

  restore = plaidAndStripe((url) => (url.includes('/payment_intents/pi_ach2')
    ? { id: 'pi_ach2', status: 'requires_payment_method', metadata: { purpose: 'fiat_deposit', rail: 'ach' }, last_payment_error: { message: 'Insufficient funds' } }
    : undefined));
  try {
    const w = signedWebhook({ type: 'payment_intent.payment_failed', data: { object: { id: 'pi_ach2' } } });
    assert.equal((await call('POST /api/fiat/stripe/webhook', {}, w.headers, w.raw)).status, 200);
  } finally { restore(); }

  const after = { ...(await call('GET /api/fiat/account')).body.account };
  assert.equal(after.pendingBalance, before.pendingBalance);
  assert.equal(after.availableBalance, before.availableBalance);
  const tx = (await call('GET /api/fiat/transactions')).body.transactions.find((t: any) => t.referenceHash === 'pi_ach2');
  assert.equal(tx.status, 'FAILED');
});

test('unlink bank: removes Plaid item + Stripe method and the private record', async () => {
  const bankId = (await call('GET /api/fiat/account')).body.account.linkedBanks[0].id;
  const seen: { url: string; body: string }[] = [];
  const restore = plaidAndStripe(() => undefined, seen);
  try {
    const r = await call('DELETE /api/fiat/bank/:id', {}, {}, undefined, { id: bankId });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.linkedBanks.length, 0);
  } finally { restore(); }
  assert.ok(seen.some((c) => c.url.endsWith('/item/remove')));
  assert.ok(seen.some((c) => c.url.includes('/payment_methods/pm_bank1/detach')));
  assert.ok(!fs.readFileSync(process.env.PLAID_STORE_PATH!, 'utf8').includes(ACCESS));
});

test('bank rails report unavailable (503) when Plaid is not configured', async () => {
  const saved = process.env.PLAID_SECRET;
  delete process.env.PLAID_SECRET;
  try {
    assert.equal((await call('POST /api/fiat/bank/link-token')).status, 503);
    assert.equal((await call('POST /api/fiat/deposit/bank', { amount: 10, linkedBankId: 'x' })).status, 503);
    assert.equal((await call('GET /api/fiat/config')).body.rails.bank, false);
  } finally { process.env.PLAID_SECRET = saved; }
});

// ---------------------------------------------------------------------------------------------------------------
// PayPal payouts (withdrawals)
// ---------------------------------------------------------------------------------------------------------------
let clockSteps = 3;
/** Each TOTP code is single use and only valid within +-1 step, so move the clock forward for every fresh code. */
async function withTotp<T>(fn: (code: string) => Promise<T>): Promise<T> {
  clockSteps += 3;
  const realNow = Date.now;
  const fake = realNow() + clockSteps * 30000;
  Date.now = () => fake;
  try {
    return await fn(mod.totpAt(process.env.FIAT_TOTP_SECRET!, Math.floor(fake / 30000)));
  } finally {
    Date.now = realNow;
  }
}

type PP = { url: string; method: string; headers: any; body: any };
function paypalMock(onPayout: (p: PP) => any, onGet: (id: string) => any = () => ({ batch_header: { batch_status: 'PENDING' }, items: [{ transaction_status: 'PENDING' }] }), seen: PP[] = []) {
  return mockStripe((url, init) => {
    const rec: PP = { url, method: init?.method || 'GET', headers: init?.headers || {}, body: init?.body && String(init.headers?.['Content-Type']).includes('json') ? JSON.parse(init.body) : init?.body };
    seen.push(rec);
    if (url.endsWith('/v1/oauth2/token')) return { access_token: 'tok_pp', expires_in: 3600 };
    if (url.endsWith('/v1/payments/payouts') && rec.method === 'POST') return onPayout(rec);
    const m = url.match(/\/v1\/payments\/payouts\/([^/?]+)$/);
    if (m) return onGet(decodeURIComponent(m[1]));
    throw new Error(`unexpected fetch ${url}`);
  });
}

const ledger = async () => ({ ...(await call('GET /api/fiat/account')).body.account });
const wd = (extra: any = {}) => ({ amount: 5, recipientId: 0, idempotencyKey: crypto.randomUUID(), ...extra });

test('paypal withdraw: refuses bad input before touching the ledger or PayPal', async () => {
  const seen: PP[] = [];
  const restore = paypalMock(() => { throw new Error('should not be called'); }, undefined, seen);
  try {
    const before = await ledger();
    assert.equal((await call('POST /api/fiat/withdraw/paypal', { amount: 5, recipientId: 0 })).status, 400); // no idempotency key
    await withTotp(async (c) => {
      assert.equal((await call('POST /api/fiat/withdraw/paypal', wd({ recipientId: 7, twoFactorCode: c }))).status, 400); // not a registered recipient
      assert.equal((await call('POST /api/fiat/withdraw/paypal', wd({ recipientId: 2, twoFactorCode: c }))).status, 400); // 'not-an-email' was filtered out
      assert.equal((await call('POST /api/fiat/withdraw/paypal', wd({ amount: 0.5, twoFactorCode: c }))).status, 400);
      const big = await call('POST /api/fiat/withdraw/paypal', wd({ amount: 400, twoFactorCode: c }));
      assert.equal(big.status, 400);
      assert.match(big.body.error, /daily withdrawal limit/);
      process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD = '1000000'; // lift the cap so the balance check is what refuses this
      try {
        const poor = await call('POST /api/fiat/withdraw/paypal', wd({ amount: before.availableBalance + 1, twoFactorCode: c }));
        assert.equal(poor.status, 400);
        assert.match(poor.body.error, /Insufficient funds/);
      } finally { process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD = '300'; }
    });
    // 2FA is always required, whatever the amount
    const no2fa = await call('POST /api/fiat/withdraw/paypal', wd());
    assert.equal(no2fa.status, 403);
    assert.equal(no2fa.body.requires2FA, true);
    assert.deepEqual(await ledger(), before);
    assert.equal(seen.filter((c) => c.url.includes('/payouts')).length, 0);
  } finally { restore(); }
});

test('paypal withdraw: reserves first, pays only a registered recipient, duplicates never pay twice, config hides emails', async () => {
  const cfg = (await call('GET /api/fiat/config')).body;
  assert.equal(cfg.rails.withdrawals, true);
  assert.deepEqual(cfg.rails.paypal.recipients.map((r: any) => r.label), ['m***@example.com', 'o***@example.com']);
  assert.ok(!JSON.stringify(cfg).includes('example.com,') && !JSON.stringify(cfg).toLowerCase().includes('me@example.com'));

  const seen: PP[] = [];
  const restore = paypalMock(() => ({ batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } }), undefined, seen);
  try {
    const before = await ledger();
    const req = wd({ amount: 12.5, recipientId: 0 });
    const r = await withTotp((c) => call('POST /api/fiat/withdraw/paypal', { ...req, twoFactorCode: c }));
    assert.equal(r.status, 202);
    assert.equal(r.body.transaction.status, 'PROCESSING');
    assert.equal(r.body.transaction.externalId, 'BATCH1');
    assert.equal(r.body.transaction.destinationName, 'PayPal m***@example.com');
    assert.equal(Math.round((before.availableBalance - (await ledger()).availableBalance) * 100), 1250);

    const post = seen.find((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts'))!;
    assert.equal(post.body.items[0].receiver, 'me@example.com');
    assert.equal(post.body.items[0].amount.value, '12.50');
    assert.equal(post.body.items[0].recipient_type, 'EMAIL');
    assert.equal(post.headers['PayPal-Request-Id'], post.body.sender_batch_header.sender_batch_id);
    assert.equal(post.headers.Authorization, 'Bearer tok_pp');

    // the exact same request again: no new reservation, no second PayPal call, no 2FA needed
    const dup = await call('POST /api/fiat/withdraw/paypal', req);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
    assert.equal(seen.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/payments/payouts')).length, 1);
    assert.equal(Math.round((before.availableBalance - (await ledger()).availableBalance) * 100), 1250);
  } finally { restore(); }
});

test('paypal withdraw: reconcile moves PENDING -> COMPLETED (fee recorded); a returned payout is refunded exactly once', async () => {
  const txsOf = async () => (await call('GET /api/fiat/transactions')).body.transactions.filter((t: any) => t.type === 'WITHDRAW_TO_PAYPAL');
  const pendingTx = (await txsOf()).find((t: any) => t.externalId === 'BATCH1');
  assert.equal(pendingTx.status, 'PROCESSING');

  let restore = paypalMock(() => ({}), (id) => ({ batch_header: { payout_batch_id: id, batch_status: 'PENDING' }, items: [{ transaction_status: 'PENDING' }] }));
  try {
    await call('POST /api/fiat/withdraw/paypal/reconcile');
    assert.equal((await txsOf()).find((t: any) => t.externalId === 'BATCH1').status, 'PROCESSING');
  } finally { restore(); }

  restore = paypalMock(() => ({}), (id) => ({ batch_header: { payout_batch_id: id, batch_status: 'SUCCESS' }, items: [{ transaction_status: 'SUCCESS', payout_item_fee: { value: '0.25', currency: 'USD' } }] }));
  try {
    const bal = (await ledger()).availableBalance;
    await call('POST /api/fiat/withdraw/paypal/reconcile');
    const done = (await txsOf()).find((t: any) => t.externalId === 'BATCH1');
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.fee, 0.25);
    assert.equal((await ledger()).availableBalance, bal, 'completion does not move the balance again');
  } finally { restore(); }

  // second payout comes back RETURNED -> refunded once, even if reconciled repeatedly
  restore = paypalMock(() => ({ batch_header: { payout_batch_id: 'BATCH2', batch_status: 'PENDING' } }));
  try {
    const before = await ledger();
    const r = await withTotp((c) => call('POST /api/fiat/withdraw/paypal', wd({ amount: 8, twoFactorCode: c })));
    assert.equal(r.status, 202);
    assert.equal(Math.round((before.availableBalance - (await ledger()).availableBalance) * 100), 800);
  } finally { restore(); }
  restore = paypalMock(() => ({}), (id) => ({ batch_header: { payout_batch_id: id, batch_status: 'SUCCESS' }, items: [{ transaction_status: 'RETURNED' }] }));
  try {
    const mid = await ledger();
    await call('POST /api/fiat/withdraw/paypal/reconcile');
    await call('POST /api/fiat/withdraw/paypal/reconcile');
    const after = await ledger();
    assert.equal(Math.round((after.availableBalance - mid.availableBalance) * 100), 800, 'refunded exactly once');
    assert.equal((await txsOf()).find((t: any) => t.externalId === 'BATCH2').status, 'FAILED');
  } finally { restore(); }
});

test('paypal withdraw: a definitive PayPal refusal refunds immediately', async () => {
  const restore = paypalMock(() => ({ status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'Insufficient funds in PayPal balance', details: [{ issue: 'INSUFFICIENT_FUNDS' }] } }));
  try {
    const before = await ledger();
    const r = await withTotp((c) => call('POST /api/fiat/withdraw/paypal', wd({ amount: 9, twoFactorCode: c })));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Insufficient funds/);
    assert.equal((await ledger()).availableBalance, before.availableBalance);
    const failed = (await call('GET /api/fiat/transactions')).body.transactions.find((t: any) => t.type === 'WITHDRAW_TO_PAYPAL' && t.status === 'FAILED' && t.amount === 9);
    assert.ok(failed);
  } finally { restore(); }
});

test('paypal withdraw: unknown outcome stays reserved (no auto-refund); manual resolve needs 2FA and works once', async () => {
  const real = globalThis.fetch;
  const before = await ledger();
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok_pp', expires_in: 3600 }) };
    throw new Error('socket hang up');
  }) as any;
  let txId = '';
  try {
    const r = await withTotp((c) => call('POST /api/fiat/withdraw/paypal', wd({ amount: 6, twoFactorCode: c })));
    assert.equal(r.status, 202);
    assert.equal(r.body.unknownOutcome, true);
    txId = r.body.transaction.id;
  } finally { globalThis.fetch = real; }
  assert.equal(Math.round((before.availableBalance - (await ledger()).availableBalance) * 100), 600, 'amount stays reserved');

  assert.equal((await call('POST /api/fiat/withdraw/paypal/:id/resolve', { action: 'refund' }, {}, undefined, { id: txId })).status, 403); // needs 2FA
  const ok = await withTotp((c) => call('POST /api/fiat/withdraw/paypal/:id/resolve', { action: 'refund', twoFactorCode: c }, {}, undefined, { id: txId }));
  assert.equal(ok.status, 200);
  assert.equal((await ledger()).availableBalance, before.availableBalance);
  const again = await withTotp((c) => call('POST /api/fiat/withdraw/paypal/:id/resolve', { action: 'refund', twoFactorCode: c }, {}, undefined, { id: txId }));
  assert.equal(again.status, 409, 'cannot refund twice');
  assert.equal((await ledger()).availableBalance, before.availableBalance);
});

test('paypal webhook: body is never trusted; it only triggers a re-read from PayPal', async () => {
  let restore = paypalMock(() => ({ batch_header: { payout_batch_id: 'BATCH3', batch_status: 'PENDING' } }));
  try {
    const r = await withTotp((c) => call('POST /api/fiat/withdraw/paypal', wd({ amount: 4, twoFactorCode: c })));
    assert.equal(r.status, 202);
  } finally { restore(); }
  const before = await ledger();

  // a forged "payout failed" event while PayPal says it is still pending: nothing changes
  restore = paypalMock(() => ({}), () => ({ batch_header: { batch_status: 'PENDING' }, items: [{ transaction_status: 'PENDING' }] }));
  try {
    const forged = await call('POST /api/fiat/paypal/webhook', { event_type: 'PAYMENT.PAYOUTS-ITEM.FAILED', resource: { payout_batch_id: 'BATCH3', transaction_status: 'FAILED' } });
    assert.equal(forged.status, 200);
    assert.equal((await ledger()).availableBalance, before.availableBalance);
  } finally { restore(); }

  // a real change on PayPal's side, announced by webhook: ledger follows PayPal's answer
  restore = paypalMock(() => ({}), () => ({ batch_header: { batch_status: 'SUCCESS' }, items: [{ transaction_status: 'BLOCKED' }] }));
  try {
    await call('POST /api/fiat/paypal/webhook', { resource: { payout_batch_id: 'BATCH3' } });
    assert.equal(Math.round(((await ledger()).availableBalance - before.availableBalance) * 100), 400);
    await call('POST /api/fiat/paypal/webhook', {});          // garbage is ignored
    await call('POST /api/fiat/paypal/webhook', { resource: { payout_batch_id: 'nope' } });
  } finally { restore(); }
});

test('paypal withdraw: unavailable (503) without credentials or an allow-listed recipient', async () => {
  const savedSecret = process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_CLIENT_SECRET;
  try {
    assert.equal((await call('POST /api/fiat/withdraw/paypal', wd())).status, 503);
    assert.equal((await call('GET /api/fiat/config')).body.rails.withdrawals, false);
  } finally { process.env.PAYPAL_CLIENT_SECRET = savedSecret; }
  const savedRecips = process.env.PAYPAL_PAYOUT_RECIPIENTS;
  process.env.PAYPAL_PAYOUT_RECIPIENTS = '';
  try {
    assert.equal((await call('POST /api/fiat/withdraw/paypal', wd())).status, 503);
  } finally { process.env.PAYPAL_PAYOUT_RECIPIENTS = savedRecips; }
});

test('2FA TOTP enrollment: configures server store when env var unset and unlocks PayPal withdrawal', async () => {
  const savedEnvTotp = process.env.FIAT_TOTP_SECRET;
  const savedStorePath = process.env.FIAT_TOTP_STORE_PATH;
  delete process.env.FIAT_TOTP_SECRET;
  process.env.FIAT_TOTP_STORE_PATH = path.join(tmp, 'totp-enrolled.json');

  try {
    assert.equal((await call('GET /api/fiat/config')).body.security.twoFactorConfigured, false);
    assert.equal((await call('POST /api/fiat/withdraw/paypal', wd())).status, 503);

    clockSteps += 3;
    const realNow = Date.now;
    const fake1 = realNow() + clockSteps * 30000;
    Date.now = () => fake1;
    let setup: any;
    let confirmRes: any;
    try {
      setup = await call('POST /api/fiat/security/totp/setup');
      assert.equal(setup.status, 200);
      assert.ok(setup.body.secret && setup.body.otpauthUri.startsWith('otpauth://totp/'));

      // wrong code fails confirm
      assert.equal((await call('POST /api/fiat/security/totp/confirm', { code: '000000' })).status, 403);

      // valid code confirms and persists mode 0600
      const firstCode = mod.totpAt(setup.body.secret, Math.floor(fake1 / 30000));
      confirmRes = await call('POST /api/fiat/security/totp/confirm', { code: firstCode });
    } finally {
      Date.now = realNow;
    }
    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.twoFactorConfigured, true);
    assert.equal(fs.statSync(process.env.FIAT_TOTP_STORE_PATH!).mode & 0o777, 0o600);
    assert.equal((await call('GET /api/fiat/config')).body.security.twoFactorConfigured, true);

    // rotating existing enrolled secret requires valid current 2FA code
    assert.equal((await call('POST /api/fiat/security/totp/setup', {})).status, 403);

    // PayPal withdrawal works using enrolled secret on next step
    clockSteps += 3;
    const fake2 = realNow() + clockSteps * 30000;
    const restore = paypalMock(() => ({ batch_header: { payout_batch_id: 'BATCH_ENROLLED', batch_status: 'PENDING' } }));
    Date.now = () => fake2;
    try {
      const withdrawCode = mod.totpAt(setup.body.secret, Math.floor(fake2 / 30000));
      const r = await call('POST /api/fiat/withdraw/paypal', wd({ amount: 5, twoFactorCode: withdrawCode }));
      assert.equal(r.status, 202);
      assert.equal(r.body.transaction.externalId, 'BATCH_ENROLLED');
    } finally {
      Date.now = realNow;
      restore();
    }
  } finally {
    process.env.FIAT_TOTP_SECRET = savedEnvTotp;
    if (savedStorePath === undefined) delete process.env.FIAT_TOTP_STORE_PATH;
    else process.env.FIAT_TOTP_STORE_PATH = savedStorePath;
  }
});

test('encryption at rest: AES-256-GCM protects ledger, TOTP, and Plaid stores; detects tampering and migrates plaintext dirs', async () => {
  const cryptoMod = await import('./ledgerCrypto.ts');
  const savedEncKey = process.env.FIAT_LEDGER_ENCRYPTION_KEY;
  const encDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiat-enc-'));

  try {
    // 1. Seed a directory with plaintext stores (simulating pre-encryption Termux ./data folder)
    const ledgerFile = path.join(encDir, 'fiat-ledger.json');
    const totpFile = path.join(encDir, 'fiat-totp.json');
    const plaidFile = path.join(encDir, 'plaid-items.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ account: { availableBalance: 42.5 } }), { mode: 0o600 });
    fs.writeFileSync(totpFile, JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', enrolledAt: 1700000000000 }), { mode: 0o600 });
    fs.writeFileSync(plaidFile, JSON.stringify({ bank_1: { accessToken: 'access-sandbox-secret-999' } }), { mode: 0o600 });

    // Before key is set, inspection reports plaintext
    const before = cryptoMod.inspectDataDirectory(encDir);
    assert.deepEqual(before.map((x) => x.status), ['plaintext', 'plaintext', 'plaintext']);

    // Weak (<12 chars) encryption keys are rejected
    process.env.FIAT_LEDGER_ENCRYPTION_KEY = 'short';
    assert.throws(() => cryptoMod.encryptDataDirectoryAtRest(encDir), /at least 12 characters/);

    // 2. Configure a strong 256-bit hex key and migrate the entire directory at rest
    process.env.FIAT_LEDGER_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const migrated = cryptoMod.encryptDataDirectoryAtRest(encDir);
    assert.deepEqual(migrated.map((x) => x.action), ['migrated-to-encrypted', 'migrated-to-encrypted', 'migrated-to-encrypted']);

    // Confirm no plaintext secrets or balances remain on disk and POSIX permissions stay 0600
    for (const file of [ledgerFile, totpFile, plaidFile]) {
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(!raw.includes('42.5'), 'plaintext balance must not appear on disk');
      assert.ok(!raw.includes('JBSWY3DPEHPK3PXP'), 'plaintext TOTP secret must not appear on disk');
      assert.ok(!raw.includes('access-sandbox-secret-999'), 'plaintext Plaid token must not appear on disk');
      const env = JSON.parse(raw);
      assert.equal(env.alg, 'aes-256-gcm');
      assert.equal(env.kdf, 'scrypt');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }

    // Re-running verifies existing ciphertexts cleanly
    const reverified = cryptoMod.encryptDataDirectoryAtRest(encDir);
    assert.deepEqual(reverified.map((x) => x.action), ['verified-encrypted', 'verified-encrypted', 'verified-encrypted']);

    // Decrypted read succeeds with matching context and key
    const decLedger = cryptoMod.readStoreJson<{ account: { availableBalance: number } }>(ledgerFile, 'fiat-ledger');
    assert.equal(decLedger?.encrypted, true);
    assert.equal(decLedger?.data.account.availableBalance, 42.5);

    // 3. Wrong AAD/context fails authentication; tampered ciphertext fails authentication
    assert.throws(() => cryptoMod.readStoreJson(totpFile, 'fiat-ledger'), /context mismatch/);
    const tampered = JSON.parse(fs.readFileSync(plaidFile, 'utf8'));
    tampered.tag = Buffer.from(crypto.randomBytes(16)).toString('base64');
    fs.writeFileSync(plaidFile, JSON.stringify(tampered));
    assert.throws(() => cryptoMod.readStoreJson(plaidFile, 'plaid-items'), /incorrect FIAT_LEDGER_ENCRYPTION_KEY or tampered file/);

    // 4. Fail-closed: cannot decrypt or overwrite encrypted store when key is wrong or unset
    process.env.FIAT_LEDGER_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    assert.throws(() => cryptoMod.readStoreJson(ledgerFile, 'fiat-ledger'), /incorrect FIAT_LEDGER_ENCRYPTION_KEY or tampered file/);

    delete process.env.FIAT_LEDGER_ENCRYPTION_KEY;
    assert.throws(() => cryptoMod.readStoreJson(ledgerFile, 'fiat-ledger'), /FIAT_LEDGER_ENCRYPTION_KEY/);
    assert.throws(() => cryptoMod.writeStoreJson(ledgerFile, { account: { availableBalance: 0 } }, 'fiat-ledger'), /Refusing to overwrite encrypted/);

    // 5. Security audit & account report AES-256-GCM when key is active
    process.env.FIAT_LEDGER_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const acctRes = (await call('GET /api/fiat/account')).body;
    assert.equal(acctRes.account.vaultEncryption, 'AES_256_GCM');
    assert.equal(acctRes.security.vault, 'LEDGER_FILE_AES_256_GCM');
    assert.equal(acctRes.security.encryptionAtRest, true);

    const auditRes = (await call('GET /api/fiat/security/audit')).body.report;
    const encCheck = auditRes.verifiedChecks.find((c: any) => c.category === 'ENCRYPTION');
    assert.equal(encCheck.status, 'PASSED');
    assert.ok(auditRes.vaultEncryption.includes('AES-256-GCM'));

    // Live write persists encrypted ledger JSON
    const saveRes = await call('POST /api/fiat/security/update-bot-protection', { ipWhitelistEnabled: true });
    assert.equal(saveRes.status, 200);
    const liveRaw = JSON.parse(fs.readFileSync(process.env.FIAT_LEDGER_PATH!, 'utf8'));
    assert.equal(liveRaw.format, 'onset-encrypted-at-rest');
    assert.equal(liveRaw.alg, 'aes-256-gcm');
    assert.equal(fs.statSync(process.env.FIAT_LEDGER_PATH!).mode & 0o777, 0o600);
    await call('POST /api/fiat/security/update-bot-protection', { ipWhitelistEnabled: false });
  } finally {
    const livePath = process.env.FIAT_LEDGER_PATH!;
    if (savedEncKey === undefined && fs.existsSync(livePath)) {
      const dec = cryptoMod.readStoreJson(livePath, 'fiat-ledger');
      delete process.env.FIAT_LEDGER_ENCRYPTION_KEY;
      if (dec) fs.writeFileSync(livePath, JSON.stringify(dec.data, null, 2), { mode: 0o600 });
    } else if (savedEncKey === undefined) {
      delete process.env.FIAT_LEDGER_ENCRYPTION_KEY;
    } else {
      process.env.FIAT_LEDGER_ENCRYPTION_KEY = savedEncKey;
    }
    fs.rmSync(encDir, { recursive: true, force: true });
  }
});

test('check cashing (Increase Check 21): validates images/endorsement, holds pending until cleared, and handles returns cleanly', async () => {
  const savedKey = process.env.INCREASE_API_KEY;
  const savedAcct = process.env.INCREASE_ACCOUNT_ID;
  const savedEnv = process.env.INCREASE_ENV;

  process.env.INCREASE_API_KEY = 'sandbox_test_key_123';
  process.env.INCREASE_ACCOUNT_ID = 'account_test_123';
  process.env.INCREASE_ENV = 'sandbox';

  const fakeJpeg = `data:image/jpeg;base64,${Buffer.alloc(256, 0xaa).toString('base64')}`;
  let currentRemoteStatus: any = {
    id: 'check_deposit_test_1',
    status: 'pending',
    inbound_funds_hold: { status: 'held' },
  };
  let fileUploads = 0;
  let depositsCreated = 0;

  const restoreFetch = mockStripe((url, init) => {
    assert.ok(url.startsWith('https://sandbox.increase.com/'), `unexpected url ${url}`);
    if (url.endsWith('/files') && init.method === 'POST') {
      fileUploads++;
      return { status: 200, json: { id: `file_test_${fileUploads}` } };
    }
    if (url.endsWith('/check_deposits') && init.method === 'POST') {
      depositsCreated++;
      return { status: 201, json: currentRemoteStatus };
    }
    if (url.endsWith('/check_deposits/check_deposit_test_1') && init.method === 'GET') {
      return { status: 200, json: currentRemoteStatus };
    }
    throw new Error(`unexpected Increase request: ${init.method} ${url}`);
  });

  try {
    assert.equal((await call('GET /api/fiat/config')).body.rails.check, true);

    const beforeAcct = (await call('GET /api/fiat/account')).body.account;
    const startAvail = beforeAcct.availableBalance;
    const startPending = beforeAcct.pendingBalance;

    // 1. Validation refuses unendorsed checks and bad images before calling Increase
    const noEndorse = await call('POST /api/fiat/deposit/check', {
      amount: 250,
      checkNumber: '4001',
      payerName: 'Acme Payroll',
      endorsementConfirmed: false,
      frontImage: fakeJpeg,
      backImage: fakeJpeg,
    });
    assert.equal(noEndorse.status, 400);
    assert.equal(fileUploads, 0);

    const badImg = await call('POST /api/fiat/deposit/check', {
      amount: 250,
      checkNumber: '4001',
      payerName: 'Acme Payroll',
      endorsementConfirmed: true,
      frontImage: 'data:text/plain;base64,aGVsbG8=',
      backImage: fakeJpeg,
    });
    assert.equal(badImg.status, 400);
    assert.equal(fileUploads, 0);

    // 2. Live check submission uploads front + back images and places $250 in pendingBalance ONLY (not availableBalance)
    const idemp = 'check-idemp-unique-0001';
    const sub = await call('POST /api/fiat/deposit/check', {
      amount: 250,
      checkNumber: '4001',
      payerName: 'Acme Payroll',
      issuingBank: 'First Bank',
      endorsementConfirmed: true,
      destination: 'TREASURY_VAULT',
      frontImage: fakeJpeg,
      backImage: fakeJpeg,
      idempotencyKey: idemp,
    });
    assert.equal(sub.status, 202);
    assert.equal(fileUploads, 2);
    assert.equal(depositsCreated, 1);
    assert.equal(sub.body.check.status, 'PENDING_CLEARING');
    assert.equal(sub.body.account.availableBalance, startAvail);
    assert.equal(sub.body.account.pendingBalance, Math.round((startPending + 250) * 100) / 100);

    // Duplicate idempotencyKey never re-uploads or double-counts
    const dup = await call('POST /api/fiat/deposit/check', {
      amount: 250,
      checkNumber: '4001',
      payerName: 'Acme Payroll',
      endorsementConfirmed: true,
      destination: 'TREASURY_VAULT',
      frontImage: fakeJpeg,
      backImage: fakeJpeg,
      idempotencyKey: idemp,
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
    assert.equal(fileUploads, 2);
    assert.equal(depositsCreated, 1);

    // 3. While hold is active even with status 'submitted', funds remain pending
    currentRemoteStatus = { id: 'check_deposit_test_1', status: 'submitted', inbound_funds_hold: { status: 'held' } };
    const stillHeld = await call('POST /api/fiat/check-deposits/reconcile');
    assert.equal(stillHeld.body.account.availableBalance, startAvail);
    assert.equal(stillHeld.body.account.pendingBalance, Math.round((startPending + 250) * 100) / 100);

    // 4. Webhook triggers re-read from Increase after hold release -> credits availableBalance once
    currentRemoteStatus = { id: 'check_deposit_test_1', status: 'submitted', inbound_funds_hold: { status: 'released' } };
    const hook = await call('POST /api/fiat/increase/webhook', {
      associated_object_type: 'check_deposit',
      associated_object_id: 'check_deposit_test_1',
    });
    assert.equal(hook.status, 200);

    const afterClear = (await call('GET /api/fiat/account')).body.account;
    assert.equal(afterClear.availableBalance, Math.round((startAvail + 250) * 100) / 100);
    assert.equal(afterClear.pendingBalance, startPending);

    // Repeat reconcile never double-credits
    const repeatRec = await call('POST /api/fiat/check-deposits/reconcile');
    assert.equal(repeatRec.body.account.availableBalance, Math.round((startAvail + 250) * 100) / 100);

    // 5. Rejected check releases pending hold and credits nothing
    currentRemoteStatus = { id: 'check_deposit_test_2', status: 'rejected', deposit_rejection: { reason: 'unreadable_image' } };
    const rej = await call('POST /api/fiat/deposit/check', {
      amount: 75,
      checkNumber: '4002',
      payerName: 'Bob Co',
      endorsementConfirmed: true,
      destination: 'TREASURY_VAULT',
      frontImage: fakeJpeg,
      backImage: fakeJpeg,
      idempotencyKey: 'check-idemp-unique-0002',
    });
    assert.equal(rej.status, 402);
    assert.equal(rej.body.check.status, 'REJECTED');
    assert.equal(rej.body.account.pendingBalance, startPending);
    assert.equal(rej.body.account.availableBalance, Math.round((startAvail + 250) * 100) / 100);
  } finally {
    restoreFetch();
    if (savedKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = savedKey;
    if (savedAcct === undefined) delete process.env.INCREASE_ACCOUNT_ID;
    else process.env.INCREASE_ACCOUNT_ID = savedAcct;
    if (savedEnv === undefined) delete process.env.INCREASE_ENV;
    else process.env.INCREASE_ENV = savedEnv;
  }

  // Verify increase_sandbox_key_... routes to sandbox.increase.com even when INCREASE_ENV=production and sets envNotice
  const { increaseConfig } = await import('./increaseClient.ts');
  const prevKey = process.env.INCREASE_API_KEY;
  const prevAcct = process.env.INCREASE_ACCOUNT_ID;
  const prevEnv = process.env.INCREASE_ENV;
  try {
    process.env.INCREASE_API_KEY = 'increase_sandbox_key_test_abc';
    process.env.INCREASE_ACCOUNT_ID = 'Look2thesky88@gmail.com';
    process.env.INCREASE_ENV = 'production';
    const cfg = increaseConfig();
    assert.ok(cfg);
    assert.equal(cfg.env, 'sandbox');
    assert.equal(cfg.baseUrl, 'https://sandbox.increase.com');
    assert.ok(cfg.envNotice?.includes('sandbox.increase.com'));
  } finally {
    if (prevKey === undefined) delete process.env.INCREASE_API_KEY;
    else process.env.INCREASE_API_KEY = prevKey;
    if (prevAcct === undefined) delete process.env.INCREASE_ACCOUNT_ID;
    else process.env.INCREASE_ACCOUNT_ID = prevAcct;
    if (prevEnv === undefined) delete process.env.INCREASE_ENV;
    else process.env.INCREASE_ENV = prevEnv;
  }
});

test('crypto-to-cash: quotes live market price, enforces ENABLE_LIVE_TRADING & credentials, sells spot crypto, pays via PayPal idempotently, and preserves USD proceeds if PayPal refuses', async () => {
  const prevLive = process.env.ENABLE_LIVE_TRADING;
  const prevBinKey = process.env.BINANCE_API_KEY;
  const prevBinSec = process.env.BINANCE_API_SECRET;
  const prevLimit = process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD;

  process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD = '5000';
  let binanceSellCalls = 0;
  let paypalPayoutCalls = 0;
  let paypalShouldRefuse = false;

  const restoreFetch = mockStripe((url, init) => {
    // Public Binance/Kraken market price lookup used by quoteSpotSellUsd
    if (url.includes('api.binance.us/api/v3/ticker/24hr')) {
      return {
        status: 200,
        json: {
          symbol: 'BTCUSDT',
          lastPrice: '50000.00',
          priceChangePercent: '1.25',
          highPrice: '51000.00',
          lowPrice: '49000.00',
          quoteVolume: '1000000',
        },
      };
    }
    if (url.includes('api.kraken.com/0/public/Ticker')) {
      return {
        status: 200,
        json: {
          error: [],
          result: {
            XXBTZUSD: { c: ['50000.00', '1'], o: '49500.00', h: ['51000.00', '51000.00'], l: ['49000.00', '49000.00'], v: ['10', '100'] },
          },
        },
      };
    }
    // Authenticated Binance spot sell endpoint
    if (url.includes('https://api.binance.com/api/v3/order') && init?.method === 'POST') {
      binanceSellCalls++;
      return {
        status: 200,
        json: {
          orderId: 900100 + binanceSellCalls,
          cummulativeQuoteQty: '50.00',
        },
      };
    }
    // PayPal OAuth + Payouts
    if (url.endsWith('/v1/oauth2/token')) {
      return { status: 200, json: { access_token: 'tok_pp_ctc', expires_in: 3600 } };
    }
    if (url.endsWith('/v1/payments/payouts') && init?.method === 'POST') {
      paypalPayoutCalls++;
      if (paypalShouldRefuse) {
        return { status: 422, json: { name: 'INSUFFICIENT_FUNDS', message: 'Merchant PayPal balance insufficient.' } };
      }
      return {
        status: 201,
        json: { batch_header: { payout_batch_id: `BATCH_CTC_${paypalPayoutCalls}`, batch_status: 'PENDING' } },
      };
    }
    throw new Error(`unexpected fetch in crypto-to-cash test: ${init?.method || 'GET'} ${url}`);
  });

  try {
    // 1. Live quote returns authoritative market valuation without executing any trade
    delete process.env.ENABLE_LIVE_TRADING;
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_API_SECRET;

    const qRes = await call('POST /api/fiat/crypto-to-cash/quote', {
      exchange: 'BINANCE',
      symbol: 'BTC/USDT',
      quantity: 0.001,
    });
    assert.equal(qRes.status, 200);
    assert.equal(qRes.body.quote.unitPriceUsd, 50000);
    assert.equal(qRes.body.quote.grossUsd, 50);
    assert.equal(qRes.body.quote.estimatedFeeUsd, 0.05);
    assert.equal(qRes.body.quote.netUsd, 49.95);
    assert.equal(qRes.body.quote.liveTradingEnabled, false);
    assert.equal(qRes.body.quote.exchangeConfigured, false);
    assert.equal(binanceSellCalls, 0);

    // 2. Refuses execution when ENABLE_LIVE_TRADING is not '1'
    const disabledRes = await withTotp((c) =>
      call('POST /api/fiat/crypto-to-cash', {
        exchange: 'BINANCE',
        symbol: 'BTC/USDT',
        quantity: 0.001,
        recipientId: 0,
        twoFactorCode: c,
        idempotencyKey: 'ctc-test-disabled-0001',
      })
    );
    assert.equal(disabledRes.status, 403);
    assert.equal(binanceSellCalls, 0);

    // 3. Refuses execution cleanly when exchange credentials are missing
    process.env.ENABLE_LIVE_TRADING = '1';
    const noCredsRes = await withTotp((c) =>
      call('POST /api/fiat/crypto-to-cash', {
        exchange: 'BINANCE',
        symbol: 'BTC/USDT',
        quantity: 0.001,
        recipientId: 0,
        twoFactorCode: c,
        idempotencyKey: 'ctc-test-nocreds-0001',
      })
    );
    assert.equal(noCredsRes.status, 400);
    assert.equal(noCredsRes.body.requiresCredentials, true);
    assert.equal(binanceSellCalls, 0);

    // 4. End-to-end live spot sell -> USD ledger -> PayPal Payout, plus idempotency
    process.env.BINANCE_API_KEY = 'bin_key_test';
    process.env.BINANCE_API_SECRET = 'bin_secret_test';
    const availBefore = (await call('GET /api/fiat/account')).body.account.availableBalance;
    const idem1 = 'ctc-test-success-0001';

    const okRes = await withTotp((c) =>
      call('POST /api/fiat/crypto-to-cash', {
        exchange: 'BINANCE',
        symbol: 'BTC/USDT',
        quantity: 0.001,
        positionId: 'pos-btc-1',
        recipientId: 0,
        twoFactorCode: c,
        idempotencyKey: idem1,
      })
    );
    assert.equal(okRes.status, 202);
    assert.equal(okRes.body.sellCompleted, true);
    assert.equal(okRes.body.sellResult.exchangeOrderId, 'bin-900101');
    assert.equal(okRes.body.sellResult.netProceedsUsd, 49.95);
    assert.equal(okRes.body.payoutTransaction.status, 'PROCESSING');
    assert.equal(okRes.body.payoutTransaction.externalId, 'BATCH_CTC_1');
    assert.equal(okRes.body.payoutTransaction.cryptoLiquidation.positionId, 'pos-btc-1');
    assert.equal(okRes.body.account.availableBalance, availBefore); // liquidated USD exited straight to PayPal

    // Retrying same idempotencyKey returns cached outcome without double-selling or double-paying
    const dupRes = await call('POST /api/fiat/crypto-to-cash', {
      exchange: 'BINANCE',
      symbol: 'BTC/USDT',
      quantity: 0.001,
      recipientId: 0,
      idempotencyKey: idem1,
    });
    assert.equal(dupRes.status, 200);
    assert.equal(dupRes.body.duplicate, true);
    assert.equal(binanceSellCalls, 1);
    assert.equal(paypalPayoutCalls, 1);

    // 5. If spot sell succeeds and PayPal refuses payout, net USD proceeds remain safely credited to availableBalance
    paypalShouldRefuse = true;
    const failPayRes = await withTotp((c) =>
      call('POST /api/fiat/crypto-to-cash', {
        exchange: 'BINANCE',
        symbol: 'BTC/USDT',
        quantity: 0.001,
        recipientId: 0,
        twoFactorCode: c,
        idempotencyKey: 'ctc-test-paypal-refuse-0002',
      })
    );
    assert.equal(failPayRes.status, 400);
    assert.equal(failPayRes.body.sellCompleted, true);
    assert.equal(failPayRes.body.payoutTransaction.status, 'FAILED');
    assert.equal(
      failPayRes.body.account.availableBalance,
      Math.round((availBefore + 49.95) * 100) / 100
    );
  } finally {
    restoreFetch();
    if (prevLive === undefined) delete process.env.ENABLE_LIVE_TRADING;
    else process.env.ENABLE_LIVE_TRADING = prevLive;
    if (prevBinKey === undefined) delete process.env.BINANCE_API_KEY;
    else process.env.BINANCE_API_KEY = prevBinKey;
    if (prevBinSec === undefined) delete process.env.BINANCE_API_SECRET;
    else process.env.BINANCE_API_SECRET = prevBinSec;
    if (prevLimit === undefined) delete process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD;
    else process.env.FIAT_DAILY_WITHDRAWAL_LIMIT_USD = prevLimit;
  }
});


