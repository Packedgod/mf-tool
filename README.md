# ManagerLens — MF Manager Decision Intelligence

ManagerLens is a manager-first Indian mutual fund analytics tool. It starts with a verified fund-manager directory, maps each manager to a scheme and role, pulls live NAV history from MFapi.in, validates the latest NAV against AMFI where available, builds a disclosed comparison proxy, and calculates manager-tenure-aware performance metrics and counterfactuals.

## What changed in this rebuild

- Added a visible directory of 14 verified mutual fund managers and co-managers from official AMC factsheets.
- Removed brittle first-search-result logic and replaced it with ranked scheme matching and AMFI fallback resolution.
- Added five-minute server-side caching and stale-data fallback so temporary upstream failures do not blank the dashboard.
- Changed automatic refresh to a silent 15-minute sync that retains the last good dataset if an upstream source is unavailable.
- Removed blocking popups and replaced them with one non-intrusive status strip.
- Added manager-tenure-aware analysis windows.
- Added official, category, broad-market and defensive proxy standards.
- Added synthetic 50/50 equity-liquid proxy construction for balanced-advantage analysis.
- Added data-confidence grading separate from the manager decision score.
- Rebuilt the interface as a responsive desktop workspace and mobile manager carousel with tabs.

## Valid source lanes

- **MFapi.in:** live Indian scheme search and NAV history.
- **AMFI NAVAll:** official latest-NAV validation and fallback scheme resolution.
- **Official AMC factsheets:** manager names, roles, start dates and scheme decision context.
- **Yahoo Finance:** optional global/index context; never blocks Indian MF analysis.
- **Google Finance:** manual verification link; not scraped as an unofficial API.
- **FMP:** optional global ETF/fund information when `FMP_API_KEY` is configured.

## Metrics

- CAGR and total return
- Annualised volatility
- Sharpe ratio
- Maximum drawdown
- Beta and Jensen-style alpha
- Active return and tracking error
- Information ratio
- Upside and downside capture
- Positive-month hit rate
- Alpha-persistence score
- Manager value-add versus the selected proxy
- Data-confidence grade

## What-if scenarios

- Passive benchmark replacement
- Zero-alpha baseline
- Allocation-weight decision effect
- Fee-drag sensitivity
- Improved downside capture
- Improved upside capture

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Vercel

Connect the GitHub repository to Vercel. Every push to `main` should trigger a deployment.

Optional FMP variable:

```text
FMP_API_KEY=your_key_here
```

The core Indian manager analysis does not require the FMP key.

## Important interpretation note

Manager-level causality cannot be proven from NAV alone. ManagerLens uses official manager tenure and role records, then evaluates the scheme outcome during that window against transparent proxies. The results are diagnostic estimates, not investment advice or a claim that every return difference was caused by one individual.
