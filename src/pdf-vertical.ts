import { closeSync, openSync, readSync } from "node:fs";

const IDENTITY_V_MARKER = Buffer.from("/Identity-V", "latin1");
const SCAN_CHUNK_SIZE = 1024 * 1024;

const cache = new Map<string, boolean>();

function scanForVerticalEncoding(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }

  try {
    const overlap = IDENTITY_V_MARKER.length - 1;
    const buf = Buffer.allocUnsafe(SCAN_CHUNK_SIZE + overlap);
    let position = 0;
    let carry = 0;
    while (true) {
      const bytesRead = readSync(fd, buf, carry, SCAN_CHUNK_SIZE, position);
      if (bytesRead === 0) break;
      const total = carry + bytesRead;
      if (buf.subarray(0, total).indexOf(IDENTITY_V_MARKER) !== -1) {
        return true;
      }
      position += bytesRead;
      const carryStart = Math.max(0, total - overlap);
      carry = total - carryStart;
      if (carry > 0) {
        buf.copy(buf, 0, carryStart, total);
      }
    }
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export function pdfHasVerticalText(filePath: string): boolean {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  const result = scanForVerticalEncoding(filePath);
  cache.set(filePath, result);
  return result;
}

export function clearPdfVerticalCache(): void {
  cache.clear();
}

export function pdfVerticalCacheSize(): number {
  return cache.size;
}
