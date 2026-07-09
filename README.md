# MF Manager Decision Intelligence Tool

This is a **manager-first** live mutual fund analytics tool. The goal is not just to track NAV. The tool is designed to answer:

> How did the mutual fund manager's performance, style, risk-taking and portfolio decisions affect the fund's alpha, drawdown, upside/downside capture and investor outcome?

## Core workflow

1. Select a mutual fund manager from the manager universe.
2. The tool maps that manager to relevant schemes and decision areas.
3. It pulls live/historical NAV data from MFapi.in and AMFI-backed sources.
4. It compares the fund against a selected benchmark or peer proxy.
5. It calculates alpha, Sharpe, information ratio, beta, tracking error, upside/downside capture, max drawdown and alpha persistence.
6. It runs what-if scenarios for manager decisions.

## What changed in this rebuild

The previous version was fund-first. This rebuild is **manager-first**:

- Added a fund-manager universe.
- Added manager thesis, decision areas and manager-start-date logic.
- Added manager-aware analysis start date.
- Added decision attribution layer.
- Added passive-replacement and no-alpha style counterfactuals.
- Added fee-drag, downside-capture, upside-capture and allocation-change what-if modules.
- Added Yahoo Finance adapters for global symbol search, chart and summary data.
- Added a source coverage map showing which data source can and cannot provide manager-level data.
- Improved UI into a guided cockpit instead of basic boxes.

## Live data sources

### MFapi.in
Used for Indian scheme search and historical NAV.

### AMFI
Used for official latest NAV validation.

### Yahoo Finance
Used for global symbol search, historical chart data and selected fund/ETF summary modules where coverage exists.

### Google Finance
Used as a public verification link. There is no stable official free public API exposed for automated extraction, so the app does not pretend otherwise.

### FMP
Optional global ETF/fund data through `FMP_API_KEY`.

### AMC factsheets / Value Research / Morningstar
These are the sources needed for full manager roster, manager changes, holdings %, turnover, TER and detailed portfolio-level decision data. The app is designed to plug these in through a permitted parser or licensed data feed.

## Metrics calculated

- CAGR
- Total return
- Volatility
- Sharpe ratio
- Max drawdown
- Beta
- Jensen-style annual alpha
- Active return
- Tracking error
- Information ratio
- Upside capture
- Downside capture
- Overall capture
- Positive-month hit rate
- Alpha persistence proxy
- Decision-quality score

## What-if scenarios

- What if the manager simply followed the benchmark?
- What if alpha was zero?
- What if expense drag changed?
- What if downside capture improved?
- What if upside capture improved?
- What if a manager changed allocation weight, such as cash deployment, overseas sleeve, sector overweight or equity exposure?

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

Free public Indian endpoints provide strong NAV and scheme-level data, but they do not provide a complete real-time manager roster + holdings + turnover + TER + manager-change history feed for every Indian mutual fund. This tool therefore separates:

- **live numerical analysis** from MFapi/AMFI/Yahoo/FMP, and
- **manager roster / holdings / decision-source coverage**, which requires AMC factsheets, Value Research, Morningstar, or another licensed/permitted data feed.

This separation is deliberate so the tool remains honest and does not fake manager-level data from NAV-only sources.

This is a research tool, not investment advice.
