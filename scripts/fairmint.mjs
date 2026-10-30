// Agent ID fair mint (token version). Pure pricing matches FairMintSale / FairMintFactory / SuanV2Router.
// Commands build a transaction for the local wallet (`baw contract-call`). They never sign and never send a key.

const BPS = 10_000n;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const WAD = 10n ** 18n;
const BOUNDS = {
  maxTiers: 20,
  minSharePrice: 1_000_000_000_000n,
  minShares: 1_000n,
  maxShares: 10_000_000n,
  minTargetBps: 2_000n,
  minDuration: 3_600n,
  maxDuration: 14n * 86_400n,
  maxPerWallet: 100n,
  maxInviteBonus: 5n,
  maxTotalInviteBonus: 20n,
  maxCreatorBnbBps: 1_500n,
  maxCreatorTokenBps: 500n,
  minVesting: 30n * 86_400n,
  maxVesting: 180n * 86_400n,
  maxMetaBytes: 128,
  maxNameBytes: 32,
  maxSymbolBytes: 12,
  maxTaxBps: 500n,
  minTaxDuration: 86_400n,
  maxTaxDuration: 365n * 86_400n,
  permanentTax: (1n << 32n) - 1n,
};

export const FM_SEL = {
  mint: '0x17deeba0',
  claim: '0x318d9e5d',
  refund: '0x590e1ae3',
  create: '0x0e2a82b0',
  buyTaxBps: '0xc473413a',
  sellTaxBps: '0xcffd129c',
  agentBuyTaxBps: '0xd01aa9a3',
  agentSellTaxBps: '0x8cf25af0',
  burnShareBps: '0x3de2271c',
  taxEndsAt: '0x71317f2f',
  buy: '0xb3ffb760',
  sell: '0x883c18b3',
  v2Buy: '0xb6f9de95',
  v2Sell: '0x791ac947',
  approve: '0x095ea7b3',
  sold: '0x02c7e7af',
  maxShares: '0xc65b61ca',
  targetShares: '0xe5864e8f',
  deadline: '0x29dcb0cf',
  state: '0xc19d93fb',
  costOf: '0x6f92f584',
  priceAt: '0x8e07ba2f',
  sharesOf: '0xf5eb42dc',
  paidOf: '0x76e67725',
  walletCap: '0x98983a2d',
  token: '0xfc0c546a',
  pair: '0xa8aa1b31',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  creationFee: '0xdce0b4e4',
  bond: '0x64c9ec6f',
  salesCount: '0x682789a8',
  sales: '0xb5f522f7',
  getReserves: '0x0902f1ac',
  token0: '0x0dfe1681',
  balanceOf: '0x70a08231',
  perWallet: '0xcd68bfb9',
  inviteBonus: '0x84c13d76',
  creatorBnbBps: '0x82144d8e',
  creatorTokenBps: '0x7acb22cc',
  vestingSeconds: '0xb1956af5',
  tokensPerShare: '0xd5092b56',
  feeOwed: '0x1098894b',
  raised: '0xf0ea4bfc',
};

const STATES = ['minting', 'live', 'failed'];
const ZERO = '0x0000000000000000000000000000000000000000';

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const encAddr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const words = (hex) => (String(hex).replace(/^0x/, '').match(/.{64}/g) ?? []).map((part) => BigInt('0x' + part));
const utf8Len = (value) => new TextEncoder().encode(value).length;

function asWei(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw Object.assign(new Error(`Not a positive amount: ${value}`), { code: 'INVALID_PARAM' });
  if (!text.includes('.')) return BigInt(text);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 18) throw Object.assign(new Error(`Too many decimals: ${value}`), { code: 'INVALID_PARAM' });
  return BigInt(whole) * WAD + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

function encString(value) {
  const bytes = new TextEncoder().encode(value);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const padded = Math.ceil(bytes.length / 32) * 32;
  return word(bytes.length) + hex.padEnd(padded * 2, '0');
}

export function zeroTax() {
  return { buyBps: 0n, sellBps: 0n, agentBuyBps: 0n, agentSellBps: 0n, burnShareBps: 0n, duration: 0n };
}

function taxOf(raw) {
  const tax = raw ?? {};
  return {
    buyBps: BigInt(tax.buyBps ?? 0),
    sellBps: BigInt(tax.sellBps ?? 0),
    agentBuyBps: BigInt(tax.agentBuyBps ?? 0),
    agentSellBps: BigInt(tax.agentSellBps ?? 0),
    burnShareBps: BigInt(tax.burnShareBps ?? 0),
    duration: BigInt(tax.duration ?? 0),
  };
}

/** `create((string,string,string,(uint64,uint128)[],uint64,...,uint32,(uint16,uint16,uint16,uint16,uint16,uint32)))`. */
export function encodeCreate(params) {
  const tax = taxOf(params.tax);
  const strings = [params.name, params.symbol, params.meta].map(encString);
  const tiers = word(params.tiers.length) + params.tiers.map((tier) => word(tier.upTo) + word(tier.price)).join('');
  const tails = [...strings, tiers];
  let cursor = 19 * 32;
  const offsets = tails.map((tail) => {
    const at = cursor;
    cursor += tail.length / 2;
    return at;
  });
  const head = [
    offsets[0], offsets[1], offsets[2], offsets[3],
    params.maxShares, params.targetShares, params.deadline, params.perWallet, params.inviteBonus, params.maxInviteBonus,
    params.creatorBnbBps, params.creatorTokenBps, params.vestingSeconds,
    tax.buyBps, tax.sellBps, tax.agentBuyBps, tax.agentSellBps, tax.burnShareBps, tax.duration,
  ];
  return FM_SEL.create + word(32) + head.map(word).join('') + tails.join('');
}

export function encodeMint(shares, referrer) {
  return FM_SEL.mint + word(shares) + encAddr(referrer || ZERO);
}

export function encodeClaim(users) {
  return FM_SEL.claim + word(32) + word(users.length) + users.map(encAddr).join('');
}

export function encodeRefund() {
  return FM_SEL.refund;
}

export function encodeRouterBuy(token, minOut, to, deadline) {
  return FM_SEL.buy + encAddr(token) + word(minOut) + encAddr(to) + word(deadline);
}

export function encodeRouterSell(token, amountIn, minBnb, to, deadline) {
  return FM_SEL.sell + encAddr(token) + word(amountIn) + word(minBnb) + encAddr(to) + word(deadline);
}

export function encodeApprove(spender, amount) {
  return FM_SEL.approve + encAddr(spender) + word(amount);
}

/** `swapExactETHForTokensSupportingFeeOnTransferTokens(minOut, path, to, deadline)`. */
export function encodeV2Buy(minOut, wbnb, token, to, deadline) {
  const path = word(2) + encAddr(wbnb) + encAddr(token);
  return FM_SEL.v2Buy + word(minOut) + word(128) + encAddr(to) + word(deadline) + path;
}

/** `swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, minOut, path, to, deadline)`. */
export function encodeV2Sell(amountIn, minOut, token, wbnb, to, deadline) {
  const path = word(2) + encAddr(token) + encAddr(wbnb);
  return FM_SEL.v2Sell + word(amountIn) + word(minOut) + word(160) + encAddr(to) + word(deadline) + path;
}

function decodeString(hex) {
  const parts = words(hex);
  if (parts.length < 2) return '';
  const start = Number(parts[0] / 32n);
  const len = Number(parts[start] ?? 0n);
  const packed = parts.slice(start + 1).map((part) => part.toString(16).padStart(64, '0')).join('').slice(0, len * 2);
  if (!packed) return '';
  return new TextDecoder().decode(Uint8Array.from(packed.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16)));
}

export function creatorTokenAmount(creatorTokenBps) {
  return (SUPPLY * BigInt(creatorTokenBps)) / BPS;
}

export function tokensPerShare(maxShares, creatorTokenBps) {
  const shares = BigInt(maxShares);
  if (shares <= 0n) return 0n;
  const distributable = SUPPLY - creatorTokenAmount(creatorTokenBps);
  if (distributable < 0n) return 0n;
  return distributable / (2n * shares);
}

export function costOf(tiers, start, shares) {
  let from = BigInt(start);
  const to = from + BigInt(shares);
  let cost = 0n;
  for (const tier of tiers) {
    if (from >= to) break;
    const upTo = BigInt(tier.upTo);
    if (upTo <= from) continue;
    const end = upTo < to ? upTo : to;
    cost += (end - from) * BigInt(tier.price);
    from = end;
  }
  return cost;
}

export function priceAt(tiers, n) {
  const share = BigInt(n);
  if (tiers.length === 0) return 0n;
  for (const tier of tiers) if (BigInt(tier.upTo) >= share) return BigInt(tier.price);
  return BigInt(tiers[tiers.length - 1].price);
}

export function walletCap(perWallet, inviteBonusOf, maxInviteBonus) {
  const bonus = BigInt(inviteBonusOf) < BigInt(maxInviteBonus) ? BigInt(inviteBonusOf) : BigInt(maxInviteBonus);
  return BigInt(perWallet) + bonus;
}

export function saleOutcome(sale, nowSec) {
  const state = typeof sale.state === 'number' ? STATES[sale.state] : sale.state;
  if (state !== 'minting') return { ready: false, success: false };
  if (BigInt(sale.sold) === BigInt(sale.maxShares)) return { ready: true, success: true };
  if (BigInt(nowSec) < BigInt(sale.deadline)) return { ready: false, success: false };
  return { ready: true, success: BigInt(sale.sold) >= BigInt(sale.targetShares) };
}

export function launchPreview(params, sold) {
  const shares = BigInt(sold);
  const raised = costOf(params.tiers, 0n, shares);
  const fee = (raised * 200n) / BPS;
  const creatorBnb = (raised * BigInt(params.creatorBnbBps)) / BPS;
  const lpBnb = raised - fee - creatorBnb;
  const perShare = tokensPerShare(params.maxShares, params.creatorTokenBps);
  const holdersTokens = shares * perShare;
  const last = shares === 0n ? 0n : priceAt(params.tiers, shares);
  const lpTokens = last === 0n ? 0n : (lpBnb * perShare) / last;
  const openPricePerToken = lpTokens === 0n ? 0n : (lpBnb * WAD) / lpTokens;
  return { raised, fee, creatorBnb, lpBnb, lpTokens, openPricePerToken, holdersTokens };
}

/** Null when the params match `FairMintFactory.validate`. Otherwise the `BadParams` reason. */
export function validateParams(params, nowSec) {
  const now = BigInt(nowSec);
  if (utf8Len(params.name) === 0 || utf8Len(params.name) > BOUNDS.maxNameBytes) return 'name';
  if (utf8Len(params.symbol) === 0 || utf8Len(params.symbol) > BOUNDS.maxSymbolBytes) return 'symbol';
  if (utf8Len(params.meta) > BOUNDS.maxMetaBytes) return 'meta';
  if (BigInt(params.maxShares) < BOUNDS.minShares || BigInt(params.maxShares) > BOUNDS.maxShares) return 'maxShares';
  if (BigInt(params.targetShares) > BigInt(params.maxShares) || BigInt(params.targetShares) * BPS < BigInt(params.maxShares) * BOUNDS.minTargetBps) {
    return 'targetShares';
  }
  if (BigInt(params.deadline) < now + BOUNDS.minDuration || BigInt(params.deadline) > now + BOUNDS.maxDuration) return 'deadline';
  if (BigInt(params.perWallet) === 0n || BigInt(params.perWallet) > BOUNDS.maxPerWallet) return 'perWallet';
  if (BigInt(params.inviteBonus) > BOUNDS.maxInviteBonus) return 'inviteBonus';
  if (BigInt(params.maxInviteBonus) > BOUNDS.maxTotalInviteBonus) return 'maxInviteBonus';
  if (BigInt(params.creatorBnbBps) > BOUNDS.maxCreatorBnbBps) return 'creatorBnbBps';
  if (BigInt(params.creatorTokenBps) > BOUNDS.maxCreatorTokenBps) return 'creatorTokenBps';
  const creatorShare = BigInt(params.creatorBnbBps) > 0n || BigInt(params.creatorTokenBps) > 0n;
  if (creatorShare && (BigInt(params.vestingSeconds) < BOUNDS.minVesting || BigInt(params.vestingSeconds) > BOUNDS.maxVesting)) return 'vestingSeconds';
  if (!creatorShare && BigInt(params.vestingSeconds) !== 0n) return 'vestingSeconds';
  const taxReason = validateTax(taxOf(params.tax));
  if (taxReason) return taxReason;
  if (!params.tiers?.length || params.tiers.length > BOUNDS.maxTiers) return 'tiers';
  let prevUpTo = 0n;
  let prevPrice = 0n;
  for (const tier of params.tiers) {
    if (BigInt(tier.upTo) <= prevUpTo) return 'tier upTo';
    if (BigInt(tier.price) < BOUNDS.minSharePrice || BigInt(tier.price) < prevPrice) return 'tier price';
    prevUpTo = BigInt(tier.upTo);
    prevPrice = BigInt(tier.price);
  }
  if (prevUpTo !== BigInt(params.maxShares)) return 'last tier';
  return null;
}

function validateTax(tax) {
  if (tax.buyBps > BOUNDS.maxTaxBps || tax.sellBps > BOUNDS.maxTaxBps) return 'tax';
  if (tax.agentBuyBps > tax.buyBps || tax.agentSellBps > tax.sellBps) return 'agent tax';
  if (tax.burnShareBps > BPS) return 'burnShareBps';
  const taxed = tax.buyBps > 0n || tax.sellBps > 0n;
  if (!taxed) {
    if (tax.duration !== 0n || tax.burnShareBps !== 0n) return 'taxDuration';
    return null;
  }
  if (tax.duration !== BOUNDS.permanentTax && (tax.duration < BOUNDS.minTaxDuration || tax.duration > BOUNDS.maxTaxDuration)) {
    return 'taxDuration';
  }
  return null;
}

function rateFor(tax, side, isAgent) {
  if (side === 'buy') return isAgent ? tax.agentBuyBps : tax.buyBps;
  return isAgent ? tax.agentSellBps : tax.sellBps;
}

function splitTax(amount, bps, burnShareBps) {
  if (amount <= 0n || bps <= 0n) return { tax: 0n, platform: 0n, burned: 0n, toCreator: 0n };
  const tax = (amount * bps) / BPS;
  const platform = (tax * 1_000n) / BPS;
  const burned = ((tax - platform) * burnShareBps) / BPS;
  const toCreator = tax - platform - burned;
  return { tax, platform, burned, toCreator };
}

function v2Out(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * 9975n;
  return (withFee * reserveOut) / (reserveIn * 10_000n + withFee);
}

const NO_SPLIT = { tax: 0n, platform: 0n, burned: 0n, toCreator: 0n, taxBps: 0n };

/**
 * Buy: optional 1% router fee, then the V2 swap, then the buyer's token tax (agent or normal).
 * `amountOut` is the tokens the buyer keeps. `routerFee: false` is a direct PancakeSwap buy.
 */
export function quoteBuy(reserves, bnbIn, tax = zeroTax(), isAgent = false, routerFee = true) {
  const input = BigInt(bnbIn);
  if (input <= 0n) return { fee: 0n, poolIn: 0n, grossOut: 0n, amountOut: 0n, ...NO_SPLIT };
  const rates = taxOf(tax);
  const fee = routerFee ? (input * 100n) / BPS : 0n;
  const poolIn = input - fee;
  const grossOut = v2Out(poolIn, BigInt(reserves.reserveBnb), BigInt(reserves.reserveToken));
  const taxBps = rateFor(rates, 'buy', isAgent);
  const split = splitTax(grossOut, taxBps, rates.burnShareBps);
  return { fee, poolIn, grossOut, amountOut: grossOut - split.tax, taxBps, ...split };
}

/**
 * Sell: the seller's token tax is taken before the swap, then the optional 1% router fee on the BNB.
 * `amountOut` is the BNB the seller receives. `routerFee: false` is a direct PancakeSwap sell.
 */
export function quoteSell(reserves, tokensIn, tax = zeroTax(), isAgent = false, routerFee = true) {
  const input = BigInt(tokensIn);
  if (input <= 0n) return { fee: 0n, gross: 0n, poolIn: 0n, amountOut: 0n, ...NO_SPLIT };
  const rates = taxOf(tax);
  const taxBps = rateFor(rates, 'sell', isAgent);
  const split = splitTax(input, taxBps, rates.burnShareBps);
  const poolIn = input - split.tax;
  const gross = v2Out(poolIn, BigInt(reserves.reserveToken), BigInt(reserves.reserveBnb));
  const fee = routerFee ? (gross * 100n) / BPS : 0n;
  return { fee, gross, poolIn, amountOut: gross - fee, taxBps, ...split };
}

export function normalizeCreateParams(raw) {
  return {
    name: String(raw.name ?? ''),
    symbol: String(raw.symbol ?? ''),
    meta: String(raw.meta ?? ''),
    tiers: (raw.tiers ?? []).map((tier) => ({ upTo: BigInt(tier.upTo), price: asWei(tier.price) })),
    maxShares: BigInt(raw.maxShares),
    targetShares: BigInt(raw.targetShares),
    deadline: BigInt(raw.deadline),
    perWallet: BigInt(raw.perWallet),
    inviteBonus: BigInt(raw.inviteBonus ?? 0),
    maxInviteBonus: BigInt(raw.maxInviteBonus ?? 0),
    creatorBnbBps: BigInt(raw.creatorBnbBps ?? 0),
    creatorTokenBps: BigInt(raw.creatorTokenBps ?? 0),
    vestingSeconds: BigInt(raw.vestingSeconds ?? 0),
    tax: taxOf(raw.tax),
  };
}

function uintOf(hex) {
  return words(hex)[0] ?? 0n;
}

function minOut(amount, slippageBps) {
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * Command handlers. `deps` is the launchpad CLI (rpc, tx builder). A missing factory address fails
 * before any key material is touched — these handlers never see a private key.
 */
/** BSC mainnet fair mint (verified on BscScan). Override with `factory` / `router` params or the env vars. */
export const MAINNET_FAIRMINT = {
  factory: '0xb9b7d9384F22512C7A5E657fF9FF804D89Cf3b64',
  router: '0x9FD3887A0e0910f905Ad6F2E637cB514d5f9Eb7f',
};

export function createFairmintCommands(deps) {
  const fail = deps.fail;
  const addr = (value, name) => {
    if (!deps.ADDR_RE.test(value ?? '')) throw fail('INVALID_PARAM', `\`${name}\` must be a 0x address`);
    return String(value).toLowerCase();
  };
  const factoryOf = (p) => {
    const value = p.factory ?? process.env.SUAN_FAIRMINT_FACTORY ?? MAINNET_FAIRMINT.factory;
    if (!deps.ADDR_RE.test(value ?? '')) throw fail('FAIRMINT_NOT_CONFIGURED', 'Pass `factory` or set SUAN_FAIRMINT_FACTORY');
    return value.toLowerCase();
  };
  const routerOf = (p) => {
    const value = p.router ?? process.env.SUAN_FAIRMINT_ROUTER ?? MAINNET_FAIRMINT.router;
    if (!deps.ADDR_RE.test(value ?? '')) throw fail('FAIRMINT_NOT_CONFIGURED', 'Pass `router` or set SUAN_FAIRMINT_ROUTER');
    return value.toLowerCase();
  };
  const rpcOf = (p) => deps.makeRpc(p.rpc ? [p.rpc] : process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : deps.defaultRpcs);
  const call = (rpc, to, data) => deps.call(rpc, to, data);
  const readUint = async (rpc, to, data) => uintOf(await call(rpc, to, data));

  async function agentBalance(rpc, wallet) {
    return readUint(rpc, deps.agentId, FM_SEL.balanceOf + encAddr(wallet));
  }

  async function cmdMintList(p) {
    const factory = factoryOf(p);
    const rpc = rpcOf(p);
    const count = await readUint(rpc, factory, FM_SEL.salesCount);
    const limit = Math.min(Math.max(Number(p.limit ?? 20), 1), 50);
    const items = [];
    for (let i = count; i > 0n && items.length < limit; i -= 1n) {
      const sale = '0x' + (await call(rpc, factory, FM_SEL.sales + word(i - 1n))).slice(-40);
      const [sold, maxShares, deadline, state] = await Promise.all([
        readUint(rpc, sale, FM_SEL.sold),
        readUint(rpc, sale, FM_SEL.maxShares),
        readUint(rpc, sale, FM_SEL.deadline),
        readUint(rpc, sale, FM_SEL.state),
      ]);
      items.push({ sale, sold: sold.toString(), maxShares: maxShares.toString(), deadline: deadline.toString(), status: STATES[Number(state)] ?? 'minting' });
    }
    return { count: count.toString(), items };
  }

  async function cmdMintInfo(p) {
    const sale = addr(p.sale, 'sale');
    const rpc = rpcOf(p);
    const [name, symbol, sold, maxShares, target, deadline, state, raised, perWallet, token, pair] = await Promise.all([
      call(rpc, sale, FM_SEL.name),
      call(rpc, sale, FM_SEL.symbol),
      readUint(rpc, sale, FM_SEL.sold),
      readUint(rpc, sale, FM_SEL.maxShares),
      readUint(rpc, sale, FM_SEL.targetShares),
      readUint(rpc, sale, FM_SEL.deadline),
      readUint(rpc, sale, FM_SEL.state),
      readUint(rpc, sale, FM_SEL.raised),
      readUint(rpc, sale, FM_SEL.perWallet),
      call(rpc, sale, FM_SEL.token),
      call(rpc, sale, FM_SEL.pair),
    ]);
    const wallet = p.wallet ? addr(p.wallet, 'wallet') : null;
    const hasAgentId = wallet ? (await agentBalance(rpc, wallet)) > 0n : null;
    const share = sold < maxShares ? sold + 1n : sold === 0n ? 1n : sold;
    return {
      sale,
      status: STATES[Number(state)] ?? 'minting',
      sold: sold.toString(),
      maxShares: maxShares.toString(),
      targetShares: target.toString(),
      deadline: deadline.toString(),
      raisedWei: raised.toString(),
      sharePriceWei: (await readUint(rpc, sale, FM_SEL.priceAt + word(share))).toString(),
      perWallet: perWallet.toString(),
      token: '0x' + token.slice(-40),
      pair: '0x' + pair.slice(-40),
      wallet: wallet ? { address: wallet, hasAgentId, canMint: hasAgentId === true && Number(state) === 0 } : null,
      name: decodeString(name),
      symbol: decodeString(symbol),
    };
  }

  async function cmdMintQuote(p) {
    const sale = addr(p.sale, 'sale');
    const shares = BigInt(p.shares);
    if (shares <= 0n) throw fail('INVALID_PARAM', '`shares` must be at least 1');
    const rpc = rpcOf(p);
    const sold = await readUint(rpc, sale, FM_SEL.sold);
    const cost = await readUint(rpc, sale, FM_SEL.costOf + word(sold) + word(shares));
    const wallet = p.wallet ? addr(p.wallet, 'wallet') : null;
    const hasAgentId = wallet ? (await agentBalance(rpc, wallet)) > 0n : null;
    return {
      sale,
      shares: shares.toString(),
      costWei: cost.toString(),
      hasAgentId,
      transaction: wallet ? deps.txEntry('mint', wallet, { to: sale, value: cost.toString(), inputData: encodeMint(shares, p.ref) }) : null,
    };
  }

  async function cmdMint(p) {
    const sale = addr(p.sale, 'sale');
    const wallet = addr(p.wallet, 'wallet');
    const shares = BigInt(p.shares);
    const rpc = rpcOf(p);
    if ((await agentBalance(rpc, wallet)) === 0n) throw fail('NO_AGENT_ID', 'This wallet has no .ai Agent ID, so the sale will reject the mint');
    const sold = await readUint(rpc, sale, FM_SEL.sold);
    const cost = p.value ? asWei(p.value) : await readUint(rpc, sale, FM_SEL.costOf + word(sold) + word(shares));
    return { sale, shares: shares.toString(), costWei: cost.toString(), transactions: [deps.txEntry('mint', wallet, { to: sale, value: cost.toString(), inputData: encodeMint(shares, p.ref) })] };
  }

  async function cmdMintClaim(p) {
    const sale = addr(p.sale, 'sale');
    const wallet = addr(p.wallet, 'wallet');
    return { transactions: [deps.txEntry('mint-claim', wallet, { to: sale, value: '0', inputData: encodeClaim([wallet]) })] };
  }

  async function cmdMintRefund(p) {
    const sale = addr(p.sale, 'sale');
    const wallet = addr(p.wallet, 'wallet');
    return { transactions: [deps.txEntry('mint-refund', wallet, { to: sale, value: '0', inputData: encodeRefund() })] };
  }

  async function cmdMintCreate(p) {
    if (!p.paramsFile && !p.params) throw fail('INVALID_PARAM', 'Pass `paramsFile` or `params`');
    const raw = p.params ?? JSON.parse(deps.readFile(p.paramsFile));
    const nowSec = BigInt(p.nowSec ?? Math.floor(Date.now() / 1000));
    let params;
    try {
      params = normalizeCreateParams(raw);
    } catch (error) {
      throw fail(error.code ?? 'INVALID_PARAM', error.message);
    }
    const reason = validateParams(params, nowSec);
    if (reason) throw fail('BAD_PARAMS', reason);
    const factory = factoryOf(p);
    const wallet = addr(p.wallet, 'wallet');
    const rpc = rpcOf(p);
    const [fee, bond] = await Promise.all([readUint(rpc, factory, FM_SEL.creationFee), readUint(rpc, factory, FM_SEL.bond)]);
    const value = fee + bond;
    return {
      reason: null,
      valueWei: value.toString(),
      creationFeeWei: fee.toString(),
      bondWei: bond.toString(),
      transactions: [deps.txEntry('mint-create', wallet, { to: factory, value: value.toString(), inputData: encodeCreate(params) })],
    };
  }

  async function reservesOf(rpc, token) {
    const pairData = await call(rpc, deps.v2Factory, '0xe6a43905' + encAddr(token) + encAddr(deps.wbnb));
    const pair = '0x' + pairData.slice(-40);
    if (pair === ZERO) throw fail('NO_PAIR', 'This token has no PancakeSwap V2 pair yet');
    const packed = words(await call(rpc, pair, FM_SEL.getReserves));
    const token0 = '0x' + (await call(rpc, pair, FM_SEL.token0)).slice(-40);
    const wbnbIs0 = token0 === deps.wbnb;
    return { pair, reserveBnb: wbnbIs0 ? packed[0] : packed[1], reserveToken: wbnbIs0 ? packed[1] : packed[0] };
  }

  async function callerTax(rpc, token, wallet) {
    const [buy, sell, agentBuy, agentSell, burn, ends, agents, block] = await Promise.all([
      readUint(rpc, token, FM_SEL.buyTaxBps),
      readUint(rpc, token, FM_SEL.sellTaxBps),
      readUint(rpc, token, FM_SEL.agentBuyTaxBps),
      readUint(rpc, token, FM_SEL.agentSellTaxBps),
      readUint(rpc, token, FM_SEL.burnShareBps),
      readUint(rpc, token, FM_SEL.taxEndsAt),
      readUint(rpc, deps.agentId, FM_SEL.balanceOf + encAddr(wallet)),
      rpc('eth_getBlockByNumber', ['latest', false]),
    ]);
    const now = BigInt(block.timestamp);
    const active = now < ends;
    const tax = active
      ? { buyBps: buy, sellBps: sell, agentBuyBps: agentBuy, agentSellBps: agentSell, burnShareBps: burn, duration: 0n }
      : zeroTax();
    return { tax, isAgent: agents > 0n, block };
  }

  function taxFields(quoted, isAgent) {
    return {
      isAgent,
      taxBps: quoted.taxBps.toString(),
      taxWei: quoted.tax.toString(),
      platformWei: quoted.platform.toString(),
      burnedWei: quoted.burned.toString(),
      creatorWei: quoted.toCreator.toString(),
    };
  }

  async function cmdFmBuy(p) {
    const token = addr(p.token, 'token');
    const wallet = addr(p.wallet, 'wallet');
    const bnbIn = asWei(p.bnb ?? p.amount);
    const rpc = rpcOf(p);
    const [reserves, caller] = await Promise.all([reservesOf(rpc, token), callerTax(rpc, token, wallet)]);
    const direct = p.direct === true;
    const quoted = quoteBuy(reserves, bnbIn, caller.tax, caller.isAgent, !direct);
    const slip = BigInt(p.slippageBps ?? deps.defaultSlippageBps);
    const min = minOut(quoted.amountOut, slip);
    const until = BigInt(caller.block.timestamp) + 1_200n;
    const to = direct ? deps.v2Router : routerOf(p);
    const inputData = direct ? encodeV2Buy(min, deps.wbnb, token, wallet, until) : encodeRouterBuy(token, min, wallet, until);
    return {
      direct,
      ...taxFields(quoted, caller.isAgent),
      feeWei: direct ? '0' : quoted.fee.toString(),
      tokensOutWei: quoted.amountOut.toString(),
      minOutWei: min.toString(),
      transactions: [deps.txEntry('fm-buy', wallet, { to, value: bnbIn.toString(), inputData })],
    };
  }

  async function cmdFmSell(p) {
    const token = addr(p.token, 'token');
    const wallet = addr(p.wallet, 'wallet');
    const amount = asWei(p.amount);
    const rpc = rpcOf(p);
    const [reserves, caller] = await Promise.all([reservesOf(rpc, token), callerTax(rpc, token, wallet)]);
    const direct = p.direct === true;
    const spender = direct ? deps.v2Router : routerOf(p);
    const quoted = quoteSell(reserves, amount, caller.tax, caller.isAgent, !direct);
    const slip = BigInt(p.slippageBps ?? deps.defaultSlippageBps);
    const min = minOut(quoted.amountOut, slip);
    const until = BigInt(caller.block.timestamp) + 1_200n;
    const inputData = direct ? encodeV2Sell(amount, min, token, deps.wbnb, wallet, until) : encodeRouterSell(token, amount, min, wallet, until);
    return {
      direct,
      ...taxFields(quoted, caller.isAgent),
      feeWei: quoted.fee.toString(),
      bnbOutWei: quoted.amountOut.toString(),
      minOutWei: min.toString(),
      transactions: [
        deps.txEntry('approve', wallet, { to: token, value: '0', inputData: encodeApprove(spender, amount) }),
        deps.txEntry('fm-sell', wallet, { to: spender, value: '0', inputData }),
      ],
    };
  }

  return {
    'mint-list': cmdMintList,
    'mint-info': cmdMintInfo,
    'mint-quote': cmdMintQuote,
    mint: cmdMint,
    'mint-claim': cmdMintClaim,
    'mint-refund': cmdMintRefund,
    'mint-create': cmdMintCreate,
    'fm-buy': cmdFmBuy,
    'fm-sell': cmdFmSell,
  };
}
