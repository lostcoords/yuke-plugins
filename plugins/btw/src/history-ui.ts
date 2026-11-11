import type { PluginContext } from "yuke:plugins";
import { Picker, TextEditor, type Tui } from "yuke:tui";

import type { History, HistoryEntry } from "./history.ts";

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
    id: (entry) => entry.id,
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
    onChoose: (entry) => {
      dialog.close();
      openEntry(entry);
    },
    onCancel: () => dialog.close(),
  });

  const dialog = tui.dialog({
    title: () => {
      const scope = allSessions ? "all sessions" : "this session";
      const status = entries === undefined ? "Loading… · " : entries.length === 0 ? "No saved answers · " : "";
      return `btw history · ${status}${scope}`;
    },
    body: picker,
    keys: [
      { key: "enter", label: "open", when: () => picker.selected !== undefined, run: () => picker.choose() },
      {
        key: "tab",
        label: "scope",
        when: () => sessionId !== undefined,
        run: () => {
          allSessions = !allSessions;
          void load();
        },
      },
      {
        key: "ctrl+d",
        label: "delete",
        when: () => picker.selected !== undefined,
        run: () => {
          if (picker.selected !== undefined) remove([picker.selected]);
        },
      },
      {
        key: "ctrl+x",
        label: "clear",
        when: () => entries !== undefined && entries.length > 0,
        run: () => remove(entries ?? []),
      },
      { key: "ctrl+c", label: "close", run: () => dialog.close() },
    ],
  });

  const load = async (): Promise<void> => {
    const version = ++loadVersion;
    entries = undefined;
    picker.setItems([]);
    tui.requestFrame();

    try {
      const result = await history.list(allSessions ? undefined : sessionId);
      if (dialog.signal.aborted || version !== loadVersion) return;

      entries = result.entries;
      picker.setItems(entries);

      if (result.warnings.length > 0) {
        ctx.notify("warn", `Some history could not be read:\n${result.warnings.join("\n")}`);
      }

      tui.requestFrame();
    } catch (error) {
      if (dialog.signal.aborted || version !== loadVersion) return;

      dialog.close();
      ctx.notify("error", `History could not be read: ${String(error)}`);
    }
  };

  const remove = (targets: readonly HistoryEntry[]): void => {
    if (targets.length === 0) return;
    const scope = allSessions ? "across sessions" : "from this session";
    confirmDelete(tui, `Delete ${targets.length} saved answer(s) ${scope}?`, dialog.signal, () => {
      void deleteEntries(targets);
    });
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

  void load();
}

function confirmDelete(tui: Tui, title: string, signal: AbortSignal, confirm: () => void): void {
  const input = new TextEditor({ multiline: false, placeholder: "Type DELETE to confirm" });
  const dialog = tui.dialog({
    title: () => title,
    body: input,
    rows: 3,
    signal,
    keys: [
      {
        key: "enter",
        label: "confirm",
        when: () => input.state.text === "DELETE",
        run: () => {
          dialog.close();
          confirm();
        },
      },
      { key: "ctrl+c", label: "keep", run: () => dialog.close() },
    ],
  });
}
