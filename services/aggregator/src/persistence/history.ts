import fs from 'fs';
import path from 'path';
import { logger } from '../observability/logger';
import { config } from '../infrastructure/config';
import { encrypt, decrypt, isEncrypted, isEncryptionConfigured } from '../infrastructure/crypto';
import { Result, err, ok } from '../infrastructure/result';

export interface HistoricalPriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

export const DATA_DIR = path.resolve(__dirname, '../../data');
export const HISTORY_FILE = (asset: string) => path.join(DATA_DIR, `history-${asset.toLowerCase()}.json`);

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Whether historical price files should be encrypted at rest (issue #41). */
export function historyEncryptionEnabled(): boolean {
  return config.security.encryption.encryptHistory && isEncryptionConfigured();
}

/**
 * Read and parse a per-asset history file as a {@link Result} (issue #299).
 * Missing files are a valid "no history yet" outcome; parse/decrypt failures
 * are returned as errors so callers can log with context.
 */
export function readHistoryFileResult(filePath: string): Result<HistoricalPriceEntry[], Error> {
  if (!fs.existsSync(filePath)) return ok([]);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    logger.error(`Failed to read history file ${filePath}`, { path: filePath, error: error.message });
    return err(error);
  }
  if (!raw) return ok([]);

  try {
    const contents = isEncrypted(raw) ? decrypt(raw) : raw;
    return ok(JSON.parse(contents) as HistoricalPriceEntry[]);
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    logger.error(`Failed to parse history file ${filePath}`, { path: filePath, error: error.message });
    return err(error);
  }
}

export function readHistoryFile(filePath: string): HistoricalPriceEntry[] {
  const result = readHistoryFileResult(filePath);
  return result.ok ? result.value : [];
}

export function writeHistoryFile(filePath: string, history: HistoricalPriceEntry[]): void {
  const serialized = JSON.stringify(history);
  const payload = historyEncryptionEnabled() ? encrypt(serialized) : serialized;
  fs.writeFileSync(filePath, payload);
}

/**
 * Drop entries older than the retention window, then keep only the newest
 * maxEntries (issue #214). Entry timestamps are Unix seconds.
 */
function pruneHistory(history: HistoricalPriceEntry[]): HistoricalPriceEntry[] {
  const { maxEntries, retentionSeconds } = config.history;
  let pruned = history;

  if (retentionSeconds > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
    pruned = pruned.filter((h) => h.timestamp >= cutoff);
  }

  return maxEntries > 0 && pruned.length > maxEntries ? pruned.slice(-maxEntries) : pruned;
}

export function appendHistoricalPrice(
  asset: string,
  price: string,
  decimals: number,
  source: string,
  timestamp: number,
): void {
  ensureDataDir();
  const filePath = HISTORY_FILE(asset);
  let history: HistoricalPriceEntry[] = [];
  const read = readHistoryFileResult(filePath);
  if (read.ok) {
    history = read.value;
  } else {
    logger.warn(`Appending to corrupt history file for ${asset}; starting fresh`, {
      asset,
      path: filePath,
      error: read.error.message,
    });
  }
  history.push({ price, decimals, source, timestamp });
  writeHistoryFile(filePath, pruneHistory(history));
}

export function getHistoricalPrices(
  asset: string,
  from?: number,
  to?: number,
  limit = 100,
): HistoricalPriceEntry[] {
  const filePath = HISTORY_FILE(asset);
  const read = readHistoryFileResult(filePath);
  if (!read.ok) {
    logger.error(`Failed to read history for ${asset}`, {
      asset,
      path: filePath,
      error: read.error.message,
    });
    return [];
  }
  let history = read.value;
  if (from) history = history.filter((h) => h.timestamp >= from);
  if (to) history = history.filter((h) => h.timestamp <= to);
  return history.slice(-limit);
}
