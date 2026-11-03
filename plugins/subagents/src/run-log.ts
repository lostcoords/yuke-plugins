import { FileSystemError, mkdir, readTextFile, remove, writeTextFile } from "yuke:fs";
import type { SessionId } from "yuke:protocol";

/** A subagent with a running job. */
export interface LoggedRun {
  readonly id: SessionId;
  readonly label: string;
}

/**
 * The running subagents of each parent session, in files, so that a new process can see the runs that an old process
 * left. A crash, a quit, and a reload all leave their runs here.
 */
export class RunLog {
  readonly #folder: string;
  // The writes run in order, so a quick start and end keep each other.
  #writes: Promise<void> = Promise.resolve();

  constructor(folder: string) {
    this.#folder = `${folder}/running`;
  }

  /** The runs of `parent` in the file. A missing file has none. */
  async read(parent: SessionId): Promise<readonly LoggedRun[]> {
    try {
      const runs: unknown = JSON.parse(await readTextFile(`${parent}.json`, { baseDir: this.#folder, fatal: true }));
      if (!Array.isArray(runs)) throw new Error("the log of running subagents is not a list");
      return runs as readonly LoggedRun[];
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") return [];
      throw error;
    }
  }

  /** Delete the log of `parent`. */
  async clear(parent: SessionId): Promise<void> {
    await remove(`${this.#folder}/${parent}.json`).catch(ignoreMissing);
  }

  async add(parent: SessionId, run: LoggedRun): Promise<void> {
    await this.#change(parent, (runs) => [...runs, run]);
  }

  async remove(parent: SessionId, ids: readonly SessionId[]): Promise<void> {
    await this.#change(parent, (runs) => runs.filter((run) => !ids.includes(run.id)));
  }

  #change(parent: SessionId, change: (runs: readonly LoggedRun[]) => readonly LoggedRun[]): Promise<void> {
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(async () => {
        const runs = change(await this.read(parent));
        await mkdir(this.#folder, { recursive: true, mode: 0o700 });
        if (runs.length === 0) await remove(`${this.#folder}/${parent}.json`).catch(ignoreMissing);
        else await writeTextFile(`${parent}.json`, JSON.stringify(runs), { baseDir: this.#folder });
      });
    return this.#writes;
  }
}

function ignoreMissing(error: unknown): void {
  if (!(error instanceof FileSystemError && error.code === "ENOENT")) throw error;
}
