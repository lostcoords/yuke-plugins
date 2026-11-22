import { assertEquals, test } from "yuke:test";
import { afterLine, firstNonblank, lineEnd, lineStart, Navigation } from "../src/text.ts";

test("line helpers keep CRLF together and retain empty first and last lines", () => {
  const text = "\r\n \talpha\r\n\nlast\n";
  assertEquals([lineStart(text, 0), lineEnd(text, 0), afterLine(text, 0)], [0, 0, 2]);
  assertEquals([lineStart(text, 7), lineEnd(text, 2), afterLine(text, 9), firstNonblank(text, 7)], [2, 9, 11, 4]);
  assertEquals([lineStart(text, 11), lineEnd(text, 11), firstNonblank(text, 11)], [11, 11, 11]);
  assertEquals([lineStart(text, 17), lineEnd(text, 17), afterLine(text, 17)], [17, 17, 17]);
  assertEquals([lineEnd("last", 1), afterLine("last", 4), firstNonblank(" \t", 0)], [4, 4, 2]);
});

const cluster = "a👩‍💻e\u0301🇯🇵\r\nZ";

test("carets stay before whole graphemes at a line end and snap out of joined clusters", () => {
  const navigation = new Navigation();
  const cases: readonly [string, number, number][] = [
    [cluster, 12, 8],
    [cluster, 15, 14],
    ["abc", -4, 0],
    ["abc", 50, 2],
    ["\nabc", 0, 0],
    ["abc\n", 4, 4],
    ["", 5, 0],
  ];
  assertEquals(
    cases.map(([text, at]) => navigation.clamp(text, at)),
    cases.map(([, , expected]) => expected),
  );
  const snaps: readonly [string, number, number][] = [
    [cluster, 3, 1],
    [cluster, 7, 6],
    [cluster, 9, 8],
    [cluster, 13, 12],
    ["🇯🇵", 2, 0],
    ["e\u0301", 1, 0],
    [cluster, -1, 0],
    [cluster, 99, 15],
    ["abc", 1, 1],
  ];
  assertEquals(
    snaps.map(([text, at]) => navigation.snap(text, at)),
    snaps.map(([, , expected]) => expected),
  );
});

test("navigation steps and distances use UTF-16 offsets of whole graphemes and follow the current text", () => {
  const navigation = new Navigation();
  assertEquals(
    [0, 1, 6, 8, 12, 14, 15].map((at) => navigation.next(cluster, at)),
    [1, 6, 8, 12, 14, 15, 15],
  );
  assertEquals(
    [15, 14, 12, 8, 6, 1, 0].map((at) => navigation.previous(cluster, at)),
    [14, 12, 8, 6, 1, 0, 0],
  );
  assertEquals([navigation.distance(cluster, 0, 15), navigation.distance(cluster, 1, 12)], [6, 3]);
  assertEquals(
    [
      navigation.next("a👩‍💻z", 1),
      navigation.next("ae\u0301z", 1),
      navigation.previous("a👩‍💻z", 6),
      navigation.next("", 0),
    ],
    [6, 3, 1, 0],
  );
});

test("word motions keep Indic conjuncts and long combining clusters whole", () => {
  const navigation = new Navigation();
  assertEquals(
    [navigation.next("क्ष e\u0301", 0), navigation.wordStart("क्ष e\u0301", 0), navigation.wordEnd("क्ष e\u0301", 0)],
    [3, 4, 4],
  );
  assertEquals(navigation.wordBack("क्ष e\u0301", 6), 4);
  assertEquals(navigation.wordEnd(`xa${"\u0301".repeat(300)}y`, 0), 302);
  const text = "界".repeat(1500).slice(100, 1100);
  assertEquals(
    [navigation.wordStart(text, 0), navigation.wordBack(text, 1000), navigation.wordEnd(text, 0)],
    [1000, 0, 999],
  );
});

test("small words separate keyword punctuation and whitespace while big words join punctuation", () => {
  const navigation = new Navigation();
  const text = "one.. two_three";
  assertEquals([navigation.wordStart(text, 0), navigation.wordStart(text, 3), navigation.wordBack(text, 6)], [3, 6, 3]);
  assertEquals(
    [navigation.wordEnd(text, 0), navigation.wordEnd(text, 2), navigation.wordEnd(text, 3, 1, false, true)],
    [2, 4, 4],
  );
  assertEquals(
    [navigation.wordStart(text, 0, 2), navigation.wordBack(text, 14, 2), navigation.wordEnd(text, 0, 2)],
    [6, 3, 4],
  );
  assertEquals(
    [
      navigation.wordStart(text, 0, 1, true),
      navigation.wordBack(text, 6, 1, true),
      navigation.wordEnd(text, 0, 1, true),
    ],
    [6, 0, 4],
  );
});

test("Vim script classes separate Hiragana Katakana Han Hangul emoji and symbol words", () => {
  const navigation = new Navigation();
  const text = "abcあいうカナ漢字한글🙂😀⁰ⁱ₀₁⠁⠂";
  assertEquals(
    [0, 3, 6, 8, 10, 12, 16, 18, 20].map((at) => navigation.wordStart(text, at)),
    [3, 6, 8, 10, 12, 16, 18, 20, 22],
  );
  assertEquals(
    [
      navigation.wordStart(text, 0, 1, true),
      navigation.wordEnd(text, 0, 1, true),
      navigation.wordBack(text, 22, 1, true),
    ],
    [22, 21, 0],
  );
  assertEquals(
    [
      navigation.wordStart("a!😀☀x", 1),
      navigation.wordStart("a!😀☀x", 2),
      navigation.wordEnd("a!😀☀x", 2, 1, false, true),
    ],
    [2, 5, 4],
  );
});

test("word whitespace follows Vim classes rather than JavaScript whitespace", () => {
  const navigation = new Navigation();
  assertEquals(
    [navigation.wordStart("a\u00a0b", 0), navigation.wordStart("a\u200bb", 0), navigation.wordStart("a\u2028b", 0)],
    [2, 2, 2],
  );
  assertEquals(
    [navigation.wordStart("a\rb", 0), navigation.wordStart("a\vb", 0), navigation.wordStart("a\fb", 0)],
    [1, 1, 1],
  );
  assertEquals([navigation.wordEnd("a\r\nb", 0), navigation.wordStart("a\r\nb", 0)], [3, 3]);
});

test("empty lines stop word starts and backs but not word ends", () => {
  const navigation = new Navigation();
  const text = "one\r\n\r\ntwo";
  assertEquals([navigation.wordStart(text, 0), navigation.wordStart(text, 5), navigation.wordBack(text, 7)], [5, 7, 5]);
  assertEquals([navigation.wordEnd(text, 2), navigation.wordBack(text, 5)], [9, 0]);
  assertEquals(
    [navigation.empty(text, 5), navigation.empty(text, 0), navigation.empty(" \n", 0)],
    [true, false, false],
  );
});

test("an operator word start stops before its last line ending", () => {
  const navigation = new Navigation();
  const text = "one  \r\ntwo";
  assertEquals([navigation.wordStart(text, 0), navigation.wordStart(text, 0, 1, false, true)], [7, 5]);
  assertEquals([navigation.wordStart(text, 0, 2, false, true), navigation.wordStart(text, 5, 1, false, true)], [10, 7]);
  assertEquals(navigation.wordStart("one\n\ntwo", 4, 1, false, true), 5);
});

test("previous word ends report partial destinations when the count reaches the start", () => {
  const navigation = new Navigation();
  assertEquals([navigation.previousEnd("one two", 5), navigation.previousEnd("one two", 5, 1, true)], [2, 2]);
  assertEquals(navigation.previousEnd("one two", 1), 0);
  assertEquals(navigation.failureTarget, 0);
  assertEquals(navigation.previousEnd("one two", 0), -1);
  assertEquals(navigation.failureTarget, 0);
  assertEquals(navigation.previousEnd("one two", 7), 6);
});

test("character finds count whole graphemes and never cross a logical line", () => {
  const navigation = new Navigation();
  const text = "a👩‍💻b👩‍💻c\n👩‍💻";
  assertEquals(
    [
      navigation.find(text, 0, "f", "👩‍💻", 1),
      navigation.find(text, 0, "f", "👩‍💻", 2),
      navigation.find(text, 12, "F", "👩‍💻", 1),
    ],
    [1, 7, 7],
  );
  assertEquals([navigation.find(text, 0, "f", "👩", 1), navigation.find(text, 0, "f", "👩‍", 1)], [1, -1]);
  assertEquals(
    [
      navigation.find(text, 12, "f", "👩‍💻", 1),
      navigation.find(text, 14, "F", "👩‍💻", 1),
      navigation.find(text, 0, "f", "z", 1),
    ],
    [-1, -1, -1],
  );
});

test("repeated till finds skip the adjacent match in each direction", () => {
  const navigation = new Navigation();
  const text = "a👩‍💻b👩‍💻c";
  assertEquals([navigation.find(text, 0, "t", "👩‍💻", 1), navigation.find(text, 0, "t", "👩‍💻", 1, true)], [0, 6]);
  assertEquals([navigation.find(text, 12, "T", "👩‍💻", 1), navigation.find(text, 12, "T", "👩‍💻", 1, true)], [12, 6]);
  assertEquals(navigation.find("a\r\na", 0, "f", "a", 1), -1);
});

test("bracket matching ignores escaped and quoted delimiters but not word apostrophes", () => {
  const navigation = new Navigation();
  const text = '("[)]" [x])';
  assertEquals(
    [navigation.match(text, 0), navigation.match(text, 7), navigation.match(text, 10), navigation.match(text, 2)],
    [10, 9, 0, -1],
  );
  assertEquals(
    [navigation.match("\\(x) (y)", 0), navigation.match("\\(x) (y)", 5), navigation.match("don't (x)", 6)],
    [-1, 7, 8],
  );
  assertEquals([navigation.match("abc\n(x)", 0), navigation.match("(x", 0)], [-1, -1]);
});

test("paragraphs stop at empty lines rather than lines with spaces", () => {
  const navigation = new Navigation();
  const text = "one\n \n\ntwo\r\n\r\nthree";
  assertEquals(
    [
      navigation.paragraph(text, 0, true, 1),
      navigation.paragraph(text, 0, true, 2),
      navigation.paragraph(text, 6, true, 1),
    ],
    [6, 12, 12],
  );
  assertEquals(
    [
      navigation.paragraph(text, 14, false, 1),
      navigation.paragraph(text, 12, false, 1),
      navigation.paragraph(text, 6, false, 1),
    ],
    [12, 6, 0],
  );
  assertEquals([navigation.paragraph(text, 14, true, 1), navigation.paragraph(text, 0, false, 1)], [19, 0]);
});

const range = (from: number, to: number) => ({ from, to, target: from, lines: false, inclusive: false });

test("text objects return half-open operator ranges", () => {
  const navigation = new Navigation();
  const cases: readonly [string, string, number, string, boolean, number, ReturnType<typeof range> | null][] = [
    ["inner word", "one  two.three", 1, "w", false, 1, range(0, 3)],
    ["around word", "one  two.three", 1, "w", true, 1, range(0, 5)],
    ["inner whitespace", "one  two.three", 3, "w", false, 1, range(3, 5)],
    ["around whitespace", "one  two.three", 3, "w", true, 1, range(3, 8)],
    ["inner WORD", "one  two.three", 6, "W", false, 1, range(5, 14)],
    ["around uses preceding spaces at line end", "one two", 5, "w", true, 1, range(3, 7)],
    ["around keeps indentation", "  one", 3, "w", true, 1, range(2, 5)],
    ["inner trailing spaces", "one  ", 3, "w", false, 1, range(3, 5)],
    ["around trailing spaces without a word", "one  ", 3, "w", true, 1, null],
    ["a word count beyond the text", "one", 0, "w", false, 2, null],
    ["inner quotes find the next pair", 'x "one"  y', 0, '"', false, 1, range(3, 6)],
    ["around quotes include surrounding blanks", 'x "one"  y', 4, '"', true, 1, range(2, 9)],
    ["counted inner quotes include the quotes", 'x "one"  y', 4, '"', false, 2, range(2, 7)],
    ["escaped quotes do not close a pair", "'a\\'b'", 2, "'", false, 1, range(1, 5)],
    ["quotes do not cross a line", 'x\n"one"', 0, '"', false, 1, null],
    ["inner nested bracket", "(a(b)c)", 3, "b", false, 1, range(3, 4)],
    ["counted bracket", "(a(b)c)", 3, ")", false, 2, range(1, 6)],
    ["counted around bracket", "(a(b)c)", 3, "(", true, 2, range(0, 7)],
    ["bracket pair after the caret", "x (a)", 0, "(", false, 1, range(3, 4)],
    ["bracket count beyond the nesting", "(a)", 1, "(", false, 2, null],
    ["unknown object kind", "(a)", 1, "?", false, 1, null],
    ["multiline inner bracket", "(\r\n  x\r\n  )", 5, "(", false, 1, range(3, 6)],
    ["multiline around bracket", "(\r\n  x\r\n  )", 5, "(", true, 1, range(0, 11)],
    ["multiline inner brace", "{\n  x\n}", 4, "B", false, 1, range(2, 5)],
  ];
  assertEquals(
    cases.map(([behavior, text, at, kind, around, count]) => [
      behavior,
      navigation.object(text, at, kind, around, count),
    ]),
    cases.map(([behavior, , , , , , expected]) => [behavior, expected]),
  );
});

test("counted word objects include the intervening whitespace and line ending as steps", () => {
  const navigation = new Navigation();
  const cases: readonly [string, number, boolean, number, ReturnType<typeof range>][] = [
    ["one  two.three", 1, false, 2, range(0, 5)],
    ["one  two.three", 1, true, 2, range(0, 8)],
    ["e\u0301 👩‍💻", 3, false, 1, range(3, 8)],
    ["one\r\ntwo", 0, false, 2, range(0, 8)],
    ["one\r\n\r\ntwo", 0, false, 2, range(0, 7)],
    ["one\n\ntwo", 4, false, 1, range(4, 4)],
  ];
  assertEquals(
    cases.map(([text, at, around, count]) => navigation.wordObject(text, at, around, count, false)),
    cases.map(([, , , , expected]) => expected),
  );
});

test("a failed object reports the last normal caret", () => {
  const navigation = new Navigation();
  assertEquals(navigation.object("one", 0, "w", false, 2), null);
  assertEquals(navigation.failureTarget, 2);
  assertEquals(navigation.object("one  ", 3, "w", true, 1), null);
  assertEquals(navigation.failureTarget, 4);
});
