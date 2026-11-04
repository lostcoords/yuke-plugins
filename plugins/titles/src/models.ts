import { FileSystemError, readTextFile, writeTextFile } from "yuke:fs";
import type { Catalog } from "yuke:plugins";
import type { ModelReference, ProviderInfo, ReasoningChoice } from "yuke:protocol";

/** A model and its reasoning level. */
export interface ModelEntry {
  readonly model: string;
  readonly reasoning: string;
}

/** The models that title requests use, in primary and fallback order. */
export interface SavedModels {
  readonly models: readonly ModelEntry[];
}

/** Return the id that identifies a model and its reasoning level. */
export function modelId(entry: ModelEntry): string {
  return `${entry.model}:${entry.reasoning}`;
}

/** Resolve a saved model against the available providers. */
export function resolveModel(
  entry: ModelEntry,
  providers: readonly ProviderInfo[],
): { readonly model: ModelReference; readonly reasoning: ReasoningChoice["settings"] } | undefined {
  for (const provider of providers) {
    for (const model of provider.models) {
      if (`${provider.id}/${model.id}` !== entry.model) continue;

      const choice = model.reasoning.find((candidate) => candidate.level === entry.reasoning);
      if (choice !== undefined) {
        return {
          model: { provider: provider.id, model: model.id },
          reasoning: choice.settings,
        };
      }
    }
  }

  return undefined;
}

/** Read and write the title model settings in `folder`. */
export class ModelList {
  readonly #folder: string;
  readonly #catalog: Catalog;

  constructor(folder: string, catalog: Catalog) {
    this.#folder = folder;
    this.#catalog = catalog;
  }

  /** Read the saved models. Missing or empty settings mean no models. */
  async read(): Promise<SavedModels> {
    let text: string;

    try {
      text = await readTextFile("settings.json", { baseDir: this.#folder, fatal: true });
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") return { models: [] };
      throw error;
    }

    if (text.trim() === "") return { models: [] };

    return parseSaved(text, `${this.#folder}/settings.json`);
  }

  /** Write the saved models to the settings directory. */
  async write(saved: SavedModels): Promise<void> {
    await writeTextFile("settings.json", `${JSON.stringify(saved, null, 2)}\n`, { baseDir: this.#folder });
  }

  /** Return the providers that are ready for use. */
  async providers(): Promise<readonly ProviderInfo[]> {
    return (await this.#catalog.list()).providers;
  }
}

function parseSaved(text: string, file: string): SavedModels {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${String(error)}`);
  }

  if (!isRecord(value)) {
    throw new Error(`${file} needs { "models": [{ "model": string, "reasoning": string }] }`);
  }

  if (value.models === undefined) return { models: [] };

  if (!Array.isArray(value.models) || !value.models.every(isModelEntry)) {
    throw new Error(`${file} needs { "models": [{ "model": string, "reasoning": string }] }`);
  }

  return { models: value.models };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelEntry(value: unknown): value is ModelEntry {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    value.model.trim() !== "" &&
    typeof value.reasoning === "string" &&
    value.reasoning.trim() !== ""
  );
}
