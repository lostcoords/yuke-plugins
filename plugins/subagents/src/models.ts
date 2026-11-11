import { FileSystemError, mkdir, readTextFile, writeTextFile } from "yuke:fs";
import type { Catalog } from "yuke:plugins";
import type { ModelReference, ProviderInfo, ReasoningChoice } from "yuke:protocol";

/** A model in the list of the user: `provider/model`, and a reasoning level of that model. */
export interface ModelEntry {
  readonly model: string;
  readonly reasoning: string;
}

/** The saved choice of the user. */
export interface SavedModels {
  /** The id of the model of each subagent without a `model` argument. Without it, a subagent uses the session model. */
  readonly default?: string | undefined;
  readonly models: readonly ModelEntry[];
}

/** A model of the catalog, with the settings of one reasoning level. */
export interface ResolvedModel {
  readonly model: ModelReference;
  readonly reasoning: ReasoningChoice["settings"];
}

/** The id of `entry` in the `model` argument and in `default`, such as `anthropic/claude-opus-5-5:high`. */
export function modelId(entry: ModelEntry): string {
  return `${entry.model}:${entry.reasoning}`;
}

/** The model of `entry` in the providers that are ready, or `undefined`. */
export function resolveModel(entry: ModelEntry, providers: readonly ProviderInfo[]): ResolvedModel | undefined {
  for (const provider of providers) {
    for (const model of provider.models) {
      if (`${provider.id}/${model.id}` !== entry.model) continue;
      const choice = model.reasoning.find((candidate) => candidate.level === entry.reasoning);
      if (choice !== undefined)
        return { model: { provider: provider.id, model: model.id }, reasoning: choice.settings };
    }
  }
  return undefined;
}

/** The saved list in `folder`, and the ready providers of `catalog`. */
export class ModelList {
  readonly #folder: string;
  readonly #catalog: Catalog;

  constructor(folder: string, catalog: Catalog) {
    this.#folder = folder;
    this.#catalog = catalog;
  }

  /** The saved choice. A missing file is an empty list. A file that a person broke throws, and it names the file. */
  async read(): Promise<SavedModels> {
    let text: string;
    try {
      text = await readTextFile("settings.json", { cwd: this.#folder, fatal: true });
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") return { models: [] };
      throw error;
    }
    return parseSaved(text, `${this.#folder}/settings.json`);
  }

  async write(saved: SavedModels): Promise<void> {
    await mkdir(this.#folder, { recursive: true, mode: 0o700 });
    await writeTextFile("settings.json", `${JSON.stringify(saved, null, 2)}\n`, { cwd: this.#folder });
  }

  /** The providers that are ready. */
  async providers(): Promise<readonly ProviderInfo[]> {
    return (await this.#catalog.list()).providers;
  }
}

/** The saved choice in `text`, which a person can edit, from the file `file`. */
function parseSaved(text: string, file: string): SavedModels {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${String(error)}`);
  }
  const fields = value as { readonly default?: unknown; readonly models?: unknown } | null;
  const models = fields?.models;
  const good =
    typeof fields === "object" &&
    fields !== null &&
    (fields.default === undefined || typeof fields.default === "string") &&
    Array.isArray(models) &&
    models.every((entry: ModelEntry | null) => typeof entry?.model === "string" && typeof entry.reasoning === "string");
  if (!good)
    throw new Error(`${file} needs { "default"?: string, "models": [{ "model": string, "reasoning": string }] }`);
  return value as SavedModels;
}
