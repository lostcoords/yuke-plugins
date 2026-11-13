import { readTextFile } from "yuke:fs";
import type { Sessions } from "yuke:plugins";
import { assert, assertEquals, createFrame, createHost, reply, test, waitForSettled } from "yuke:test";
import { apply } from "../src/index.ts";
import { rows, withServices } from "./support.ts";

test("the settings command saves a picked model and regenerate renames the focused session without a reload", async () => {
  using frame = createFrame({ width: 100, height: 24 });
  const tui = frame.surface("titles").tui;
  let shown: string | undefined;
  let sessions: Sessions | undefined;
  let dataDir = "";
  await using host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply(ctx) {
          ctx.provide("chat", {
            session: () => shown,
            show: async () => {},
            addChangeListener: () => () => {},
            addPaneWatcher: () => () => {},
            addCompletionProvider: () => () => {},
            addComposerView: () => () => {},
            setPresentation: () => () => {},
            addReadOnly: () => () => {},
            setComposerFrame: () => () => {},
            setEmptyView: () => () => {},
          });
        },
      },
      {
        name: "titles",
        uses: ["chat"],
        apply(ctx) {
          dataDir = ctx.dataDir;
          sessions = ctx.get("sessions");
          return apply(withServices(ctx, { tui }));
        },
      },
    ],
    replies: [reply.text("The issue is fixed."), reply.text("Fix login refresh")],
  });
  const session = await host.openSession();
  shown = session.id;
  tui.panes.split(() => ({ draw: (canvas) => canvas.text(0, 0, "Main conversation") }));
  await session.sendMessage("Fix login after the access token expires.");
  assert(sessions !== undefined);
  assertEquals((await sessions.get(session.id)).session.title, "Fix login after the access token expires.");
  assertEquals(host.requests.length, 1);

  assertEquals(tui.commands.run("titles:settings"), true);
  await waitForSettled();
  assert(rows(frame).some((row) => row.includes("No title models yet")));
  frame.key("a");
  await waitForSettled();
  frame.paste("anthropic/claude-fable-5");
  frame.key("enter");
  await waitForSettled();
  frame.paste("default");
  frame.key("enter");
  await waitForSettled();
  frame.key("esc");
  assertEquals(JSON.parse(await readTextFile(`${dataDir}/settings.json`)), {
    models: [{ model: "anthropic/claude-fable-5", reasoning: "default" }],
  });

  assertEquals(tui.commands.run("titles:regenerate"), true);
  await waitForSettled();
  assertEquals((await sessions.get(session.id)).session.title, "Fix login refresh");
  assertEquals(host.requests[1]?.messages, [{ role: "user", text: "Fix login after the access token expires." }]);
  assertEquals(host.notices.at(-1)?.text, "Session title: Fix login refresh");
});
