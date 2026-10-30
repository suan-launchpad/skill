---
name: suan-launchpad
description: Trade tokens launched on SUAN Agent Launchpad, the .ai Agent ID launch protocol on BNB Chain (PancakeSwap Infinity hook pool), including stock memes paired with a bStock (tokenized share such as NVDAB). Use when the user wants to check, quote, buy or sell a SUAN Agent Launchpad token, see its stage (.ai window, hold-cap window, tax period), time windows or fees, check a SUAN Agent Launchpad trade, claim holder rewards, launch a stock meme, quote, bet, or claim on a SUAN prediction market, or mint, claim, refund, or trade an Agent ID fair-mint token. Builds the transaction and executes it with the Binance Agentic Wallet (`baw contract-call`, Developer Mode).
---

# SUAN Agent Launchpad

Each SUAN Agent Launchpad token trades in one locked PancakeSwap Infinity hooked pool from its first block: the whole 1B
supply sits in a single position from the launch price (market cap 4.2 BNB) upward. During the first minutes only
wallets holding a **.ai Agent ID** can buy, and .ai wallets pay a lower tax than everyone else.

**Stock memes** are a second kind of launch: the token is paired with an allowlisted **bStock** (a tokenized US share
on BSC, e.g. NVDAB, TSLAB) instead of BNB. Same rules and time windows; the differences are the pool's base asset, a
start price of about the same USD market cap, and that every fee and holder reward is paid **in that bStock**. Users can
still pay and receive BNB: the stock router swaps BNB ⇄ bStock on PancakeSwap V3 in the same transaction. Every command
detects the kind itself (`kind: "bnb" | "stock"` in the output).

`scripts/suan-launchpad.mjs` is a self-contained, read-only CLI (Node ≥ 22, no dependencies). It reads the chain,
simulates the exact trade, and prints the transaction. It never signs or sends anything: the wallet does that with
`baw contract-call preview` → `baw contract-call execute`.

```bash
node scripts/suan-launchpad.mjs <command> '<json_params>'
```

Every command prints `{"success": true, "data": …}` or `{"success": false, "error": {"code", "message", …}}`.

## Configuration

| Setting | Param | Env var | Default |
|---|---|---|---|
| Hook (launch registry and pool hook) | `hook` | `SUAN_LAUNCHPAD_HOOK` | mainnet `0xa8E32E5Bc1d3Ce8aFe6bf3ef2069F1Fc7171c061` |
| Router (buy / sell entry point) | `router` | `SUAN_LAUNCHPAD_ROUTER` | mainnet `0x119dCa55DCbB37998E9bA0845196acc0FFf2FAc2` |
| Stock-meme hook | `stockHook` | `SUAN_STOCK_HOOK` | mainnet `0x6ddE8C213f0fA67cDB9546bB0de5ef595185c196` |
| Stock-meme router | `stockRouter` | `SUAN_STOCK_ROUTER` | mainnet `0xCFA7D82BfB4Ed21aDaCFC36287b7031264ec9314` |
| Stock-meme factory | `stockFactory` | `SUAN_STOCK_FACTORY` | mainnet `0x55e1c1914D5e11a37Cd10deDF327E56F04ba979C` |
| BSC RPC | `rpc` | `BSC_RPC_URL` | public `bsc-dataseed` endpoints |

The defaults are the SUAN Agent Launchpad on BSC mainnet, as published on https://launch.suan.bid. Only override
them when the user explicitly gives other addresses; never guess them. A token that does not answer through the hook fails with `UNKNOWN_LAUNCH`.

The stock-meme defaults are the mainnet stock contracts above (also published on https://launch.suan.bid). A token
is a stock meme when the stock hook knows it (`baseOf`); otherwise it is a BNB launch.

## Time windows

Everything that changes is measured from the launch time, in chain time (the latest block's timestamp). `info` shows
the current `stage` and the end of each window under `windows`:

| Stage | Until | Who can buy | Who can sell | Rules |
|---|---|---|---|---|
| `ai-only` | `aiOnlyUntil` (2 min default, 2–30 min) | .ai Agent ID wallets | .ai wallets and the creator | Tokens only move between the pool and .ai wallets; 1% cap |
| `hold-cap` | `holdCapUntil` (1 h default, at most 24 h) | anyone | anyone | No address may hold more than **1% of the supply** (10,000,000 tokens) |
| `taxed` | `taxPeriodEndsAt` (15 days default, 15–365 days, or `"permanent"`) | anyone | anyone | The token refuses other pools |
| `open` | — | anyone | anyone | Everyone pays the .ai rate; other pools are allowed |

- The 1% cap applies during the .ai window too. At the launch price 1% is only about 0.04 BNB of buying; selling frees
  room again. `holdRoom` in `info` shows what this wallet can still take.
- During the tax period the token refuses PancakeSwap and Uniswap V2/V3 pools, Uniswap v4, LikwidVault and any other
  Infinity pool, so trading stays in the hooked pool. A launch can make the tax period permanent (`"permanent"`); the
  token then only ever trades in its own pool. Aggregators and the PancakeSwap Universal Router work once the hold-cap
  window is over, as long as the route goes through the hooked pool.
- The anti-sniper surcharge applies in the first 5 blocks after creation (`antiSniperNow`). Buys in the creation block
  itself are blocked.

## Fees

All fees are taken in the launch's base: BNB for BNB launches, the paired bStock for stock memes (`feeCurrency` in
`info`). The rates are the same.

| Fee | Rate | Goes to |
|---|---|---|
| Trading fee (`baseFee`) | 1% on every trade | 0.5% buys back and burns $SUAN (the platform's share, from the first trade) + 0.5% creator, or holders once the creator switched its share to holders (`creatorShareToHolders: true`, one-way) |
| Tax | Everyone: the .ai rate (0–7%, default 0) | Split by the launch weights: founder, holder rewards, buyback-and-burn of the token, platform treasury |
| Surcharge | Wallets without .ai, during the tax period only: +3 points (`taxes.buyNow` / `taxes.sellNow` include it) | All to buyback-and-burn; no one receives it |
| Anti-sniper | four.meme's ladder in the first 5 blocks, buys only | Buyback-and-burn |

Platform fees: 100% buy back and burn $SUAN. That is the 0.5% platform share of every trade plus the one-time 0.005 BNB
launch fee. For stock memes the platform share is collected in the bStock and converted to BNB before the $SUAN buyback;
the launch fee is still 0.005 BNB. Creator fees, holder rewards and the token's own buyback use the bStock.
PancakeSwap's own protocol fee (`pancakeProtocolFee`) is on top and is already included in the quote.

## Commands

| Command | Params | What it does |
|---|---|---|
| `info` | `token`, `wallet?` | Stage, time windows, fees, creator-share switch, hold-cap room, pending holder rewards, and whether this wallet can buy / sell. Stock memes: `base` (symbol, name, USD per share, meme price in the bStock, in shares and in USD, market cap) |
| `quote-buy` | `token`, `wallet`, `amount`, `pay?`, `slippageBps?` | Simulates the buy and builds the router call. `amount` is BNB; for stock memes `pay: "base"` pays `amount` of the bStock instead (plus an `approve` first if needed) |
| `quote-sell` | `token`, `wallet`, `tokenAmount`, `receive?`, `slippageBps?` | Simulates the sell and builds the router call, plus an `approve` first when the router's allowance is too low. Stock memes receive BNB by default, or the bStock with `receive: "base"` |
| `receipt` | `txHash`, `token?` | Status, trades (`Swapped`: amount paid or received, tokens), fees taken (`FeeTaken`), token transfers and `CreatorShareToHolders` events of a submitted transaction. Stock-meme amounts carry `currency` (the bStock) |
| `claim-rewards` | `token`, `wallet` | Pending holder rewards (BNB, or the bStock for stock memes) and the `claim` call when there is something to claim |
| `bases` | — | Stock memes: the bStocks new launches can pair with, their start market cap, the launch fee and whether creation is open |
| `quote-bnb-to-base` | `base` (symbol or address), `wallet`, `amount` (BNB), `slippageBps?` | Stock memes: swap BNB to a bStock through the stock router, e.g. to fund a creator presale |
| `build-create` | `base`, `wallet`, `name`, `symbol`, `meta?`, `presaleAmount?` (bStock), `aiBuyTaxBps?`, `aiSellTaxBps?`, `weights?` ([founder, holder, burn, liquidity], default [40,30,20,10]), `taxDays?` (15–365 or `"permanent"`), `aiOnlyMinutes?` (2), `holdCapMinutes?` (60), `antiSniper?` (true), `minShare?`, `agentOnlyRewards?`, `founder?` | Stock memes: simulates the launch and builds `approve` (presale) + `create` (value = the BNB launch fee) |

Amounts are decimal strings (`"0.05"`), not wei. `slippageBps` defaults to 1000 (10%) and sets `minReceive`.

Stock-meme quotes with BNB pick the better PancakeSwap V3 route between BNB and the bStock (the direct WBNB pool or via
USDT), shown under `estimate.baseLeg`; the same slippage sets the least bStock out of that leg.

Quotes are not estimates from a formula: the CLI runs the real router call with `eth_call` from the user's wallet, so
the hook and token apply the same .ai check, hold cap and fees as the real trade. Buys pass no price limit. For sells it adds a
temporary allowance in the simulation only, so a quote works before the approval exists.

## Workflow

### Prerequisites

1. The user has a Binance Agentic Wallet with **Developer Mode** on, since `contract-call` needs it. Developer Mode has
   its own daily limit and balance cap, which the user sets in the Binance App.
2. To buy during the .ai window, and for the lower .ai tax at any time, the wallet holds a .ai Agent ID. Check
   `data.wallet.hasAgentId` from `info`. If it is `false`, the user claims one through the Binance Agentic Wallet
   skill's Agent ID flow first. It is free, one per user, and non-transferable.

### Buy

1. `info {token, wallet}`. Show the stage and when it ends, the fees this wallet pays (`data.wallet.fees`) and,
   during the .ai and hold-cap windows, `holdRoom`. Stop if `canBuy` is `false` and explain why (no .ai Agent ID
   during the .ai window: claim one, or wait until `windows.aiOnlyUntil`).
2. `quote-buy {token, wallet, amount}`. Show `estimate.receive`, `estimate.minReceive` and `estimate.fees`.
3. Run `transactions[0].baw` (that is, `baw contract-call preview --binanceChainId 56 --from <wallet> --to <router>
   --value <wei> --inputData <hex> --json`). Show the user the preview's balance changes and any `risks`.
4. Only after the user confirms, run `baw contract-call execute --requestId <requestId> --json`. If the preview has
   `requireConfirmation: true`, tell the user to approve the order in the Binance App.
5. `receipt {txHash, token}` to report the fees paid and tokens received.

### Sell

1. `quote-sell {token, wallet, tokenAmount}`. If `transactions` starts with `approve`, preview and execute it first,
   then run `quote-sell` again so the sell is built from fresh state.
2. Preview and execute the `sell` transaction as in the buy flow.

### Stock memes

- Trading works as above; `info` tells you the kind and the bStock. Show prices and fees in that bStock (and its USD
  value from `base.price.usd`). Default to paying and receiving BNB; use `pay` / `receive: "base"` only when the user
  holds or wants the bStock itself.
- Per-share figures use the bStock's `uiMultiplier` (`base.uiMultiplier`): raw balances never change, corporate actions
  only change the multiplier.

### Launch a stock meme

1. `bases` to show what can be paired and the launch fee. Ask for name, symbol and the base.
2. For a presale, the creator needs the bStock: `quote-bnb-to-base {base, wallet, amount}`, preview, execute. The
   presale buys at most 3% of the supply.
3. `build-create {base, wallet, name, symbol, presaleAmount?, …}`. Preview and execute `approve` (if present), then
   `create`. Read the token address from the receipt (`predictedToken` is only a simulation).

### Holder rewards

`claim-rewards {token, wallet}` shows what is pending; preview and execute the `claim` transaction to receive it.

## Prediction markets

Pari-mutuel markets on `SuanPredict`, staked in BNB. Winners split the losing pools after a 3% fee on those losing pools only. The fee goes to `SuanBuyBurn`. These commands only read the chain and build calldata. They never sign or send.

Set `predict` (or `SUAN_PREDICT`) to the deployed contract. There is no default address.

| Command | Params | What it does |
|---|---|---|
| `predict-markets` | `predict`, `limit?` (default 20, max 50) | The newest markets: status, pools, and odds in basis points (each pool's share of the total) |
| `predict-quote` | `predict`, `id`, `outcome`, `amount` (BNB), `wallet?` | Current odds, the multiplier after the 3% losing-pool fee, and the payout if this bet wins. With `wallet`, also the `bet` transaction |
| `predict-bet` | `predict`, `wallet`, `id`, `outcome`, `amount` (BNB) | Builds `bet(id, outcome)` with `value` set to the stake. Does not simulate a fill |
| `predict-claim` | `predict`, `wallet`, `id` or `ids` | Builds `claim` or `claimMany`. A single id also reads `claimable` |

`outcome` is `0` for Yes / Up / "CZ more", `1` for No / Down / "He Yi more", and `2` for a tie on the CZ / He Yi duel. Preview with `transactions[0].baw`, show the user the preview, and execute only after they confirm.

### Tweet counting

Only CZ (@cz_binance, id `902926941413453824`) and He Yi (@heyibinance, id `1003840309166366721`). The window is 00:00:00–23:59:59 Beijing time of the post's X `created_at`, to the second.

Counted: original posts (including media and polls), quote posts, and a self-thread (a reply whose `in_reply_to_user_id` is the author). Not counted: replies to other people, pure reposts, and undone reposts.

Deleted posts do not count. Before a result is proposed, every stored post that day is re-checked with `GET /2/tweets?ids=` (at most 100 ids a request). A missing post is excluded with reason `deleted`, and `deletedAt` is stored. An edited post counts once. A keyword hits if any captured version contains it. Edit history comes from the stream's edit fields and `edit_history_tweet_ids`.

Keywords are case-insensitive whole tokens. `BNB` matches `BNB`, `$BNB`, and `#BNB`, and does not match `BNBChain`. Emoji and Chinese keywords match literally. A Chinese post contains at least one CJK Unified Ideograph.

If an account is locked, suspended, or renamed so the day cannot be counted, the market is cancelled and stakes are refunded. The fee is 3% of the losing pools only, and it buys back and burns $SUAN. A tie on "will replies outnumber posts" resolves No.

| Code | Meaning |
|---|---|
| `PREDICT_NOT_CONFIGURED` | No `predict` address |
| `INVALID_OUTCOME` | `outcome` is not 0–7, or the quote names an outcome the market does not have |

## Agent ID 公平 Mint（代币版）

`.ai` Agent ID 持有者按创建时写死的分档价格购买份数。达标后任何人可以 `finalize`：2% 进 SuanBuyBurn，项目方份额线性解锁，其余 BNB 与对应代币在 PancakeSwap V2 建池，LP 转到黑洞。未达标则每人 `refund` 拿回全部付款，项目方保证金没收。开池后的币没有黑名单。创建时可以选一个交易税：只对这个币自己的 V2 交易对收税，买和卖各不超过 5%（500 bps），`.ai` 持有者付更低的代理税率。每笔税的 10% 进平台税池（再换成 BNB 买回 $SUAN），其余按 `burnShareBps` 销毁，剩下的给创建者。钱包之间转账不收税。税可以在 1 天到 365 天之后结束，也可以永久。全 0 表示没有税。

这些命令只读链、在本地拼交易，交给用户钱包签名。它们不接收、不保存、不发送私钥。

默认使用 BSC 主网合约：工厂 `0xb9b7d9384F22512C7A5E657fF9FF804D89Cf3b64`，路由 `0x9FD3887A0e0910f905Ad6F2E637cB514d5f9Eb7f`（均已在 BscScan 开源验证）。需要时可传入 `factory` / `router`，或设置 `SUAN_FAIRMINT_FACTORY` / `SUAN_FAIRMINT_ROUTER` 覆盖。

| 命令 | 参数 | 作用 |
|---|---|---|
| `mint-list` | `limit?`, `factory?` | 最近的销售：状态、已售、上限、截止时间 |
| `mint-info` | `sale`, `wallet?` | 进度、下一份价格、池子地址；有钱包时说明是否持有 `.ai` |
| `mint-quote` | `sale`, `shares`, `wallet?`, `ref?` | `costOf` 报价。有钱包时附上 `mint` 交易 |
| `mint` | `sale`, `wallet`, `shares`, `ref?` | 构建 `mint(shares, referrer)`。没有 `.ai` 时返回 `NO_AGENT_ID`，不发交易 |
| `mint-claim` | `sale`, `wallet` | 开池后领取该钱包的代币 |
| `mint-refund` | `sale`, `wallet` | 失败后退回该钱包付过的 BNB |
| `mint-create` | `wallet`, `paramsFile` 或 `params`, `factory?` | 先按工厂规则 `validate`，不通过则 `BAD_PARAMS` 且不访问 RPC；通过后构建 `create`，`value` 为创建费加保证金 |
| `fm-buy` | `token`, `wallet`, `bnb`, `router?`, `slippageBps?`, `direct?` | 默认走 SuanV2Router（买入的 BNB 扣 1%）。`direct: true` 直接走 PancakeSwap V2，不扣这 1%。报价和滑点都扣掉这个钱包的买入税（`.ai` 用代理税率） |
| `fm-sell` | `token`, `wallet`, `amount`, `router?`, `slippageBps?`, `direct?` | 同上，按卖出税。交易列表先 `approve` 再卖出 |

`mint-create` 的 JSON：`name`, `symbol`, `meta`, `tiers`（`upTo` 为累计份数，`price` 为每份 BNB，可写 wei 或 `"0.001"`）, `maxShares`, `targetShares`, `deadline`（unix 秒）, `perWallet`, `inviteBonus`, `maxInviteBonus`, `creatorBnbBps`, `creatorTokenBps`, `vestingSeconds`, `tax`。`tax` 可省略，省略等于全 0。字段：`buyBps`, `sellBps`, `agentBuyBps`, `agentSellBps`, `burnShareBps`, `duration`（秒；有税时为 1 天到 365 天，或 `4294967295` 表示永久）。`fm-buy` / `fm-sell` 的结果里有 `isAgent`, `taxBps`, `taxWei`, `platformWei`, `burnedWei`, `creatorWei`。`minOutWei` 是扣税之后再扣滑点。

先 `mint-info`。没有 `.ai` 就说明原因并停。用户确认预览之后才 `baw contract-call execute`。

| 代码 | 含义 |
|---|---|
| `FAIRMINT_NOT_CONFIGURED` | 没有工厂或路由地址 |
| `BAD_PARAMS` | 参数不符合工厂规则，`message` 是合约的 `BadParams` 原因 |
| `NO_AGENT_ID` | 钱包没有 `.ai` Agent ID |
| `NO_PAIR` | 代币还没有 V2 交易对 |

## Agent ID fair mint (token)

Holders of a `.ai` Agent ID buy shares at the tier prices fixed at creation. Anyone may `finalize` once the sale is ready: 2% goes to SuanBuyBurn, the creator's share vests linearly, and the rest of the BNB is paired with tokens in a PancakeSwap V2 pool whose LP is sent to the dead address. If the sale misses its target, each minter `refund`s exactly what they paid and the creator's bond is forfeited. The launched token has no blacklist. The creator may set a trading tax: only trades with the token's own V2 pair are taxed, buy and sell are each at most 5% (500 bps), and a `.ai` holder pays the lower agent rate. Of every tax, 10% goes to the platform tax sink (sold for BNB that buys back $SUAN), `burnShareBps` of the rest is burned, and the remainder goes to the creator. Wallet-to-wallet transfers are not taxed. The tax lasts from 1 day to 365 days, or forever. All zeros means no tax.

These commands only read the chain and build a transaction for the user's wallet to sign locally. They never accept, store, or send a private key.

Defaults to the BSC mainnet contracts: factory `0xb9b7d9384F22512C7A5E657fF9FF804D89Cf3b64`, router `0x9FD3887A0e0910f905Ad6F2E637cB514d5f9Eb7f` (both verified on BscScan). Override with `factory` / `router`, or `SUAN_FAIRMINT_FACTORY` / `SUAN_FAIRMINT_ROUTER`.

| Command | Params | What it does |
|---|---|---|
| `mint-list` | `limit?`, `factory?` | Newest sales: status, sold, max, deadline |
| `mint-info` | `sale`, `wallet?` | Progress, next share price, pool addresses, and whether `wallet` holds a `.ai` |
| `mint-quote` | `sale`, `shares`, `wallet?`, `ref?` | `costOf` quote. With a wallet, also the `mint` transaction |
| `mint` | `sale`, `wallet`, `shares`, `ref?` | Builds `mint(shares, referrer)`. Returns `NO_AGENT_ID` and no transaction when the wallet has no `.ai` |
| `mint-claim` | `sale`, `wallet` | Claim this wallet's tokens after launch |
| `mint-refund` | `sale`, `wallet` | Take back this wallet's BNB after a failed sale |
| `mint-create` | `wallet`, `paramsFile` or `params`, `factory?` | Runs the factory's `validate` first. `BAD_PARAMS` stops before any RPC. Otherwise builds `create` with `value` = creation fee + bond |
| `fm-buy` | `token`, `wallet`, `bnb`, `router?`, `slippageBps?`, `direct?` | Buys through SuanV2Router (1% of the BNB). `direct: true` uses the PancakeSwap V2 router with no router fee. The quote and the slippage both use this wallet's buy tax (the agent rate when it holds a `.ai`) |
| `fm-sell` | `token`, `wallet`, `amount`, `router?`, `slippageBps?`, `direct?` | Same, with the sell tax. The transaction list is `approve`, then the sell |

`mint-create` JSON: `name`, `symbol`, `meta`, `tiers` (`upTo` is the cumulative share count, `price` is BNB per share as wei or `"0.001"`), `maxShares`, `targetShares`, `deadline` (unix seconds), `perWallet`, `inviteBonus`, `maxInviteBonus`, `creatorBnbBps`, `creatorTokenBps`, `vestingSeconds`, `tax`. Omit `tax` for no tax. Fields: `buyBps`, `sellBps`, `agentBuyBps`, `agentSellBps`, `burnShareBps`, `duration` (seconds; with a tax, 1 day to 365 days, or `4294967295` for permanent). `fm-buy` / `fm-sell` return `isAgent`, `taxBps`, `taxWei`, `platformWei`, `burnedWei`, `creatorWei`. `minOutWei` is the after-tax amount minus slippage.

Run `mint-info` first. Stop and explain when the wallet has no `.ai`. Execute `baw contract-call` only after the user confirms the preview.

| Code | Meaning |
|---|---|
| `FAIRMINT_NOT_CONFIGURED` | No factory or router address |
| `BAD_PARAMS` | Params break a factory rule. `message` is the contract's `BadParams` reason |
| `NO_AGENT_ID` | The wallet has no `.ai` Agent ID |
| `NO_PAIR` | The token has no V2 pair yet |

## Safety

- Never call `execute` without showing the preview and getting the user's confirmation for that trade.
- Never execute an intercepted preview. A preview that fails with `351803` (`AGENT_DEV_MODE_RISK_BLOCKED`) has no
  `requestId`; tell the user the wallet's risk engine blocked it and stop.
- Re-quote if more than a minute has passed or the user changes the amount. During the first blocks the anti-sniper
  fee falls every block, so an older quote only underestimates the output.
- Do not raise `slippageBps` above 1000 unless the user asks for it.
- The contracts are unaudited; say so when the user asks about safety.

## Errors

| Code | Meaning | What to tell the user |
|---|---|---|
| `NO_AGENT_ID` | The .ai window is running and the wallet has no .ai Agent ID (sells: and is not the creator) | Claim a .ai Agent ID first, or wait until `windows.aiOnlyUntil` |
| `HOLDING_CAP_REACHED` | The buy would take the wallet over 1% of supply during the hold-cap window | Buy less; `holdRoom` shows the room left, and the cap ends at `windows.holdCapUntil` |
| `ANTI_SNIPER_BLOCK` | Buys in the creation block cost 100% or more | Retry from the next block |
| `SLIPPAGE` | The price moved past `minReceive` | Re-quote |
| `INSUFFICIENT_BNB` / `INSUFFICIENT_TOKEN_BALANCE` | Not enough funds | Show the balance from `info` |
| `INSUFFICIENT_ALLOWANCE` | The router is not approved | Run the `approve` transaction from `quote-sell` |
| `TRANSFER_LOCKED` / `ALT_POOL_BLOCKED` | The token only moves through its own pool right now (.ai window / tax period) | Trade through this skill's router call |
| `PRESALE_CAP` | The creator presale asks for more than 3% of supply (`maxTokens`) | Launch with a smaller presale |
| `NOT_CREATOR` / `BUYBACK_TOO_EARLY` | Creator-only call, or a buyback before the .ai window ended | Not something a trade can fix |
| `INVALID_AI_ONLY` / `INVALID_HOLD_CAP` / `INVALID_TAX_PERIOD` | Launch parameters out of range (2–30 min; ≥ .ai window and ≤ 24 h; 15–365 days or permanent) | Fix the launch parameters |
| `UNKNOWN_LAUNCH` / `BAD_HOOK` | Not a SUAN Agent Launchpad token, or wrong hook address | Check the addresses |
| `STOCK_NOT_CONFIGURED` | A stock command without the stock contract addresses | Pass `stockHook` / `stockRouter` / `stockFactory` from launch.suan.bid |
| `BASE_NOT_ALLOWED` / `UNKNOWN_BASE` | The bStock is not allowlisted for new launches, or not in this skill's table | Pick one from `bases` |
| `NO_ROUTE` | No PancakeSwap V3 route quoted the BNB ⇄ bStock leg | Trade with the bStock directly (`pay` / `receive: "base"`), or retry later |
| `INSUFFICIENT_BASE` | Not enough of the bStock | Get it with `quote-bnb-to-base`, or pay with BNB |
| `APPROVE_FIRST` | The bStock allowance could not be simulated | Approve the router (or factory) first, then quote again |
| `LAUNCHES_CLOSED` / `LAUNCH_FEE_REQUIRED` / `INVALID_TAX` / `INVALID_WEIGHTS` / `INVALID_MIN_SHARE` / `INVALID_META` | Launch parameters rejected | Fix the launch parameters |
| `RPC_UNAVAILABLE` | No RPC answered | Retry, or pass `rpc` |

`references/contracts.md` lists the contract interface, selectors, events and fee rules.
