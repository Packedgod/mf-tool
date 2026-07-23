import fs from 'node:fs/promises';
import path from 'node:path';

// Point-in-time evidence (index membership, EPS history, month-end portfolios) cannot be
// reconstructed from any free source after the fact, so the app banks it as it goes.
// Serverless filesystems are read-only, so every write degrades to a no-op rather than
// failing the request that triggered it.
const ROOT = path.join(process.cwd(), 'data', 'journal');

let writable = null;

async function ensureRoot() {
  if (writable !== null) return writable;
  try {
    await fs.mkdir(ROOT, { recursive: true });
    writable = true;
  } catch {
    writable = false;
  }
  return writable;
}

function resolve(name) {
  // Journal names are internal constants, but keep them from escaping the directory.
  const safe = String(name).replace(/[^a-z0-9._-]/gi, '-');
  return path.join(ROOT, `${safe}.json`);
}

export async function readJournal(name, fallback = {}) {
  try {
    const raw = await fs.readFile(resolve(name), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJournal(name, value) {
  if (!(await ensureRoot())) return false;
  const target = resolve(name);
  try {
    // Write-then-rename so a crash mid-write cannot truncate an existing journal.
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), 'utf8');
    await fs.rename(temp, target);
    return true;
  } catch {
    return false;
  }
}

// Appends one dated observation per key, ignoring repeats inside `minGapDays` so a busy
// day cannot flood the series and distort the spacing that growth maths depends on.
export function appendObservation(series, observation, { minGapDays = 20, maxPoints = 40 } = {}) {
  const list = Array.isArray(series) ? [...series] : [];
  const latest = list[list.length - 1];
  if (latest?.date) {
    const gapDays = (Date.parse(observation.date) - Date.parse(latest.date)) / 86400000;
    if (Number.isFinite(gapDays) && gapDays < minGapDays) return list;
  }
  list.push(observation);
  return list.slice(-maxPoints);
}

// Finds the observation closest to `targetDays` ago, but only accepts it when it lands
// inside `toleranceDays` — a "year-ago" comparison built from a four-month-old point
// would silently understate growth.
export function observationNearAge(series, targetDays, toleranceDays) {
  const list = Array.isArray(series) ? series : [];
  if (list.length < 2) return null;
  const now = Date.now();
  let best = null;
  for (const item of list) {
    const ageDays = (now - Date.parse(item.date)) / 86400000;
    if (!Number.isFinite(ageDays)) continue;
    const distance = Math.abs(ageDays - targetDays);
    if (distance > toleranceDays) continue;
    if (!best || distance < best.distance) best = { item, distance, ageDays };
  }
  return best?.item || null;
}

export function journalRoot() {
  return ROOT;
}
