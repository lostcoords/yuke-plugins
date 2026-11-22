import { type DirEntry, FileSystemError, mkdir, readDir, readTextFile, remove, writeTextFile } from "yuke:fs";
import type { ModelReference } from "yuke:protocol";

export interface HistoryEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  model: ModelReference;
  question: string;
  answer: string;
}

/** The files of a folder, or none when the folder does not exist yet. */
async function readFolder(folder: string): Promise<DirEntry[]> {
  try {
    return await Array.fromAsync(readDir(folder));
  } catch (error) {
    if (error instanceof FileSystemError && error.code === "ENOENT") return [];
    throw error;
  }
}

/** A record on disk can be damaged by hand or by a crash, so check the fields that the UI reads. */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  const entry = value as Partial<HistoryEntry> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.sessionId === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.question === "string" &&
    typeof entry.answer === "string" &&
    typeof entry.model?.provider === "string" &&
    typeof entry.model.model === "string"
  );
}

/** Completed text exchanges only. The history never supplies model input. */
export class History {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async save(input: Omit<HistoryEntry, "id" | "createdAt">): Promise<HistoryEntry> {
    const createdAt = Date.now();
    const saved: HistoryEntry = { ...input, id: `${createdAt}-${Math.random().toString(36).slice(2)}`, createdAt };
    const baseDir = `${this.dataDir}/history/${saved.sessionId}`;

    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    await writeTextFile(`${saved.id}.json`, `${JSON.stringify(saved)}\n`, {
      folder: baseDir,
      atomic: true,
      mode: 0o600,
    });

    return saved;
  }

  async list(sessionId?: string): Promise<{ entries: HistoryEntry[]; warnings: string[] }> {
    const entries: HistoryEntry[] = [];
    const warnings: string[] = [];
    const root = `${this.dataDir}/history`;
    const sessionIds =
      sessionId === undefined
        ? (await readFolder(root)).filter((item) => item.isDirectory).map((item) => item.name)
        : [sessionId];

    for (const currentSessionId of sessionIds) {
      const baseDir = `${root}/${currentSessionId}`;

      for (const file of await readFolder(baseDir)) {
        if (!file.name.endsWith(".json")) continue;

        try {
          const value: unknown = JSON.parse(await readTextFile(file.name, { folder: baseDir, fatal: true }));
          if (!isHistoryEntry(value)) throw new Error("Not a history record.");

          entries.push(value);
        } catch (error) {
          warnings.push(`${currentSessionId}/${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    entries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return { entries, warnings };
  }

  async remove(saved: HistoryEntry): Promise<void> {
    await remove(`history/${saved.sessionId}/${saved.id}.json`, { folder: this.dataDir, force: true });
  }
}
