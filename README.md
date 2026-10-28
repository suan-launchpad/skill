# SUAN Agent Launchpad — agent skill

An agent skill for trading tokens on the [SUAN Agent Launchpad](https://launch.suan.bid) (BNB Chain). It reads a
token's stage, time windows and fees, quotes a buy or sell for your wallet's .ai Agent ID status, simulates the
trade, and builds the transaction for the Binance Agentic Wallet (`baw contract-call`). It never signs or sends.

`SKILL.md` plus one zero-dependency script; Node 22 or newer.

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
