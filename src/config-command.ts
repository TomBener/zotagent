import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";

import { getConfigPath } from "./config.js";

export class ConfigCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConfigCommandError";
  }
}

interface FieldSpec {
  key: string;
  required: boolean;
  help: string;
  secret?: boolean;
  choices?: readonly string[];
  boolean?: boolean;
}

const FIELDS: FieldSpec[] = [
  {
    key: "bibliographyJsonPath",
    required: true,
    help: "Path to your Better BibTeX → Better CSL JSON export.",
  },
  {
    key: "attachmentsRoot",
    required: true,
    help: "Root folder of Zotero attachments (linked base dir, or ~/Zotero/storage).",
  },
  {
    key: "dataDir",
    required: true,
    help: "Where zotagent writes its local index, manifests, and normalized markdown.",
  },
  {
    key: "zoteroLibraryId",
    required: false,
    help: "Numeric Zotero userID (personal) or group ID. Used by `add` and `recent`.",
  },
  {
    key: "zoteroLibraryType",
    required: false,
    choices: ["user", "group"],
    help: "`user` for a personal library, `group` for a group library.",
  },
  {
    key: "zoteroApiKey",
    required: false,
    secret: true,
    help: "Zotero Web API key. Read access is enough for `recent`; write access is required by `add`.",
  },
  {
    key: "zoteroCollectionKey",
    required: false,
    help: "Optional default collection key that `add` drops new items into.",
  },
  {
    key: "semanticScholarApiKey",
    required: false,
    secret: true,
    help: "Semantic Scholar API key. Required by `s2` and `add --s2-paper-id`.",
  },
  {
    key: "syncEnabled",
    required: false,
    boolean: true,
    help: "Set to false on read-only hosts so `sync` fails fast instead of touching the index.",
  },
];

type RawConfig = Record<string, unknown>;

function readRawConfig(path: string): RawConfig {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ConfigCommandError(
      "CONFIG_PARSE_ERROR",
      `Existing config at ${path} is not valid JSON: ${(error as Error).message}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigCommandError(
      "CONFIG_PARSE_ERROR",
      `Existing config at ${path} must be a JSON object.`,
    );
  }
  return parsed as RawConfig;
}

function formatDefaultDisplay(value: unknown, field: FieldSpec): string {
  if (value === undefined || value === null || value === "") return "";
  if (field.secret && typeof value === "string") {
    if (value.length <= 4) return "****";
    return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 4))}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

interface MenuOption {
  value: string | boolean;
  label: string;
}

function buildMenuOptions(field: FieldSpec): MenuOption[] | null {
  if (field.boolean) {
    return [
      { value: true, label: "true" },
      { value: false, label: "false" },
    ];
  }
  if (field.choices) {
    return field.choices.map((choice) => ({ value: choice, label: choice }));
  }
  return null;
}

function matchMenuOption(
  options: MenuOption[],
  answer: string,
): MenuOption | undefined {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return undefined;
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }
  return options.find((option) => option.label.toLowerCase() === normalized);
}

interface Colors {
  bold: (text: string) => string;
  dim: (text: string) => string;
  cyan: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  red: (text: string) => string;
}

function makeColors(enabled: boolean): Colors {
  const wrap = (open: string, close: string) =>
    enabled
      ? (text: string): string => `\x1b[${open}m${text}\x1b[${close}m`
      : (text: string): string => text;
  return {
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    cyan: wrap("36", "39"),
    green: wrap("32", "39"),
    yellow: wrap("33", "39"),
    red: wrap("31", "39"),
  };
}

function tagFor(field: FieldSpec): string {
  if (field.required) return "required";
  return field.secret ? "optional · secret" : "optional";
}

export interface ConfigCommandResult {
  path: string;
  updated: string[];
  unchanged: string[];
  cleared: string[];
  written: boolean;
}

export async function runConfigCommand(): Promise<ConfigCommandResult> {
  if (!process.stdin.isTTY) {
    throw new ConfigCommandError(
      "CONFIG_REQUIRES_TTY",
      "`zotagent config` requires an interactive terminal. Edit ~/.zotagent/config.json directly or rerun from a TTY.",
    );
  }

  const path = getConfigPath();
  const existing = readRawConfig(path);
  const next: RawConfig = { ...existing };
  const updated: string[] = [];
  const unchanged: string[] = [];
  const cleared: string[] = [];

  const colors = makeColors(!process.env.NO_COLOR && Boolean(process.stderr.isTTY));
  const { bold, dim, cyan, green, yellow, red } = colors;
  const writeInfo = (text: string): void => {
    process.stderr.write(text);
  };

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    writeInfo(`${bold(cyan("zotagent config"))} ${dim(`· ${path}`)}\n`);
    writeInfo(`${dim("Enter keeps current · `-` clears optional · Ctrl-C aborts")}\n\n`);

    for (const field of FIELDS) {
      const currentValue = existing[field.key];
      const hasExisting = currentValue !== undefined && currentValue !== "";

      writeInfo(`${bold(cyan(field.key))} ${dim(`· ${tagFor(field)}`)}\n`);
      writeInfo(`  ${dim(field.help)}\n`);

      const menuOptions = buildMenuOptions(field);
      if (menuOptions) {
        const defaultOption = menuOptions.find((option) => option.value === currentValue);
        const rendered = menuOptions
          .map((option, index) => {
            const marker = option === defaultOption ? ` ${green("← current")}` : "";
            return `${dim(`${index + 1})`)} ${option.label}${marker}`;
          })
          .join("    ");
        writeInfo(`  ${rendered}\n`);

        while (true) {
          const answer = (await rl.question("  → ")).trim();

          if (answer === "") {
            if (hasExisting) unchanged.push(field.key);
            break;
          }

          if (answer === "-") {
            if (field.required) {
              writeInfo(`  ${red("required; cannot be cleared")}\n`);
              continue;
            }
            if (hasExisting) {
              delete next[field.key];
              cleared.push(field.key);
            }
            break;
          }

          const picked = matchMenuOption(menuOptions, answer);
          if (!picked) {
            writeInfo(
              `  ${red(`pick 1-${menuOptions.length} or ${menuOptions.map((opt) => opt.label).join("/")}`)}\n`,
            );
            continue;
          }

          if (currentValue === picked.value) {
            unchanged.push(field.key);
          } else {
            next[field.key] = picked.value;
            updated.push(field.key);
          }
          break;
        }
        writeInfo("\n");
        continue;
      }

      if (hasExisting) {
        writeInfo(`  ${dim("current:")} ${green(formatDefaultDisplay(currentValue, field))}\n`);
      }

      while (true) {
        const answer = (await rl.question("  → ")).trim();

        if (answer === "") {
          if (hasExisting) unchanged.push(field.key);
          break;
        }

        if (answer === "-") {
          if (field.required) {
            writeInfo(`  ${red("required; cannot be cleared")}\n`);
            continue;
          }
          if (hasExisting) {
            delete next[field.key];
            cleared.push(field.key);
          }
          break;
        }

        if (currentValue === answer) {
          unchanged.push(field.key);
        } else {
          next[field.key] = answer;
          updated.push(field.key);
        }
        break;
      }
      writeInfo("\n");
    }
  } finally {
    rl.close();
  }

  const shouldWrite = updated.length > 0 || cleared.length > 0 || !existsSync(path);
  if (!shouldWrite) {
    writeInfo(`${dim(`· no changes to ${path}`)}\n`);
    return { path, updated, unchanged, cleared, written: false };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");

  const summary = [
    updated.length > 0 ? `${updated.length} updated` : null,
    cleared.length > 0 ? `${cleared.length} cleared` : null,
    unchanged.length > 0 ? `${unchanged.length} kept` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  writeInfo(`${green("✓")} wrote ${path} ${dim(`(${summary || "new file"})`)}\n`);

  return { path, updated, unchanged, cleared, written: true };
}
