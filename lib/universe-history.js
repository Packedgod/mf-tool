import { readJournal, writeJournal } from '@/lib/snapshot-store';

// Peer-relative scoring is survivorship-biased whenever the peer set is drawn from *today's*
// category membership: funds that merged or closed after underperforming are simply absent.
// No free source publishes historical membership, so the ledger is accumulated locally.
//
// A full daily snapshot of ~10k schemes would grow without bound, so each scheme is stored
// once as a first-seen/last-seen span. Membership at any past date inside the observed
// window is then a range check, and a scheme whose span ended early is a retired fund.
const LEDGER = 'amfi-universe-ledger';
const DAY_MS = 86400000;

// A scheme absent for longer than this is treated as retired rather than a transient gap in
// the AMFI file, which occasionally drops schemes for a day around holidays.
const RETIREMENT_GRACE_DAYS = 10;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function state() {
  globalThis.__MANAGERLENS_UNIVERSE_LEDGER__ ??= { at: 0, value: null, pending: null };
  return globalThis.__MANAGERLENS_UNIVERSE_LEDGER__;
}

export async function loadLedger() {
  const cached = state();
  if (cached.value && Date.now() - cached.at < 60 * 60 * 1000) return cached.value;
  const value = await readJournal(LEDGER, { startedOn: null, updatedOn: null, schemes: {} });
  cached.value = value;
  cached.at = Date.now();
  return value;
}

// Called on every universe refresh. Writes at most once per day: the ledger's resolution is
// a date, so repeated intraday calls would rewrite an identical file.
export async function recordUniverseObservation(schemes) {
  if (!Array.isArray(schemes) || !schemes.length) return null;
  const cached = state();
  if (cached.pending) return cached.pending;

  cached.pending = (async () => {
    try {
      const ledger = await loadLedger();
      const date = today();
      if (ledger.updatedOn === date) return ledger;

      const next = {
        startedOn: ledger.startedOn || date,
        updatedOn: date,
        schemes: { ...ledger.schemes }
      };

      for (const scheme of schemes) {
        const code = String(scheme.schemeCode || '').trim();
        if (!code) continue;
        const existing = next.schemes[code];
        if (existing) {
          next.schemes[code] = { ...existing, l: date, c: scheme.category || existing.c };
        } else {
          next.schemes[code] = { f: date, l: date, c: scheme.category || 'Unclassified' };
        }
      }

      await writeJournal(LEDGER, next);
      cached.value = next;
      cached.at = Date.now();
      return next;
    } finally {
      cached.pending = null;
    }
  })();
  return cached.pending;
}

// Describes how much genuine history the ledger holds, so callers can state their own
// survivorship exposure honestly instead of assuming today's membership held throughout.
export async function membershipCoverage() {
  const ledger = await loadLedger();
  const codes = Object.keys(ledger.schemes || {});
  if (!codes.length || !ledger.startedOn) {
    return { observedDays: 0, startedOn: null, updatedOn: null, trackedSchemes: 0, retiredSchemes: 0 };
  }

  const observedDays = Math.max(0, Math.round((Date.parse(ledger.updatedOn) - Date.parse(ledger.startedOn)) / DAY_MS));
  const cutoff = Date.parse(ledger.updatedOn) - RETIREMENT_GRACE_DAYS * DAY_MS;
  let retired = 0;
  for (const code of codes) if (Date.parse(ledger.schemes[code].l) < cutoff) retired += 1;

  return {
    observedDays,
    startedOn: ledger.startedOn,
    updatedOn: ledger.updatedOn,
    trackedSchemes: codes.length,
    retiredSchemes: retired
  };
}

// Scheme codes that were live on `date`, including funds since merged or closed. Returns
// null when the date predates the ledger, so callers fall back rather than silently
// receiving a survivorship-biased answer dressed up as point-in-time.
export async function membershipAt(date) {
  const ledger = await loadLedger();
  if (!ledger.startedOn || date < ledger.startedOn) return null;
  const codes = [];
  for (const [code, span] of Object.entries(ledger.schemes || {})) {
    if (span.f <= date && date <= span.l) codes.push(code);
  }
  return codes.length ? codes : null;
}

// True only when the ledger spans the whole analysis window; a partially covered window
// still carries survivorship bias over its uncovered portion.
export async function coversWindow(startDate) {
  const ledger = await loadLedger();
  if (!ledger.startedOn || !startDate) return false;
  return ledger.startedOn <= String(startDate).slice(0, 10);
}
