import type { ChatService } from "yuke:chat";
import { mkdir } from "yuke:fs";
import {
  assert,
  assertEquals,
  createFrame,
  createHost,
  type FrameTest,
  folder,
  type Host,
  type Reply,
  type TestSession,
  test,
  waitForSettled,
} from "yuke:test";

/** What a test of the panel gets: the real chat on a frame, the plugin `btw` from its folder, and one shown session. */
export interface Scenario {
  frame: FrameTest;
  host: Host;
  session: TestSession;
  /** The data folder of the plugin `btw`. */
  dataDir: string;
}

export interface ScenarioOptions {
  width: number;
  height: number;
  replies?: readonly Reply[];
}

/** Register a test that runs `body` with a fresh session in the real chat. */
export function scenario(name: string, options: ScenarioOptions, body: (scenario: Scenario) => Promise<void>): void {
  test(name, async () => {
    let chat: ChatService | undefined;
    const dataDir = `${folder()}/btw`;
    await mkdir(dataDir);
    using frame = createFrame({ width: options.width, height: options.height }, undefined, { folder: "/w" });
    await using host = await createHost({
      frame,
      plugins: [
        { bundled: "chat" },
        {
          name: "probe",
          uses: ["chat"],
          apply: (ctx) => {
            chat = ctx.get("chat");
            return undefined;
          },
        },
        { folder: `${import.meta.dirname}/..`, dataDir },
      ],
      replies: options.replies,
    });
    assert(chat !== undefined);
    const session = await host.openSession();
    frame.start();
    await chat.show(session.id);
    await waitForSettled();
    await body({ frame, host, session, dataDir });
  });
}

/** Let the host work, then check that the frame shows `text`. */
export async function waitForScreen(frame: FrameTest, text: string): Promise<void> {
  await waitForSettled();
  const shown = frame.rows().join("\n");
  assert(shown.includes(text), shown);
}

/** Let the host work, then check that the fake model got `count` requests. */
export async function waitForRequests(host: Host, count: number): Promise<void> {
  await waitForSettled();
  assertEquals(host.requests.length, count);
}

/** A frame of the spinner of the panel. */
export const SPINNER_FRAME = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
