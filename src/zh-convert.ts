// Uses the compact t→cn subpath bundle (~69 KB) instead of the 1 MB full bundle,
// since we only need traditional → simplified folding for search normalization.
import { Converter, type ConverterFunction } from "opencc-js/t2cn";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved opencc-js version, fed into the sync indexer signature. opencc-js
// drives `toSimplified`, which normalizes both the keyword index (at write time)
// and queries (at read time), so an upgrade that changes its conversion output
// must invalidate the keyword index — otherwise indexed rows and queries
// normalize differently and silently miss matches. opencc-js's exports map
// blocks `opencc-js/package.json`, so resolve the entry and walk up to the
// package root instead; failures degrade to "unknown" rather than crashing sync.
function readOpenccVersion(): string {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.resolve("opencc-js")));
  } catch {
    return "unknown";
  }
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "opencc-js" && typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // no readable package.json at this level; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

export const OPENCC_PACKAGE_VERSION = readOpenccVersion();

const HAN_RE = /\p{Script=Han}/u;

let converter: ConverterFunction | null = null;

function getConverter(): ConverterFunction {
  if (converter === null) {
    converter = Converter({ from: "t", to: "cn" });
  }
  return converter;
}

export function toSimplified(text: string): string {
  if (text.length === 0 || !HAN_RE.test(text)) return text;
  return getConverter()(text);
}
