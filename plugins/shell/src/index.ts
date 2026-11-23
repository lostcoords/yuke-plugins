/**
 * The plugin `shell`. `!command` in the composer runs a command of the user, shows its output, and saves the command
 * and its output in the session without a model turn. `!sudo command` runs a command as root after a password. The
 * tool `sudo_command` lets the model ask for a root command, which the user approves.
 */

import type { PluginContext, SessionContext } from "yuke:plugins";
import { Command } from "yuke:process";
import { type PlacedWidget, TextEditor, type TextRow, TextView } from "yuke:tui";
import { collect, escapeHidden, literalArguments, OUTPUT_LIMIT, quoted, runAsRoot } from "./sudo.ts";

const SUDO = "sudo";

function rows(text: string): TextRow[] {
  return text.split("\n").map((line) => ({ segments: [{ text: line }], join: "\n" }));
}

/** A text of the model as one short line, so it cannot look like a part of the command. */
function oneLine(text: string): string {
  const line = escapeHidden(text.replace(/[\n\r\t]+/gu, " ").trim());
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function endText(code: number, signal: string | null): string {
  return signal === null ? `Exit ${code}` : `Stopped by ${signal}`;
}

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;
  const chat = ctx.get("chat");
  const sessions = ctx.get("sessions");
  let running = false;

  /** The composer of the active pane. */
  const composer = (): PlacedWidget | undefined =>
    tui.widgets
      .list()
      .find(
        (mount) =>
          mount.widget instanceof TextEditor && mount.widget.role === "composer" && mount.pane === tui.panes.activePane,
      );
  const draft = (): string | undefined => {
    const widget = composer()?.widget;
    return widget instanceof TextEditor ? widget.state.text : undefined;
  };

  const runCommand = async (editor: TextEditor, line: string): Promise<void> => {
    const pane = tui.panes.activePane;
    const id = pane === undefined ? undefined : chat.sessionIdOf(pane.view);
    const folder = id === undefined ? tui.startup.folder : (await sessions.get(id)).folder;
    const sudoLine = /^sudo(?:\s|$)/u.exec(line) === null ? undefined : line.slice(4).trim();
    let argv: string[] | undefined;
    if (sudoLine !== undefined) {
      const parsed = literalArguments(sudoLine);
      if (parsed instanceof Error) throw parsed;
      argv = parsed;
      const approved = await tui.confirm({
        title: "Run as root?",
        text: `${quoted(argv)}\n\nFolder: ${folder}`,
        confirmLabel: "run as root",
        cancelLabel: "cancel",
      });
      if (!approved) return;
    }

    editor.reset({ text: "", spans: [], selection: { anchor: 0, head: 0 } });
    let output = "";
    let status = "Running…";
    let done = false;
    const view = new TextView({ document: { id: "shell", items: [] } });
    const paint = (): void => {
      view.setDocument({
        id: "shell",
        items: [{ id: "output", sections: [{ id: "text", kind: "text", text: output, render: () => rows(output) }] }],
      });
      view.scroll.followTail();
      tui.requestFrame();
    };
    const stop = new AbortController();
    const dialog = tui.dialog({
      title: () => `!${line} · ${status}`,
      body: view,
      scroll: view.scroll,
      rows: Math.max(8, tui.size.height - 2),
      signal: ctx.signal,
      keys: [{ key: "ctrl+c", label: "stop", when: () => !done, run: () => stop.abort() }],
    });
    const signal = AbortSignal.any([stop.signal, dialog.signal]);
    const onText = (text: string): void => {
      output = text;
      paint();
    };
    const result =
      argv === undefined
        ? await collect(new Command("/bin/sh", { args: ["-c", line], cwd: folder, signal }).spawn(), onText)
        : await runAsRoot(
            SUDO,
            argv,
            folder,
            signal,
            (attempt, cancel) =>
              tui.prompt({
                title: attempt === 1 ? "Sudo password" : "Sudo did not accept the password. Try again",
                placeholder: "The password goes only to sudo",
                mask: true,
                signal: cancel,
              }),
            onText,
          );
    done = true;
    status = endText(result.code, result.signal);
    output = result.text;
    paint();
    if (id === undefined) return;
    const handle = await sessions.open(id, { tail: 0, signal: ctx.signal, onEvent: () => {} });
    try {
      await handle.record({
        display: `!${line}\n${status}\n\n${output}`,
        text: `The user ran a command in ${folder}. This is a completed action, not a request.\nCommand: ${line}\n${status}\nOutput (the last ${OUTPUT_LIMIT} characters):\n${output}`,
      });
    } finally {
      handle.close();
    }
  };

  tui.commands.add({
    name: "run",
    description: "Run the draft !command, and save its output in the session",
    enabled: () => {
      const text = draft();
      return !running && text !== undefined && text.startsWith("!") && text.slice(1).trim() !== "";
    },
    run: () => {
      const mount = composer();
      if (mount === undefined || !(mount.widget instanceof TextEditor)) return false;
      const editor = mount.widget;
      running = true;
      void runCommand(editor, editor.state.text.slice(1).trim())
        .catch((error: unknown) => ctx.notify("error", error instanceof Error ? error.message : String(error)))
        .finally(() => {
          running = false;
        });
      return;
    },
  });
  tui.keys.add("enter", "run", { in: "composer" });
  return undefined;
}

export function session(s: SessionContext): undefined {
  s.tools.add({
    name: "sudo_command",
    description:
      "Run one command as root. Give the executable and each argument as literal words, and say why the command needs root. The user approves each command and types the password in a masked field. Never ask for a password in chat. The command gets no stdin.",
    concurrency: "serial",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1 },
        reason: { type: "string" },
      },
      required: ["argv", "reason"],
    },
    execute: async (args, context) => {
      const approval = await s.ask(
        {
          questions: [
            {
              id: "approve",
              header: "Run as root?",
              question: `${quoted(args.argv)}\n\nFolder: ${context.folder}\nThe model reads the output.\n\nReason of the model: ${oneLine(args.reason)}`,
              options: [{ label: "Run as root" }, { label: "Do not run" }],
            },
          ],
        },
        { signal: context.signal },
      );
      if (approval?.[0]?.values[0] !== "Run as root")
        return { text: "The user did not approve. No command ran.", isError: true };
      const result = await runAsRoot(
        SUDO,
        args.argv,
        context.folder,
        context.signal,
        async (attempt, cancel) => {
          const answers = await s.ask(
            {
              questions: [
                {
                  id: "password",
                  header: "Sudo password",
                  question:
                    attempt === 1 ? "The password goes only to sudo." : "Sudo did not accept the password. Try again.",
                  options: [],
                  other: true,
                  secret: true,
                },
              ],
            },
            { signal: cancel },
          );
          return answers?.[0]?.other ?? undefined;
        },
        () => {},
      );
      return {
        text: `${endText(result.code, result.signal)}\n\n${result.text}`,
        isError: result.code !== 0 || result.signal !== null,
      };
    },
  });
  return undefined;
}
