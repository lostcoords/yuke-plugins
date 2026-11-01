import type { PluginContext } from "yuke:plugins";
import { Picker, strokeOf, TextEditor, type Tui } from "yuke:tui";

import type { History, HistoryEntry } from "./history.ts";
import { panelRect, panelView } from "./style.ts";

export function browseHistory(
  ctx: PluginContext,
  tui: Tui,
  history: History,
  sessionId: string | undefined,
  openEntry: (entry: HistoryEntry) => void,
): void {
  let allSessions = sessionId === undefined;
  let entries: HistoryEntry[] | undefined;
  let loadVersion = 0;

  const picker = new Picker<HistoryEntry>({
    items: [],
    key: (entry) => entry.id,
    label: (entry) => entry.question.replaceAll(/\s+/g, " "),
    detail: (entry) => {
      const model = `${entry.model.provider}/${entry.model.model}`;
      return allSessions ? `${model} · ${entry.sessionId.slice(0, 8)}` : model;
    },
    rank: (query, items) => {
      const search = query.toLowerCase();
      return items
        .filter((entry) => `${entry.question}\n${entry.answer}`.toLowerCase().includes(search))
        .map((entry) => ({ item: entry }));
    },
    choose: (entry) => {
      overlay.close();
      openEntry(entry);
    },
    cancel: () => overlay.close(),
  });

  const overlay = tui.overlay(
    () =>
      panelView({
        initialFocus: picker.input,
        layout: (size) => [
          {
            view: picker,
            rect: {
              column: 1,
              row: 2,
              width: Math.max(0, size.width - 2),
              height: Math.max(0, size.height - 3),
            },
          },
        ],
        draw: (canvas) => {
          const scope = allSessions ? "all sessions" : "this session";
          const hints =
            canvas.width < 60
              ? "Enter open · Esc back"
              : "Enter open · Tab scope · Ctrl+D delete · Ctrl+X clear · Esc back";

          canvas.fill(0, 0, canvas.width, canvas.height, "btw.panel");
          canvas.text(1, 0, `btw history · ${scope}`, "btw.title");

          if (entries === undefined || entries.length === 0) {
            canvas.text(1, 1, entries === undefined ? "Loading…" : "No saved answers", "btw.hint");
          }

          canvas.text(1, canvas.height - 1, hints, "btw.hint");
        },
      }),
    { place: panelRect },
  );

  const load = async (): Promise<void> => {
    const version = ++loadVersion;
    entries = undefined;
    picker.setItems([]);
    tui.requestFrame();

    try {
      const result = await history.list(allSessions ? undefined : sessionId);
      if (overlay.signal.aborted || version !== loadVersion) return;

      entries = result.entries;
      picker.setItems(entries);

      if (result.warnings.length > 0) {
        ctx.notify("warn", `Some history could not be read:\n${result.warnings.join("\n")}`);
      }

      tui.requestFrame();
    } catch (error) {
      if (overlay.signal.aborted || version !== loadVersion) return;

      overlay.close();
      ctx.notify("error", `History could not be read: ${String(error)}`);
    }
  };

  const deleteEntries = async (targets: readonly HistoryEntry[]): Promise<void> => {
    try {
      await Promise.all(targets.map((entry) => history.remove(entry)));
    } catch (error) {
      ctx.notify("error", `History could not be deleted: ${String(error)}`);
    }

    // Reload even after a partial failure, so the picker reflects what is still on disk.
    await load();
  };

  picker.input.extend(overlay.signal).onKey((event) => {
    const key = strokeOf(event);

    if (key === "tab" && sessionId !== undefined) {
      allSessions = !allSessions;
      void load();
      return true;
    }

    if (key !== "ctrl+d" && key !== "ctrl+x") return false;

    let targets = entries ?? [];
    if (key === "ctrl+d") {
      targets = picker.selected === undefined ? [] : [picker.selected];
    }

    if (targets.length === 0) return true;

    const scope = allSessions ? "across sessions" : "from this session";
    confirmDelete(tui, `Delete ${targets.length} saved answer(s) ${scope}?`, () => {
      void deleteEntries(targets);
    });

    return true;
  }, "beforeKeymap");

  void load();
}

function confirmDelete(tui: Tui, title: string, confirm: () => void): void {
  const input = new TextEditor({
    placeholder: "Type DELETE to confirm",
    submit: (draft) => {
      if (draft.text !== "DELETE") return;

      overlay.close();
      confirm();
    },
  });

  const overlay = tui.overlay(
    () =>
      panelView({
        initialFocus: input,
        layout: (size) => [
          { view: input, rect: { column: 1, row: 2, width: Math.max(0, size.width - 2), height: 1 } },
        ],
        draw: (canvas) => {
          canvas.fill(0, 0, canvas.width, canvas.height, "btw.panel");
          canvas.text(1, 0, title, "btw.title");
          canvas.text(1, canvas.height - 1, "Enter confirm · Esc keep", "btw.hint");
        },
      }),
    {
      place: (size) => ({
        column: 0,
        row: Math.max(0, size.height - 5),
        width: size.width,
        height: Math.min(5, size.height),
      }),
    },
  );

  input.extend(overlay.signal).onKey((event) => {
    const key = strokeOf(event);
    if (key !== "esc" && key !== "ctrl+c") return false;

    overlay.close();
    return true;
  }, "beforeKeymap");
}
