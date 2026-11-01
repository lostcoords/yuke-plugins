import { FileSystemError, mkdir, readDir, readTextFile, remove, writeTextFile } from "yuke:fs";
import type { ModelReference } from "yuke:protocol";

export interface HistoryEntry {
  version: 1;
  id: string;
  sessionId: string;
  createdAt: number;
  model: ModelReference;
  question: string;
  answer: string;
}

const isSafeId = (value: string): boolean => /^[a-zA-Z0-9_-]+$/.test(value);
const isMissing = (error: unknown): boolean => error instanceof FileSystemError && error.code === "ENOENT";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    isSafeId(value.id) &&
    typeof value.sessionId === "string" &&
    isSafeId(value.sessionId) &&
    typeof value.createdAt === "number" &&
    value.createdAt >= 0 &&
    !Number.isNaN(new Date(value.createdAt).getTime()) &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    isObject(value.model) &&
    typeof value.model.provider === "string" &&
    typeof value.model.model === "string"
  );
}

/** Completed text exchanges only. The history never supplies model input. */
export class History {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async save(input: Omit<HistoryEntry, "version" | "id" | "createdAt">): Promise<HistoryEntry> {
    if (!isSafeId(input.sessionId)) throw new Error("Invalid history session ID.");

    const createdAt = Date.now();
    const saved: HistoryEntry = {
      ...input,
      version: 1,
      id: `${createdAt}-${Math.random().toString(36).slice(2)}`,
      createdAt,
    };
    const baseDir = `${this.dataDir}/history/${saved.sessionId}`;

    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    await writeTextFile(`${saved.id}.json`, `${JSON.stringify(saved)}\n`, {
      baseDir,
      atomic: true,
      mode: 0o600,
    });

    return saved;
  }

  async list(sessionId?: string): Promise<{ entries: HistoryEntry[]; warnings: string[] }> {
    if (sessionId !== undefined && !isSafeId(sessionId)) throw new Error("Invalid history session ID.");

    const entries: HistoryEntry[] = [];
    const warnings: string[] = [];
    const root = `${this.dataDir}/history`;
    let sessionIds: string[];

    try {
      sessionIds =
        sessionId === undefined
          ? (await readDir(root))
              .filter((item) => item.isDirectory && isSafeId(item.name))
              .map((item) => item.name)
          : [sessionId];
    } catch (error) {
      if (isMissing(error)) return { entries, warnings };
      throw error;
    }

    for (const currentSessionId of sessionIds) {
      const baseDir = `${root}/${currentSessionId}`;
      let files: Awaited<ReturnType<typeof readDir>>;

      try {
        files = await readDir(baseDir);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      for (const file of files) {
        if (!file.isFile || !/^[a-zA-Z0-9_-]+\.json$/.test(file.name)) continue;

        try {
          const value: unknown = JSON.parse(await readTextFile(file.name, { baseDir, fatal: true }));
          if (
            !isHistoryEntry(value) ||
            value.sessionId !== currentSessionId ||
            `${value.id}.json` !== file.name
          ) {
            throw new Error("Invalid or unsupported history record.");
          }

          entries.push(value);
        } catch (error) {
          if (isMissing(error)) continue;
          warnings.push(
            `${currentSessionId}/${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    entries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return { entries, warnings };
  }

  async remove(saved: HistoryEntry): Promise<void> {
    if (!isSafeId(saved.sessionId) || !isSafeId(saved.id)) throw new Error("Invalid history record ID.");

    await remove(`history/${saved.sessionId}/${saved.id}.json`, { baseDir: this.dataDir, force: true });
  }
}
