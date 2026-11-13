import { mkdir, readTextFile, writeTextFile } from "yuke:fs";
import { assert, assertEquals, assertRejects, folder, test } from "yuke:test";
import { History } from "../src/history.ts";

const sample = {
  sessionId: "main-session",
  model: { provider: "provider", model: "model" },
  question: "Which file?",
  answer: "src/main.ts",
};

test("saved exchanges survive a new history reader and contain only text and metadata", async () => {
  const saved = await new History(folder()).save(sample);
  const reopened = await new History(folder()).list("main-session");
  assertEquals(reopened, { entries: [saved], warnings: [] });
  const stored = JSON.parse(await readTextFile(`history/main-session/${saved.id}.json`, { cwd: folder() }));
  assertEquals(Object.keys(stored).sort(), ["answer", "createdAt", "id", "model", "question", "sessionId", "version"]);
  assertEquals(stored.question, "Which file?");
  assertEquals(stored.answer, "src/main.ts");
});

test("concurrent completed answers do not replace each other and session histories stay separate", async () => {
  const history = new History(folder());
  await Promise.all([
    history.save({ ...sample, question: "first" }),
    history.save({ ...sample, question: "second" }),
    history.save({ ...sample, sessionId: "another-session", question: "other" }),
  ]);
  assertEquals((await history.list("main-session")).entries.map((item) => item.question).sort(), ["first", "second"]);
  assertEquals(
    (await history.list("another-session")).entries.map((item) => item.question),
    ["other"],
  );
  assertEquals((await history.list()).entries.length, 3);
});

test("history is newest first, independent of directory enumeration order", async () => {
  const history = new History(folder());
  const older = await history.save(sample);
  const newer = await history.save({ ...sample, question: "newer" });
  older.createdAt = 1;
  newer.createdAt = 2;
  for (const item of [older, newer])
    await writeTextFile(`history/main-session/${item.id}.json`, JSON.stringify(item), { cwd: folder() });
  assertEquals(
    (await history.list()).entries.map((item) => item.question),
    ["newer", "Which file?"],
  );
});

test("missing history is empty, not a failure", async () => {
  const history = new History(folder());
  assertEquals(await history.list(), { entries: [], warnings: [] });
  assertEquals(await history.list("main-session"), { entries: [], warnings: [] });
});

test("corrupt and unsupported records are reported without hiding valid records or changing disk contents", async () => {
  const history = new History(folder());
  const saved = await history.save(sample);
  const files = {
    "broken.json": "{",
    "future.json": JSON.stringify({ ...saved, id: "future", version: 2 }),
    "mismatched.json": JSON.stringify(saved),
    "invalid-time.json": JSON.stringify({ ...saved, id: "invalid-time", createdAt: 1e100 }),
  };
  for (const [path, text] of Object.entries(files))
    await writeTextFile(`history/main-session/${path}`, text, { cwd: folder() });
  const result = await history.list();
  assertEquals(result.entries, [saved]);
  assertEquals(result.warnings.length, 4);
  for (const [path, text] of Object.entries(files))
    assertEquals(await readTextFile(`history/main-session/${path}`, { cwd: folder() }), text);
});

test("deleting an exchange is repeatable and does not delete another session or unrelated plugin data", async () => {
  const history = new History(folder());
  const saved = await history.save(sample);
  const other = await history.save({ ...sample, sessionId: "another-session" });
  await writeTextFile("settings.json", "keep", { cwd: folder() });
  await history.remove(saved);
  await history.remove(saved);
  assertEquals((await history.list()).entries, [other]);
  assertEquals(await readTextFile("settings.json", { cwd: folder() }), "keep");
});

test("invalid storage keys cannot escape the plugin history directory", async () => {
  const history = new History(folder());
  await assertRejects(() => history.save({ ...sample, sessionId: "../escape" }));
  await assertRejects(() => history.list("../escape"));
  const saved = await history.save(sample);
  await assertRejects(() => history.remove({ ...saved, id: "../../escape" }));
  assertEquals((await history.list()).entries, [saved]);
});

test("a failed disk write is reported rather than pretending an answer was saved", async () => {
  await mkdir(`${folder()}/history`);
  await writeTextFile("history/main-session", "not a directory", { cwd: folder() });
  const error = await assertRejects(() => new History(folder()).save(sample));
  assert(error instanceof Error);
});
