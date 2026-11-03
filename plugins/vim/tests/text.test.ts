import { equal, test } from "yuke:test";
import { afterLine, firstNonblank, lineEnd, lineStart, Navigation } from "../src/text.ts";

test("line helpers keep CRLF together and retain empty first and last lines", () => {
  const text = "\r\n \talpha\r\n\nlast\n";
  equal([lineStart(text, 0), lineEnd(text, 0), afterLine(text, 0)], [0, 0, 2]);
  equal([lineStart(text, 7), lineEnd(text, 2), afterLine(text, 9), firstNonblank(text, 7)], [2, 9, 11, 4]);
  equal([lineStart(text, 11), lineEnd(text, 11), firstNonblank(text, 11)], [11, 11, 11]);
  equal([lineStart(text, 17), lineEnd(text, 17), afterLine(text, 17)], [17, 17, 17]);
  equal([lineEnd("last", 1), afterLine("last", 4), firstNonblank(" \t", 0)], [4, 4, 2]);
});

test("normal carets stay before whole graphemes at a line end", () => {
  const navigation = new Navigation();
  equal([navigation.clamp("a👩‍💻e\u0301🇯🇵\r\nZ", 12), navigation.clamp("a👩‍💻e\u0301🇯🇵\r\nZ", 15)], [8, 14]);
  equal(
    [
      navigation.clamp("abc", -4),
      navigation.clamp("abc", 50),
      navigation.clamp("\nabc", 0),
      navigation.clamp("abc\n", 4),
      navigation.clamp("", 5),
    ],
    [0, 2, 0, 4, 0],
  );
});

test("edit carets snap before joined combining emoji flag and CRLF clusters", () => {
  const navigation = new Navigation();
  const text = "a👩‍💻e\u0301🇯🇵\r\nZ";
  equal(
    [navigation.snap(text, 3), navigation.snap(text, 7), navigation.snap(text, 9), navigation.snap(text, 13)],
    [1, 6, 8, 12],
  );
  equal(
    [
      navigation.snap("🇯🇵", 2),
      navigation.snap("e\u0301", 1),
      navigation.snap(text, -1),
      navigation.snap(text, 99),
      navigation.snap("abc", 1),
    ],
    [0, 0, 0, 15, 1],
  );
});

test("navigation steps and distances use UTF-16 offsets of whole graphemes", () => {
  const navigation = new Navigation();
  const text = "a👩‍💻e\u0301🇯🇵\r\nZ";
  equal(
    [0, 1, 6, 8, 12, 14, 15].map((at) => navigation.next(text, at)),
    [1, 6, 8, 12, 14, 15, 15],
  );
  equal(
    [15, 14, 12, 8, 6, 1, 0].map((at) => navigation.previous(text, at)),
    [14, 12, 8, 6, 1, 0, 0],
  );
  equal([navigation.distance(text, 0, 15), navigation.distance(text, 1, 12)], [6, 3]);
});

test("segmentation follows the current text after changes", () => {
  const navigation = new Navigation();
  equal(navigation.next("a👩‍💻z", 1), 6);
  equal(navigation.next("ae\u0301z", 1), 3);
  equal(navigation.previous("a👩‍💻z", 6), 1);
  equal(navigation.next("", 0), 0);
});

test("word motions keep Indic conjuncts and long combining clusters whole", () => {
  const navigation = new Navigation();
  equal(
    [navigation.next("क्ष e\u0301", 0), navigation.wordStart("क्ष e\u0301", 0), navigation.wordEnd("क्ष e\u0301", 0)],
    [3, 4, 4],
  );
  equal(navigation.wordBack("क्ष e\u0301", 6), 4);
  equal(navigation.wordEnd(`xa${"\u0301".repeat(300)}y`, 0), 302);
  const text = "界".repeat(1500).slice(100, 1100);
  equal([navigation.wordStart(text, 0), navigation.wordBack(text, 1000), navigation.wordEnd(text, 0)], [1000, 0, 999]);
});

test("small words separate keyword punctuation and whitespace while big words join punctuation", () => {
  const navigation = new Navigation();
  const text = "one.. two_three";
  equal([navigation.wordStart(text, 0), navigation.wordStart(text, 3), navigation.wordBack(text, 6)], [3, 6, 3]);
  equal(
    [navigation.wordEnd(text, 0), navigation.wordEnd(text, 2), navigation.wordEnd(text, 3, 1, false, true)],
    [2, 4, 4],
  );
  equal(
    [navigation.wordStart(text, 0, 2), navigation.wordBack(text, 14, 2), navigation.wordEnd(text, 0, 2)],
    [6, 3, 4],
  );
  equal(
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
  equal(
    [0, 3, 6, 8, 10, 12, 16, 18, 20].map((at) => navigation.wordStart(text, at)),
    [3, 6, 8, 10, 12, 16, 18, 20, 22],
  );
  equal(
    [
      navigation.wordStart(text, 0, 1, true),
      navigation.wordEnd(text, 0, 1, true),
      navigation.wordBack(text, 22, 1, true),
    ],
    [22, 21, 0],
  );
  equal(
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
  equal(
    [navigation.wordStart("a\u00a0b", 0), navigation.wordStart("a\u200bb", 0), navigation.wordStart("a\u2028b", 0)],
    [2, 2, 2],
  );
  equal([navigation.wordStart("a\rb", 0), navigation.wordStart("a\vb", 0), navigation.wordStart("a\fb", 0)], [1, 1, 1]);
  equal([navigation.wordEnd("a\r\nb", 0), navigation.wordStart("a\r\nb", 0)], [3, 3]);
});

test("empty lines stop word starts and backs but not word ends", () => {
  const navigation = new Navigation();
  const text = "one\r\n\r\ntwo";
  equal([navigation.wordStart(text, 0), navigation.wordStart(text, 5), navigation.wordBack(text, 7)], [5, 7, 5]);
  equal([navigation.wordEnd(text, 2), navigation.wordBack(text, 5)], [9, 0]);
  equal([navigation.empty(text, 5), navigation.empty(text, 0), navigation.empty(" \n", 0)], [true, false, false]);
});

test("an operator word start stops before its last line ending", () => {
  const navigation = new Navigation();
  const text = "one  \r\ntwo";
  equal([navigation.wordStart(text, 0), navigation.wordStart(text, 0, 1, false, true)], [7, 5]);
  equal([navigation.wordStart(text, 0, 2, false, true), navigation.wordStart(text, 5, 1, false, true)], [10, 7]);
  equal(navigation.wordStart("one\n\ntwo", 4, 1, false, true), 5);
});

test("previous word ends report partial destinations when the count reaches the start", () => {
  const navigation = new Navigation();
  equal([navigation.previousEnd("one two", 5), navigation.previousEnd("one two", 5, 1, true)], [2, 2]);
  equal(navigation.previousEnd("one two", 1), 0);
  equal(navigation.failureTarget, 0);
  equal(navigation.previousEnd("one two", 0), -1);
  equal(navigation.failureTarget, 0);
  equal(navigation.previousEnd("one two", 7), 6);
});

test("character finds count whole graphemes and never cross a logical line", () => {
  const navigation = new Navigation();
  const text = "a👩‍💻b👩‍💻c\n👩‍💻";
  equal(
    [
      navigation.find(text, 0, "f", "👩‍💻", 1),
      navigation.find(text, 0, "f", "👩‍💻", 2),
      navigation.find(text, 12, "F", "👩‍💻", 1),
    ],
    [1, 7, 7],
  );
  equal([navigation.find(text, 0, "f", "👩", 1), navigation.find(text, 0, "f", "👩‍", 1)], [1, -1]);
  equal(
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
  equal([navigation.find(text, 0, "t", "👩‍💻", 1), navigation.find(text, 0, "t", "👩‍💻", 1, true)], [0, 6]);
  equal([navigation.find(text, 12, "T", "👩‍💻", 1), navigation.find(text, 12, "T", "👩‍💻", 1, true)], [12, 6]);
  equal(navigation.find("a\r\na", 0, "f", "a", 1), -1);
});

test("bracket matching ignores escaped and quoted delimiters but not word apostrophes", () => {
  const navigation = new Navigation();
  const text = '("[)]" [x])';
  equal(
    [navigation.match(text, 0), navigation.match(text, 7), navigation.match(text, 10), navigation.match(text, 2)],
    [10, 9, 0, -1],
  );
  equal(
    [navigation.match("\\(x) (y)", 0), navigation.match("\\(x) (y)", 5), navigation.match("don't (x)", 6)],
    [-1, 7, 8],
  );
  equal([navigation.match("abc\n(x)", 0), navigation.match("(x", 0)], [-1, -1]);
});

test("paragraphs stop at empty lines rather than lines with spaces", () => {
  const navigation = new Navigation();
  const text = "one\n \n\ntwo\r\n\r\nthree";
  equal(
    [
      navigation.paragraph(text, 0, true, 1),
      navigation.paragraph(text, 0, true, 2),
      navigation.paragraph(text, 6, true, 1),
    ],
    [6, 12, 12],
  );
  equal(
    [
      navigation.paragraph(text, 14, false, 1),
      navigation.paragraph(text, 12, false, 1),
      navigation.paragraph(text, 6, false, 1),
    ],
    [12, 6, 0],
  );
  equal([navigation.paragraph(text, 14, true, 1), navigation.paragraph(text, 0, false, 1)], [19, 0]);
});

test("inner and around word objects return half-open operator ranges", () => {
  const navigation = new Navigation();
  const text = "one  two.three";
  equal(navigation.object(text, 1, "w", false, 1), { from: 0, to: 3, target: 0, lines: false, inclusive: false });
  equal(navigation.object(text, 1, "w", true, 1), { from: 0, to: 5, target: 0, lines: false, inclusive: false });
  equal(navigation.object(text, 3, "w", false, 1), { from: 3, to: 5, target: 3, lines: false, inclusive: false });
  equal(navigation.object(text, 3, "w", true, 1), { from: 3, to: 8, target: 3, lines: false, inclusive: false });
  equal(navigation.object(text, 6, "W", false, 1), { from: 5, to: 14, target: 5, lines: false, inclusive: false });
});

test("counted word objects include the intervening whitespace as a step", () => {
  const navigation = new Navigation();
  equal(navigation.wordObject("one  two.three", 1, false, 2, false), {
    from: 0,
    to: 5,
    target: 0,
    lines: false,
    inclusive: false,
  });
  equal(navigation.wordObject("one  two.three", 1, true, 2, false), {
    from: 0,
    to: 8,
    target: 0,
    lines: false,
    inclusive: false,
  });
  equal(navigation.wordObject("e\u0301 👩‍💻", 3, false, 1, false), {
    from: 3,
    to: 8,
    target: 3,
    lines: false,
    inclusive: false,
  });
});

test("around words use preceding spaces at line end without consuming indentation", () => {
  const navigation = new Navigation();
  equal(navigation.object("one two", 5, "w", true, 1), { from: 3, to: 7, target: 3, lines: false, inclusive: false });
  equal(navigation.object("  one", 3, "w", true, 1), { from: 2, to: 5, target: 2, lines: false, inclusive: false });
  equal(navigation.object("one  ", 3, "w", false, 1), { from: 3, to: 5, target: 3, lines: false, inclusive: false });
  equal(navigation.object("one  ", 3, "w", true, 1), null);
  equal(navigation.failureTarget, 4);
});

test("an excessive word object count reports the last normal caret", () => {
  const navigation = new Navigation();
  equal(navigation.object("one", 0, "w", false, 1), { from: 0, to: 3, target: 0, lines: false, inclusive: false });
  equal(navigation.object("one", 0, "w", false, 2), null);
  equal(navigation.failureTarget, 2);
});

test("quote objects find the next pair and include surrounding blanks only for around", () => {
  const navigation = new Navigation();
  const text = 'x "one"  y';
  equal(navigation.object(text, 0, '"', false, 1), { from: 3, to: 6, target: 3, lines: false, inclusive: false });
  equal(navigation.object(text, 4, '"', true, 1), { from: 2, to: 9, target: 2, lines: false, inclusive: false });
  equal(navigation.object(text, 4, '"', false, 2), { from: 2, to: 7, target: 2, lines: false, inclusive: false });
  equal(navigation.object("'a\\'b'", 2, "'", false, 1), { from: 1, to: 5, target: 1, lines: false, inclusive: false });
  equal(navigation.object('x\n"one"', 0, '"', false, 1), null);
});

test("nested bracket objects expand by count and can select the next pair", () => {
  const navigation = new Navigation();
  equal(navigation.object("(a(b)c)", 3, "b", false, 1), { from: 3, to: 4, target: 3, lines: false, inclusive: false });
  equal(navigation.object("(a(b)c)", 3, ")", false, 2), { from: 1, to: 6, target: 1, lines: false, inclusive: false });
  equal(navigation.object("(a(b)c)", 3, "(", true, 2), { from: 0, to: 7, target: 0, lines: false, inclusive: false });
  equal(navigation.object("x (a)", 0, "(", false, 1), { from: 3, to: 4, target: 3, lines: false, inclusive: false });
  equal(navigation.object("(a)", 1, "(", false, 2), null);
  equal(navigation.object("(a)", 1, "?", false, 1), null);
});

test("multiline bracket interiors omit the opening break and the closing line indentation", () => {
  const navigation = new Navigation();
  equal(navigation.object("(\r\n  x\r\n  )", 5, "(", false, 1), {
    from: 3,
    to: 6,
    target: 3,
    lines: false,
    inclusive: false,
  });
  equal(navigation.object("(\r\n  x\r\n  )", 5, "(", true, 1), {
    from: 0,
    to: 11,
    target: 0,
    lines: false,
    inclusive: false,
  });
  equal(navigation.object("{\n  x\n}", 4, "B", false, 1), {
    from: 2,
    to: 5,
    target: 2,
    lines: false,
    inclusive: false,
  });
});

test("counted word objects skip a nonempty line ending as one whole CRLF", () => {
  const navigation = new Navigation();
  equal(navigation.wordObject("one\r\ntwo", 0, false, 2, false), {
    from: 0,
    to: 8,
    target: 0,
    lines: false,
    inclusive: false,
  });
  equal(navigation.wordObject("one\r\n\r\ntwo", 0, false, 2, false), {
    from: 0,
    to: 7,
    target: 0,
    lines: false,
    inclusive: false,
  });
  equal(navigation.wordObject("one\n\ntwo", 4, false, 1, false), {
    from: 4,
    to: 4,
    target: 4,
    lines: false,
    inclusive: false,
  });
});
