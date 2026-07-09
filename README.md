# MF Live Manager Analytics Tool

A live mutual fund analytics dashboard for Indian mutual funds using **MFapi.in** and **AMFI**, with optional **Financial Modeling Prep (FMP)** support for global ETF/fund information.

## What it does

- Searches Indian mutual funds from MFapi.in.
- Pulls full historical NAV data by scheme code.
- Lets you select a benchmark or peer proxy.
- Calculates CAGR, volatility, Sharpe ratio, max drawdown, beta, alpha, tracking error, information ratio, upside capture and downside capture.
- Includes a decision-impact simulator for allocation changes.
- Provides a live decision-quality proxy score based on realised NAV behaviour.

## Sources

- MFapi.in: Indian mutual fund scheme search and NAV history.
- AMFI NAVAll.txt: official latest NAV cross-check.
- FMP: optional global ETF/fund information, holdings and allocation endpoints. Requires `FMP_API_KEY`.

## Run locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Deploy on Vercel

```bash
npm install -g vercel
vercel --prod
```

## Optional FMP key

Create `.env.local`:

```bash
FMP_API_KEY=your_key_here
```

MFapi and AMFI do not require an API key.

## Important limitation

Public Indian endpoints provide NAV and scheme-level data, but not a complete single feed of fund-manager rosters, manager start dates, TER, turnover, holdings and benchmark-relative risk ratios for every scheme. This tool therefore evaluates manager decision quality from realised fund behaviour versus a chosen benchmark or peer proxy.

This is a research tool, not investment advice.
