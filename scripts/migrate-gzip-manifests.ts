#!/usr/bin/env tsx
/**
 * One-time migration: convert `manifests/*.json` (pretty-printed) to
 * `manifests/*.json.gz` (compact JSON, gzip-compressed).
 *
 * Modes:
 *   --dry-run  : read all, estimate sizes, no writes
 *   --apply    : write .json.gz for each, verify round-trip, then remove .json
 *   --verify   : check .json.gz files exist and parse to valid manifests
 *
 * Safety:
 *   - atomic write (tmp + rename)
 *   - round-trip verification (decode + compare block count + docKey) before removing .json
 *   - resumable (skips files whose .json.gz already exists and round-trips correctly)
 *
 * Usage:
 *   tsx scripts/migrate-gzip-manifests.ts --data-dir <path> (--dry-run|--apply|--verify)
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

type Mode = "dry-run" | "apply" | "verify";

interface Args {
  dataDir: string;
  mode: Mode;
}

interface ManifestLike {
  docKey: string;
  blocks: Array<{ blockIndex: number; [k: string]: unknown }>;
  [k: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  let dataDir = "";
  let mode: Mode | "" = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") dataDir = argv[++i] ?? "";
    else if (a === "--dry-run") mode = "dry-run";
    else if (a === "--apply") mode = "apply";
    else if (a === "--verify") mode = "verify";
  }
  if (!dataDir || !mode) {
    console.error(
      "Usage: tsx scripts/migrate-gzip-manifests.ts --data-dir <path> (--dry-run|--apply|--verify)",
    );
    process.exit(1);
  }
  return { dataDir, mode };
}

const mb = (n: number) => +(n / 1024 / 1024).toFixed(1);
const gb = (n: number) => +(n / 1024 / 1024 / 1024).toFixed(2);

function main(): void {
  const { dataDir, mode } = parseArgs(process.argv.slice(2));
  const manifestsDir = join(dataDir, "manifests");
  if (!existsSync(manifestsDir))
    throw new Error(`manifests dir not found: ${manifestsDir}`);

  const entries = readdirSync(manifestsDir);
  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const gzFiles = entries.filter((f) => f.endsWith(".json.gz")).sort();

  console.log(
    `Found: ${jsonFiles.length} .json, ${gzFiles.length} .json.gz in ${manifestsDir}`,
  );
  console.log(`Mode: ${mode}`);

  if (mode === "dry-run") {
    let origTotal = 0;
    let gzEstimateTotal = 0;
    const startAt = Date.now();
    for (let i = 0; i < jsonFiles.length; i++) {
      const p = join(manifestsDir, jsonFiles[i]);
      origTotal += statSync(p).size;
      const raw = readFileSync(p);
      const obj = JSON.parse(raw.toString("utf8"));
      const compact = Buffer.from(JSON.stringify(obj), "utf8");
      gzEstimateTotal += gzipSync(compact).length;
      if ((i + 1) % 1000 === 0) {
        process.stderr.write(`  scanned ${i + 1}/${jsonFiles.length}\n`);
      }
    }
    const elapsed = (Date.now() - startAt) / 1000;
    console.log({
      files: jsonFiles.length,
      originalTotalMB: mb(origTotal),
      originalTotalGB: gb(origTotal),
      gzipTotalMB: mb(gzEstimateTotal),
      gzipTotalGB: gb(gzEstimateTotal),
      savingsGB: gb(origTotal - gzEstimateTotal),
      ratio: `${((gzEstimateTotal / origTotal) * 100).toFixed(1)}%`,
      elapsedSeconds: +elapsed.toFixed(1),
    });
    return;
  }

  if (mode === "verify") {
    let ok = 0,
      bad = 0;
    const badFiles: string[] = [];
    for (const f of gzFiles) {
      const p = join(manifestsDir, f);
      try {
        const buf = readFileSync(p);
        const decoded = gunzipSync(buf).toString("utf8");
        const obj = JSON.parse(decoded) as ManifestLike;
        if (typeof obj.docKey === "string" && Array.isArray(obj.blocks)) ok++;
        else {
          bad++;
          badFiles.push(f);
        }
      } catch (e) {
        bad++;
        badFiles.push(f);
      }
    }
    console.log({
      gzFiles: gzFiles.length,
      valid: ok,
      invalid: bad,
      sampleInvalid: badFiles.slice(0, 5),
      remainingJsonFiles: jsonFiles.length,
    });
    return;
  }

  // --apply
  const startAt = Date.now();
  let converted = 0;
  let skipped = 0;
  let errors: string[] = [];
  let totalOrig = 0;
  let totalGz = 0;

  for (let i = 0; i < jsonFiles.length; i++) {
    const jsonName = jsonFiles[i];
    const jsonPath = join(manifestsDir, jsonName);
    const gzPath = jsonPath + ".gz";

    try {
      const origSize = statSync(jsonPath).size;
      totalOrig += origSize;

      const raw = readFileSync(jsonPath);
      const obj = JSON.parse(raw.toString("utf8")) as ManifestLike;

      // Skip if gz already exists AND round-trips to same docKey + block count
      if (existsSync(gzPath)) {
        try {
          const existing = JSON.parse(
            gunzipSync(readFileSync(gzPath)).toString("utf8"),
          ) as ManifestLike;
          if (
            existing.docKey === obj.docKey &&
            Array.isArray(existing.blocks) &&
            existing.blocks.length === obj.blocks.length
          ) {
            unlinkSync(jsonPath);
            skipped++;
            totalGz += statSync(gzPath).size;
            continue;
          }
        } catch {
          // fall through and overwrite
        }
      }

      const compact = Buffer.from(JSON.stringify(obj), "utf8");
      const gz = gzipSync(compact, { level: 9 });

      const tmpPath = gzPath + ".tmp";
      writeFileSync(tmpPath, gz);

      // Round-trip verification before touching originals
      const rtDecoded = gunzipSync(readFileSync(tmpPath)).toString("utf8");
      const rt = JSON.parse(rtDecoded) as ManifestLike;
      if (
        rt.docKey !== obj.docKey ||
        !Array.isArray(rt.blocks) ||
        rt.blocks.length !== obj.blocks.length
      ) {
        unlinkSync(tmpPath);
        throw new Error(
          `round-trip mismatch for ${jsonName}: docKey or block count differs`,
        );
      }

      renameSync(tmpPath, gzPath);
      unlinkSync(jsonPath);
      totalGz += gz.length;
      converted++;
    } catch (e) {
      errors.push(`${jsonName}: ${(e as Error).message}`);
    }

    if ((i + 1) % 500 === 0) {
      const elapsed = (Date.now() - startAt) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (jsonFiles.length - i - 1) / rate;
      console.log(
        `  ${i + 1}/${jsonFiles.length} converted=${converted} skipped=${skipped} errors=${errors.length} elapsed=${elapsed.toFixed(1)}s eta=${eta.toFixed(1)}s`,
      );
    }
  }

  const elapsed = (Date.now() - startAt) / 1000;
  console.log("\n=== Summary ===");
  console.log({
    files: jsonFiles.length,
    converted,
    skipped,
    errors: errors.length,
    originalGB: gb(totalOrig),
    gzippedGB: gb(totalGz),
    savingsGB: gb(totalOrig - totalGz),
    ratio:
      totalOrig > 0
        ? `${((totalGz / totalOrig) * 100).toFixed(1)}%`
        : "n/a",
    elapsedSeconds: +elapsed.toFixed(1),
  });
  if (errors.length > 0) {
    console.log("Sample errors:");
    for (const err of errors.slice(0, 5)) console.log(`  ${err}`);
  }
}

main();
