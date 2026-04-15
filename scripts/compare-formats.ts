#!/usr/bin/env tsx
/**
 * Empirically compare manifest size across encodings:
 *   - original (pretty-printed JSON, as on disk)
 *   - compact JSON (no whitespace)
 *   - compact JSON gzipped
 *   - compact JSON stripped of block.text, gzipped
 * Report per-file and aggregate totals.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("Usage: tsx scripts/compare-formats.ts <data-dir>");
  process.exit(1);
}

const manifestsDir = join(dataDir, "manifests");
const files = readdirSync(manifestsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

let origTotal = 0;
let compactTotal = 0;
let compactGzTotal = 0;
let strippedCompactTotal = 0;
let strippedCompactGzTotal = 0;

const showcase: Array<{
  file: string;
  orig: number;
  compact: number;
  compactGz: number;
  strippedCompact: number;
  strippedCompactGz: number;
}> = [];

const sampleIndices = new Set([0, 100, 1000, 3000, 6000, files.length - 1]);

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const p = join(manifestsDir, f);
  const origSize = statSync(p).size;
  origTotal += origSize;

  const raw = readFileSync(p);
  const obj = JSON.parse(raw.toString("utf8"));

  const compact = Buffer.from(JSON.stringify(obj), "utf8");
  compactTotal += compact.length;

  const compactGz = gzipSync(compact);
  compactGzTotal += compactGz.length;

  if (Array.isArray(obj.blocks)) {
    obj.blocks = obj.blocks.map((b: Record<string, unknown>) => {
      const { text, ...rest } = b;
      void text;
      return rest;
    });
  }
  const strippedCompact = Buffer.from(JSON.stringify(obj), "utf8");
  strippedCompactTotal += strippedCompact.length;

  const strippedCompactGz = gzipSync(strippedCompact);
  strippedCompactGzTotal += strippedCompactGz.length;

  if (sampleIndices.has(i)) {
    showcase.push({
      file: f,
      orig: origSize,
      compact: compact.length,
      compactGz: compactGz.length,
      strippedCompact: strippedCompact.length,
      strippedCompactGz: strippedCompactGz.length,
    });
  }

  if ((i + 1) % 1000 === 0) {
    process.stderr.write(`  processed ${i + 1}/${files.length}\n`);
  }
}

const mb = (n: number) => +(n / 1024 / 1024).toFixed(1);
const gb = (n: number) => +(n / 1024 / 1024 / 1024).toFixed(2);
const pct = (n: number, base: number) => `${((n / base) * 100).toFixed(1)}%`;

console.log("\n=== Sample files ===");
for (const s of showcase) {
  console.log(`\n${s.file}`);
  console.log(`  orig (pretty):                 ${mb(s.orig)} MB`);
  console.log(`  compact JSON:                  ${mb(s.compact)} MB  (${pct(s.compact, s.orig)})`);
  console.log(`  compact + gzip:                ${mb(s.compactGz)} MB  (${pct(s.compactGz, s.orig)})`);
  console.log(`  compact + stripped text:       ${mb(s.strippedCompact)} MB  (${pct(s.strippedCompact, s.orig)})`);
  console.log(`  compact + stripped + gzip:     ${mb(s.strippedCompactGz)} MB  (${pct(s.strippedCompactGz, s.orig)})`);
}

console.log("\n=== Aggregate (all 6088 manifests) ===");
console.log(`original (pretty-printed):             ${gb(origTotal)} GB`);
console.log(`compact JSON:                          ${gb(compactTotal)} GB  (${pct(compactTotal, origTotal)}, saves ${gb(origTotal - compactTotal)} GB)`);
console.log(`compact + gzip:                        ${gb(compactGzTotal)} GB  (${pct(compactGzTotal, origTotal)}, saves ${gb(origTotal - compactGzTotal)} GB)`);
console.log(`compact + stripped-text:               ${gb(strippedCompactTotal)} GB  (${pct(strippedCompactTotal, origTotal)}, saves ${gb(origTotal - strippedCompactTotal)} GB)`);
console.log(`compact + stripped-text + gzip:        ${gb(strippedCompactGzTotal)} GB  (${pct(strippedCompactGzTotal, origTotal)}, saves ${gb(origTotal - strippedCompactGzTotal)} GB)`);
