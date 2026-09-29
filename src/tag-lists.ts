import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The last successful answer for each tag lookup, so a sync without network
// can still honour the tags instead of stopping. Keyed by the config knob and
// guarded by the tag name: renaming a tag invalidates its saved list. Search
// reads the exclude list too, to tell an excluded item from an unsynced one.
export type TagKnob = "verticalTextTag" | "excludeTag";
export type SavedTagLists = Partial<Record<TagKnob, { tag: string; itemKeys: string[]; fetchedAt: string }>>;

export function savedTagListsPath(indexDir: string): string {
  return resolve(indexDir, "zotero-tags.json");
}

export function readSavedTagLists(path: string): SavedTagLists {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SavedTagLists) : {};
  } catch {
    return {};
  }
}

/** The item keys saved for `knob`, or undefined when nothing was saved for
 *  the tag currently configured. */
export function savedTagItemKeys(path: string, knob: TagKnob, tag: string | undefined): string[] | undefined {
  if (!tag) return undefined;
  const saved = readSavedTagLists(path)[knob];
  return saved && saved.tag === tag && Array.isArray(saved.itemKeys) ? saved.itemKeys : undefined;
}

export function saveTagList(path: string, knob: TagKnob, tag: string, itemKeys: string[]): void {
  const saved = readSavedTagLists(path);
  saved[knob] = { tag, itemKeys: [...itemKeys].sort(), fetchedAt: new Date().toISOString() };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved, null, 2), "utf-8");
  renameSync(tmp, path);
}
