import type { CompletionProvider } from "yuke:chat";
import { mkdir, writeTextFile } from "yuke:fs";
import { assert, assertEquals, createHost, folder, test } from "yuke:test";
import { apply, session } from "../src/index.ts";

// The names are unusual, so a skill of the same name in the home folder of the tester does not hide them.
const DEPLOY = "zz-skills-test-deploy";
const REVIEW = "zz-skills-test-review";

async function writeSkill(root: string, folderName: string, text: string): Promise<string> {
  await mkdir(`${root}/${folderName}`, { recursive: true });
  await writeTextFile(`${root}/${folderName}/SKILL.md`, text);
  return `${root}/${folderName}/SKILL.md`;
}

async function hostWithSkills() {
  const root = `${folder()}/.agents/skills`;
  const deploy = await writeSkill(
    root,
    DEPLOY,
    `---\nname: ${DEPLOY}\ndescription: >\n  Ship the app\n  to production.\n---\n\nRun the deploy script.\n`,
  );
  await writeSkill(root, "review-folder", `---\nname: "${REVIEW}"\ndescription: Review a diff.\n---\nRead the diff.`);
  await writeSkill(root, "zz-skills-test-plain", "No front matter.");
  await writeSkill(root, "zz-skills-test-bare", "---\nname: zz-skills-test-bare\n---\nNo description.");
  let provider: CompletionProvider | undefined;
  const host = await createHost({
    plugins: [
      {
        name: "chat",
        provides: ["chat"],
        apply(ctx) {
          ctx.provide("chat", {
            addCompletionProvider: (next: CompletionProvider) => {
              provider = next;
              return () => {};
            },
          } as never);
        },
      },
      { name: "skills", uses: ["chat"], apply, session },
    ],
  });
  assert(provider !== undefined);
  return { host, provider, deploy };
}

test("a $name mention gives the model the SKILL.md body of that skill after the message", async () => {
  const fixture = await hostWithSkills();
  await using host = fixture.host;
  const session = await host.openSession();
  const message = { kind: "userText" as const, text: `$${DEPLOY} ship it, then $${REVIEW}` };
  const result = await session.runHook("input.before", {
    source: { kind: "user" },
    kind: "message",
    blocks: [message],
  });
  assertEquals(result, {
    replace: {
      blocks: [
        message,
        {
          kind: "userText",
          text: `<skill name="${DEPLOY}" location="${fixture.deploy}">\nRun the deploy script.\n</skill>`,
        },
        {
          kind: "userText",
          text: `<skill name="${REVIEW}" location="${folder()}/.agents/skills/review-folder/SKILL.md">\nRead the diff.\n</skill>`,
        },
      ],
    },
  });
});

test("a mention in a code span, an escaped or unknown name, a skill without a description, and plugin input stay as sent", async () => {
  const fixture = await hostWithSkills();
  await using host = fixture.host;
  const session = await host.openSession();
  for (const text of [
    `\`$${DEPLOY}\``,
    `\\$${DEPLOY}`,
    `price$${DEPLOY}`,
    "$zz-skills-test-missing",
    "$zz-skills-test-plain $zz-skills-test-bare",
  ]) {
    const result = await session.runHook("input.before", {
      source: { kind: "user" },
      kind: "message",
      blocks: [{ kind: "userText", text }],
    });
    assertEquals(result, "keep", text);
  }
  const fromPlugin = await session.runHook("input.before", {
    source: { kind: "plugin", name: "other" },
    kind: "notification",
    blocks: [{ kind: "userText", text: `$${DEPLOY}` }],
  });
  assertEquals(fromPlugin, "keep");
});

test("$ completes the names of the skills with their descriptions, and not in a code span", async () => {
  // The end of the test closes the host.
  const fixture = await hostWithSkills();
  const complete = (text: string, caret = text.length) =>
    fixture.provider.complete({ text, caret, folder: folder(), signal: new AbortController().signal });
  assertEquals(await complete("use $zz-skills-test-de"), {
    from: 4,
    to: 22,
    items: [{ label: `$${DEPLOY}`, detail: "Ship the app to production.", insert: `$${DEPLOY} ` }],
  });
  // The insert replaces the rest of the name after the caret too.
  assertEquals((await complete(`$${REVIEW}`, 5))?.to, REVIEW.length + 1);
  assertEquals(await complete("use `$zz-skills-test"), undefined);
  assertEquals(await complete("use$zz-skills-test"), undefined);
  assertEquals(await complete("$zz-skills-test-none"), undefined);
});
