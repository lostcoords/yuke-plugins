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
      return JSON.parse(await readTextFile(`${parent}.json`, { folder: this.#folder })) as readonly LoggedRun[];
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") return [];
      throw error;
    }
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
        if (runs.length === 0) {
          await remove(`${this.#folder}/${parent}.json`, { force: true });
          return;
        }
        await mkdir(this.#folder, { recursive: true, mode: 0o700 });
        // An atomic write leaves a reader the old file or the new one, so a kill cannot damage the log.
        await writeTextFile(`${parent}.json`, JSON.stringify(runs), { folder: this.#folder, atomic: true });
      });
    return this.#writes;
  }
}
