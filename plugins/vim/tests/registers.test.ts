import { assertEquals, test } from "yuke:test";
import { Registers } from "../src/registers.ts";

test("a yank replaces the unnamed and yank registers without replacing delete history", () => {
  const registers = new Registers();
  registers.save("deleted line", true, "d");
  registers.save("deleted word", false, "c");
  registers.save("first yank", true, "y");
  registers.save("second yank", false, "y");

  assertEquals(registers.read('"'), { text: "second yank", linewise: false });
  assertEquals(registers.read("0"), { text: "second yank", linewise: false });
  assertEquals(registers.read("1"), { text: "deleted line", linewise: true });
  assertEquals(registers.read("-"), { text: "deleted word", linewise: false });
});

test("linewise deletes rotate nine entries and discard the oldest", () => {
  const registers = new Registers();
  for (const text of ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]) {
    registers.save(text, true, "d");
  }

  assertEquals(registers.read('"'), { text: "ten", linewise: true });
  assertEquals(
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((name) => registers.read(name)),
    [
      { text: "ten", linewise: true },
      { text: "nine", linewise: true },
      { text: "eight", linewise: true },
      { text: "seven", linewise: true },
      { text: "six", linewise: true },
      { text: "five", linewise: true },
      { text: "four", linewise: true },
      { text: "three", linewise: true },
      { text: "two", linewise: true },
    ],
  );
});

test("a multiline characterwise change enters numbered history without becoming linewise", () => {
  const registers = new Registers();
  registers.save("old line", true, "d");
  registers.save("first\nsecond", false, "c");

  assertEquals(registers.read('"'), { text: "first\nsecond", linewise: false });
  assertEquals(registers.read("1"), { text: "first\nsecond", linewise: false });
  assertEquals(registers.read("2"), { text: "old line", linewise: true });
});

test("small deletes replace only the small-delete and unnamed registers", () => {
  const registers = new Registers();
  registers.save("yanked", false, "y");
  registers.save("line", true, "d");
  registers.save("first", false, "d");
  registers.save("second", false, "c");

  assertEquals(registers.read('"'), { text: "second", linewise: false });
  assertEquals(registers.read("-"), { text: "second", linewise: false });
  assertEquals(registers.read("0"), { text: "yanked", linewise: false });
  assertEquals(registers.read("1"), { text: "line", linewise: true });
  assertEquals(registers.read("2"), undefined);
});

test("explicit named writes replace their entry and bypass automatic histories", () => {
  const registers = new Registers();
  registers.save("yank history", false, "y");
  registers.save("delete history", true, "d");
  registers.save("small history", false, "d");
  registers.save("named yank", false, "y", "a");
  registers.save("named line", true, "d", "a");
  registers.save("named word", false, "c", "b");

  assertEquals(registers.read("a"), { text: "named line", linewise: true });
  assertEquals(registers.read("A"), { text: "named line", linewise: true });
  assertEquals(registers.read("b"), { text: "named word", linewise: false });
  assertEquals(registers.read('"'), { text: "named word", linewise: false });
  assertEquals(registers.read("0"), { text: "yank history", linewise: false });
  assertEquals(registers.read("1"), { text: "delete history", linewise: true });
  assertEquals(registers.read("2"), undefined);
  assertEquals(registers.read("-"), { text: "small history", linewise: false });
});

test("uppercase writes append characterwise text without a separator", () => {
  const registers = new Registers();
  registers.save("first", false, "y", "a");
  registers.save("second", false, "d", "A");

  assertEquals(registers.read("a"), { text: "firstsecond", linewise: false });
  assertEquals(registers.read('"'), { text: "firstsecond", linewise: false });
});

test("uppercase writes add a separator after linewise text and preserve linewise metadata", () => {
  const registers = new Registers();
  registers.save("first", true, "y", "a");
  registers.save("second", false, "d", "A");

  assertEquals(registers.read("A"), { text: "first\nsecond", linewise: true });
  assertEquals(registers.read('"'), { text: "first\nsecond", linewise: true });
});

test("appending linewise text to characterwise text adds no separator", () => {
  const registers = new Registers();
  registers.save("first", false, "y", "a");
  registers.save("second", true, "y", "A");

  assertEquals(registers.read("a"), { text: "firstsecond", linewise: true });
  assertEquals(registers.read('"'), { text: "firstsecond", linewise: true });
});

test("an uppercase write creates a missing named register", () => {
  const registers = new Registers();
  registers.save("new line", true, "y", "Z");

  assertEquals(registers.read("z"), { text: "new line", linewise: true });
  assertEquals(registers.read("Z"), { text: "new line", linewise: true });
  assertEquals(registers.read('"'), { text: "new line", linewise: true });
  assertEquals(registers.read("0"), undefined);
});

test("blackhole writes preserve existing unnamed, named, yank, and delete registers", () => {
  const registers = new Registers();
  registers.save("named", true, "y", "a");
  registers.save("yank", false, "y");
  registers.save("line", true, "d");
  registers.save("word", false, "d");
  registers.save("discard yank", true, "y", "_");
  registers.save("discard line", true, "d", "_");
  registers.save("discard word", false, "c", "_");

  assertEquals(registers.read('"'), { text: "word", linewise: false });
  assertEquals(registers.read("a"), { text: "named", linewise: true });
  assertEquals(registers.read("0"), { text: "yank", linewise: false });
  assertEquals(registers.read("1"), { text: "line", linewise: true });
  assertEquals(registers.read("-"), { text: "word", linewise: false });
  assertEquals(registers.read("2"), undefined);
  assertEquals(registers.read("_"), undefined);
});

test("explicit numbered writes bypass history and empty slots remove stale rotated entries", () => {
  const registers = new Registers();
  registers.save("oldest", true, "d", "9");
  registers.save("middle", false, "y", "5");
  registers.save("new line", true, "d");

  assertEquals(registers.read("1"), { text: "new line", linewise: true });
  assertEquals(registers.read("6"), { text: "middle", linewise: false });
  assertEquals(registers.read("5"), undefined);
  assertEquals(registers.read("9"), undefined);
  assertEquals(registers.read("0"), undefined);
});

test("clear removes all saved text and the owner accepts new writes", () => {
  const registers = new Registers();
  registers.save("named", true, "y", "a");
  registers.save("yank", false, "y");
  registers.save("line", true, "d");
  registers.save("word", false, "d");
  assertEquals(registers.read('"'), { text: "word", linewise: false });
  assertEquals(registers.read("a"), { text: "named", linewise: true });

  registers.clear();

  assertEquals(registers.read('"'), { text: "", linewise: false });
  for (const name of ["a", "0", "1", "-"]) assertEquals(registers.read(name), undefined);

  registers.save("new", true, "y", "A");
  assertEquals(registers.read("a"), { text: "new", linewise: true });
  assertEquals(registers.read('"'), { text: "new", linewise: true });
});
