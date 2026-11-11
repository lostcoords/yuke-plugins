import { readTextFile } from "yuke:fs";
import type { ServiceOf, Services, Sessions } from "yuke:plugins";
import { assert, createFrame, createHost, equal, reply, waitForSettled, test } from "yuke:test";
import { apply } from "../src/index.ts";

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
            onChange: () => () => {},
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
          return apply({
            ...ctx,
            get: <K extends keyof Services & string>(name: K): ServiceOf<K> =>
              name === "tui" ? (tui as ServiceOf<K>) : ctx.get(name),
          });
        },
      },
    ],
    replies: [reply.text("The issue is fixed."), reply.text("Fix login refresh")],
  });
  const session = await host.openSession();
  shown = session.id;
  tui.panes.split(() => ({ draw: (canvas) => canvas.text(0, 0, "Main conversation") }));
  await session.send("Fix login after the access token expires.");
  assert(sessions !== undefined);
  equal((await sessions.get(session.id)).session.title, "Fix login after the access token expires.");
  equal(host.requests.length, 1);

  equal(tui.commands.run("titles:settings"), true);
  await waitForSettled();
  frame.draw();
  equal(
    frame.frame.cells.some((row) =>
      row
        .map((cell) => cell.text)
        .join("")
        .includes("No title models yet"),
    ),
    true,
  );
  frame.key("a");
  await waitForSettled();
  frame.paste("anthropic/claude-fable-5");
  frame.key("enter");
  await waitForSettled();
  frame.paste("default");
  frame.key("enter");
  await waitForSettled();
  frame.key("esc");
  equal(JSON.parse(await readTextFile(`${dataDir}/settings.json`)), {
    models: [{ model: "anthropic/claude-fable-5", reasoning: "default" }],
  });

  equal(tui.commands.run("titles:regenerate"), true);
  for (let attempt = 0; (await sessions.get(session.id)).session.title !== "Fix login refresh"; attempt++) {
    if (attempt === 200) throw new Error("The regenerated title did not arrive.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  equal((await sessions.get(session.id)).session.title, "Fix login refresh");
  equal(host.requests[1]?.messages, [{ role: "user", text: "Fix login after the access token expires." }]);
  equal(host.notices.at(-1)?.message, "Session title: Fix login refresh");
});
