// Warms the month-end portfolio archive for a set of schemes.
//
// The archive is what makes turnover, entry/exit attribution and trading-execution scoring
// possible: those need two *dated* portfolios for the same scheme, and no free source
// publishes historical disclosures. Running this monthly builds that history going forward.
//
//   npm run sync:portfolios              # top schemes from the AMFI universe
//   npm run sync:portfolios -- 120503 119551
//   npm run sync:portfolios -- --limit 60
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// The lib modules use Next's "@/" alias, so the resolver has to be registered before any
// of them are imported — hence the dynamic imports below rather than static ones.
register('./alias-loader.mjs', import.meta.url);

const { getMarketUniverse } = await import('@/lib/universe');
const { resolveFundResearch } = await import('@/lib/fallback-sources');
const { archivedMonths, archiveCoverage } = await import('@/lib/portfolio-archive');

const args = process.argv.slice(2);
const limitFlag = args.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) || 40 : 40;

// The value belonging to --limit must be removed before scanning for scheme codes,
// otherwise "--limit 3" is read as a request for scheme 3. AMFI codes are 4-9 digits.
const positional = args.filter((value, index) => index !== limitFlag && index !== limitFlag + 1);
const explicitCodes = positional.filter(value => /^\d{4,9}$/.test(value));

function log(message) {
  process.stdout.write(`${message}\n`);
}

const universe = await getMarketUniverse();
log(`AMFI universe: ${universe.schemes.length} scheme variants, ${universe.families.length} families (${universe.cache}).`);

// One growth/direct variant per family is enough: variants of the same scheme share a
// portfolio, so archiving each would store the same holdings repeatedly.
const targets = explicitCodes.length
  ? explicitCodes.map(code => {
      const scheme = universe.schemes.find(item => String(item.schemeCode) === code);
      return scheme && { id: `scheme:${scheme.schemeCode}`, preferredSchemeCode: scheme.schemeCode, displayName: scheme.schemeName, category: scheme.category };
    }).filter(Boolean)
  : universe.families
      .filter(family => family.managers?.length)
      .slice(0, limit)
      .map(family => ({
        id: family.id,
        preferredSchemeCode: family.preferredSchemeCode || family.variants?.[0]?.schemeCode,
        displayName: family.displayName || family.name,
        category: family.category,
        variants: family.variants
      }))
      .filter(item => item.preferredSchemeCode);

if (!targets.length) {
  log('No target schemes resolved. Pass explicit AMFI scheme codes, or check the universe fetch.');
  process.exit(1);
}

log(`Archiving month-end portfolios for ${targets.length} schemes...\n`);

let archived = 0;
let withHistory = 0;
let failed = 0;

for (const [index, fund] of targets.entries()) {
  const label = `${String(index + 1).padStart(3)}/${targets.length} ${String(fund.displayName || fund.id).slice(0, 52).padEnd(52)}`;
  try {
    const research = await resolveFundResearch(fund);
    const holdings = research?.current?.holdings?.length || 0;
    const months = await archivedMonths(fund.preferredSchemeCode);
    if (holdings) archived += 1;
    if (months.length > 1) withHistory += 1;
    log(`${label} ${String(holdings).padStart(3)} holdings | ${months.length} month(s) archived${months.length ? ` [${months[0]}..${months[months.length - 1]}]` : ''}`);
  } catch (error) {
    failed += 1;
    log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const coverage = await archiveCoverage();
log(`\nArchived a portfolio for ${archived}/${targets.length} schemes (${failed} failed).`);
log(`Archive now holds ${coverage.totalSnapshots} snapshots across ${coverage.schemes} schemes; ${coverage.schemesWithHistory} have two or more months and can be compared.`);
if (!withHistory) {
  log('\nNo scheme has comparable history yet. Portfolio-change scoring needs a second');
  log('month-end disclosure, so re-run this after next month-end.');
}
