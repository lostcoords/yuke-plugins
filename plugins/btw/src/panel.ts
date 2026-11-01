import type { PluginContext, SideRequestResult } from "yuke:plugins";
import { Markdown, strokeOf, TextEditor, type TextRow, TextView, type Tui, type View, wrap } from "yuke:tui";

import type { History, HistoryEntry } from "./history.ts";
import { browseHistory } from "./history-ui.ts";
import { ask, cachedModel, NO_ROUND } from "./requests.ts";
import { panelRect, panelView } from "./style.ts";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

type Answer = { kind: "ready" } | { kind: "running"; started: number } | { kind: "done"; text: string };

/** The modal only takes terminal input. The main turn keeps running underneath it. */
export function openPanel(
  ctx: PluginContext,
  tui: Tui,
  history: History,
  sessionId: string | undefined,
  initial: string | HistoryEntry = "",
): void {
  let answer: Answer = { kind: "ready" };
  let revision = 0;
  let inputRect = { column: 2, row: 0, width: 0, height: 1 };

  const output = new TextView({ document: { key: "btw", items: [] } });

  const showExchange = (question: string, text = ""): void => {
    const markdown = new Markdown(text);
    const heading = question === "" ? "/btw" : `/btw ${question}`;

    output.setDocument({
      key: "btw",
      items: [
        {
          key: String(++revision),
          sections: [
            { key: "question", kind: "text", text: heading, render: (width) => questionRows(heading, width) },
            { key: "gap", kind: "text", text: "", render: () => [{ segments: [], join: "\n" }] },
            {
              key: "answer",
              kind: "text",
              text,
              render: (width) =>
                markdown.rows(Math.max(1, width - 2)).map((row) => ({
                  ...row,
                  segments: [{ text: "  ", copy: false }, ...row.segments],
                })),
            },
          ],
        },
      ],
    });

    output.scroll.scrollTo(0);
    tui.requestFrame();
  };

  const showSaved = (entry: HistoryEntry): void => {
    answer = { kind: "done", text: entry.answer };
    showExchange(entry.question, entry.answer);
  };

  const sendQuestion = async (question: string): Promise<void> => {
    if (question === "" || answer.kind === "running") return;

    const model = cachedModel(sessionId);
    if (sessionId === undefined || model === undefined) {
      ctx.notify("info", NO_ROUND);
      return;
    }

    answer = { kind: "running", started: tui.now() };
    editor.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } });
    showExchange(question);

    let result: SideRequestResult;
    try {
      result = await ask(sessionId, question, overlay.signal);
    } catch (error) {
      if (overlay.signal.aborted) return;

      answer = { kind: "done", text: "" };
      showExchange(
        question,
        `Side request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (overlay.signal.aborted) return;

    const text = result.text.trim() || "The model returned no text. No tool was executed.";
    const displayText =
      result.finishReason === "stop"
        ? text
        : `${text}\n\n[Response ended: ${result.finishReason}. No tool was executed.]`;

    try {
      await history.save({ sessionId, model, question, answer: displayText });
    } catch (error) {
      if (!ctx.signal.aborted) ctx.notify("error", `The side answer was not saved: ${String(error)}`);
    }

    if (overlay.signal.aborted) return;

    answer = { kind: "done", text: displayText };
    showExchange(question, displayText);
  };

  const editor = new TextEditor({
    // Leave the native block cursor a blank cell without adding anything to the draft.
    placeholder: " Ask a side question…",
    appearance: { prompt: "› ", promptStyle: { dim: true } },
    multiline: true,
    submit: (draft) => {
      void sendQuestion(draft.text.trim());
    },
  });

  const view: View = {
    initialFocus: editor,

    layout: (size) => {
      const width = Math.max(0, size.width - 4);
      const height = Math.min(3, Math.max(0, size.height - 3), Math.max(1, editor.heightFor(width)));
      inputRect = { column: 2, row: Math.max(2, size.height - height - 1), width, height };

      return [
        {
          view: output,
          rect: {
            column: 1,
            row: 2,
            width: Math.max(0, size.width - 2),
            height: Math.max(0, inputRect.row - 4),
          },
        },
        { view: editor, rect: inputRect },
      ];
    },

    draw: (canvas) => {
      canvas.fill(0, 0, canvas.width, canvas.height, "btw.panel");
      canvas.text(0, 0, "─".repeat(canvas.width), "btw.hint");
      canvas.text(1, inputRect.row - 1, "─".repeat(Math.max(0, canvas.width - 2)), "btw.hint");

      if (answer.kind === "running") {
        const elapsed = tui.now() - answer.started;
        const status = `${SPINNER[Math.floor(elapsed / 80) % SPINNER.length]} Working… ${Math.floor(elapsed / 1000)}s`;
        canvas.text(1, inputRect.row - 2, status, "btw.working");
        tui.requestFrame(80);
      }

      let hints = answer.kind === "running" ? "Esc cancel" : "Enter send · Esc close";
      if (answer.kind !== "running" && hints.length + " · Ctrl+R history".length <= canvas.width - 2) {
        hints += " · Ctrl+R history";
      }

      canvas.text(1, canvas.height - 1, hints, "btw.hint");
    },
  };

  showExchange("");
  const overlay = tui.overlay(() => panelView(view), { place: panelRect });

  for (const widget of [editor, output]) {
    widget.extend(overlay.signal).onKey((event) => {
      const key = strokeOf(event);

      switch (key) {
        case "esc":
        case "ctrl+c":
          overlay.close();
          break;

        case "tab":
        case "shift+tab":
          tui.focus(tui.focused === editor ? output : editor);
          break;

        case "ctrl+r":
          if (answer.kind !== "running") browseHistory(ctx, tui, history, sessionId, showSaved);
          break;

        case "ctrl+y":
          if (answer.kind === "done" && answer.text !== "") tui.copy(answer.text);
          break;

        case "page_up":
        case "page_down": {
          const direction = key === "page_up" ? -1 : 1;
          output.scroll.scrollBy(direction * Math.max(1, output.scroll.state.height - 1));
          break;
        }

        case "up":
        case "down":
          if (widget !== output) return false;
          output.scroll.scrollBy(key === "up" ? -1 : 1);
          break;

        default:
          return false;
      }

      tui.requestFrame();
      return true;
    }, "beforeKeymap");
  }

  const restoreLatest = async (): Promise<void> => {
    if (sessionId === undefined) return;

    try {
      const result = await history.list(sessionId);
      if (overlay.signal.aborted || answer.kind !== "ready") return;

      if (result.warnings.length > 0) ctx.notify("warn", result.warnings.join("\n"));
      const latest = result.entries[0];
      if (latest !== undefined) showSaved(latest);
    } catch (error) {
      if (!overlay.signal.aborted) ctx.notify("error", `History could not be read: ${String(error)}`);
    }
  };

  if (typeof initial !== "string") showSaved(initial);
  else if (initial !== "") void sendQuestion(initial);
  else void restoreLatest();
}

/** Wrap the heading with source mappings intact, accenting only the command, not the question. */
function questionRows(text: string, width: number): TextRow[] {
  const breaks = wrap(text, Math.max(1, width));
  const rows: TextRow[] = [];

  for (let i = 0; i < breaks.length; i += 3) {
    const from = breaks[i] as number;
    const to = breaks[i + 1] as number;
    const split = Math.max(from, Math.min(to, "/btw".length));

    rows.push({
      segments: [
        { text: text.slice(from, split), style: "btw.title", source: { kind: "text", from, to: split } },
        { text: text.slice(split, to), style: "btw.question", source: { kind: "text", from: split, to } },
      ],
      join: breaks[i + 2] === 1 ? "" : "\n",
    });
  }

  return rows;
}
