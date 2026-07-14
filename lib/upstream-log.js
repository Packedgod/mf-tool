import fs from "node:fs";
import path from "node:path";

// Persistent log of upstream data-source failures (AMFI, Yahoo, mfapi, VRO).
// Written to logs/upstream-errors.log at the project root so that persistent
// errors are captured for diagnosis even when the UI has degraded gracefully.

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "upstream-errors.log");

let ensured = false;
function ensureDir() {
  if (ensured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ensured = true;
  } catch {
    // best-effort; never throw from the logger
  }
}

export function logUpstreamError(context, error, meta = {}) {
  try {
    ensureDir();
    const message = error instanceof Error ? error.message : String(error);
    const record = {
      at: new Date().toISOString(),
      context,
      message,
      ...meta
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  } catch {
    // Logging must never break a request.
  }
  // Also mirror to stderr so it shows up in the dev/server console.
  try {
    console.warn(`[upstream:${context}]`, error instanceof Error ? error.message : String(error));
  } catch {}
}

export function upstreamLogPath() {
  return LOG_FILE;
}
