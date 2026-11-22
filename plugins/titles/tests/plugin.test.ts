import type { ChatService } from "yuke:chat";
import { readTextFile } from "yuke:fs";
import type { Sessions } from "yuke:plugins";
import { assert, assertEquals, createFrame, createHost, folder, reply, test, waitForSettled } from "yuke:test";

test("the settings command saves a picked model and regenerate renames the focused session without a reload", async () => {
  using frame = createFrame({ width: 100, height: 24 });
  const tui = frame.surface("test").tui;
  const dataDir = `${folder()}/titles`;
  let chat: ChatService | undefined;
  let sessions: Sessions | undefined;
  await using host = await createHost({
    frame,
    plugins: [
      { bundled: "chat" },
      { folder: `${import.meta.dirname}/..`, dataDir },
      {
        name: "probe",
        uses: ["chat"],
        apply(ctx) {
          chat = ctx.get("chat");
          sessions = ctx.get("sessions");
        },
      },
    ],
    replies: [reply.text("The issue is fixed."), reply.text("Fix login refresh")],
  });
  const session = await host.openSession();
  frame.start();
  await chat?.show(session.id);
  await session.sendMessage("Fix login after the access token expires.");
  assert(sessions !== undefined);
  assertEquals((await sessions.get(session.id)).title, "Fix login after the access token expires.");
  assertEquals(host.requests.length, 1);

  assertEquals(tui.commands.run("titles:settings"), true);
  await waitForSettled();
  assert(frame.rows().some((row) => row.includes("No title models yet")));
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
  assertEquals((await sessions.get(session.id)).title, "Fix login refresh");
  assertEquals(host.requests[1]?.messages, [{ role: "user", text: "Fix login after the access token expires." }]);
  assertEquals(host.notices.at(-1)?.text, "Session title: Fix login refresh");
});
