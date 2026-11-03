import { fit, measure } from "yuke:tui";

/** A running subagent in the list under the composer. */
export interface ListEntry {
  readonly label: string;
  readonly model: string;
  /** The clock of `tui.now` at its start. */
  readonly started: number;
}

/** The count of subagents that the list shows. A longer list ends with a row that counts the others. */
export const SHOWN = 4;

/** The cells between the description, the model, and the time. */
const GAP = "  ";

/** The time since `started`, such as `8s`, `1m 12s`, or `2h 05m`. */
function elapsed(started: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `text` in at most `cells` cells. A longer text ends with `…`. */
function clip(text: string, cells: number): string {
  if (measure(text) <= cells) return text;
  return `${text.slice(0, fit(text, Math.max(0, cells - 1)))}…`;
}

/**
 * The text of each row at `width` cells: the description, the model, and the time. When the room runs out, the model of
 * all rows goes first, so the columns stay in place. The description gets cut before the time.
 */
export function listRows(entries: readonly ListEntry[], width: number, now: number): string[] {
  const shown = entries.slice(0, SHOWN);
  const times = shown.map((entry) => elapsed(entry.started, now));
  const timeCells = Math.max(0, ...times.map(measure));
  const modelCells = Math.max(0, ...shown.map((entry) => measure(entry.model)));
  const labelCells = Math.max(0, ...shown.map((entry) => measure(entry.label)));
  const withModel = labelCells + GAP.length + modelCells + GAP.length + timeCells <= width;
  const rows = shown.map((entry, index) => {
    const time = (times[index] as string).padStart(timeCells);
    const end = withModel ? `${entry.model.padEnd(modelCells)}${GAP}${time}` : time;
    const label = clip(entry.label, Math.max(1, width - measure(end) - GAP.length));
    return `${label}${" ".repeat(Math.max(1, width - measure(label) - measure(end)))}${end}`;
  });
  return entries.length > SHOWN ? [...rows, `+ ${entries.length - SHOWN} more`] : rows;
}
