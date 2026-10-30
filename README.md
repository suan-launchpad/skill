# SUAN — agent skill

One agent skill for three SUAN products on BNB Chain. It reads the chain, prices fees for your wallet's .ai Agent ID
status, simulates the trade and builds the transaction for the Binance Agentic Wallet (`baw contract-call`). It never
signs or sends.

| Product | What the skill does |
|---|---|
| [Agent Launchpad](https://launch.suan.bid) | Stage, time windows and fees of a token; quote and build buys and sells (BNB launches and stock memes); claim holder rewards |
| [Fair Mint](https://launch.suan.bid/mint) | `.ai` Agent ID only mints: list and inspect sales, quote and mint, claim tokens or refunds, create a sale, trade launched tokens with their tax |
| [Predictions](https://predict.suan.bid) | List markets, quote odds and payouts, place bets, claim |

Mainnet contracts are built in: the launchpad hook and router, and the fair mint factory
`0xb9b7d9384F22512C7A5E657fF9FF804D89Cf3b64` and router `0x9FD3887A0e0910f905Ad6F2E637cB514d5f9Eb7f`.

`SKILL.md` plus zero-dependency scripts; Node 22 or newer.

## Install

For Claude Code:

```bash
git clone https://github.com/suan-launchpad/skill ~/.claude/skills/suan-launchpad
```

or download the archive from the site:

```bash
mkdir -p ~/.claude/skills
curl -fsSL https://launch.suan.bid/skill/suan-launchpad.tar.gz | tar -xz -C ~/.claude/skills
```

Other agents that load skills (Codex, OpenClaw, …): put this folder in their skills directory.

## Use

```bash
node scripts/suan-launchpad.mjs info '{"token":"0x…","wallet":"0x…"}'
node scripts/suan-launchpad.mjs quote-buy '{"token":"0x…","wallet":"0x…","amount":"0.05"}'
```

The BSC mainnet hook and router are built in. Override them only with addresses published on launch.suan.bid
(`hook` / `router` params or `SUAN_LAUNCHPAD_HOOK` / `SUAN_LAUNCHPAD_ROUTER`). See `SKILL.md` for every command.

## Test

```bash
node --test 'test/*.test.mjs'
```

Contracts: [suan-launchpad/contracts](https://github.com/suan-launchpad/contracts).
