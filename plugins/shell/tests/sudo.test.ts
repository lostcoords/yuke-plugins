import { writeTextFile } from "yuke:fs";
import { assert, assertEquals, folder, test } from "yuke:test";
import { literalArguments, plain, quoted, runAsRoot } from "../src/sudo.ts";

// A stand-in for `sudo -A -k -- argv`: it asks SUDO_ASKPASS up to three times, and runs argv for the password "secret".
const FAKE_SUDO = `#!/bin/sh
shift 3
for attempt in 1 2 3; do
  password="$("$SUDO_ASKPASS" "Password:")"
  [ "$password" = secret ] && exec "$@"
done
echo "sudo: 3 incorrect password attempts" >&2
exit 1
`;
// A stand-in for sudo with NOPASSWD: it runs argv without asking.
const NOPASSWD_SUDO = `#!/bin/sh
shift 3
exec "$@"
`;
// The command reads stdin, so a password that reached it would show.
const COMMAND = ["sh", "-c", "echo out; echo err >&2; read line; echo stdin:$line"];

async function script(name: string, text: string): Promise<string> {
  const path = `${folder()}/${name}`;
  await writeTextFile(path, text, { mode: 0o755 });
  return path;
}

/** A password source that gives `answers` in order, and records each attempt that asked. */
function answering(answers: (string | undefined)[]) {
  const attempts: number[] = [];
  const source = async (attempt: number): Promise<string | undefined> => {
    attempts.push(attempt);
    return answers[attempt - 1];
  };
  return { attempts, source };
}

test("a sudo line keeps quoted words whole and refuses shell syntax outside quotes", () => {
  assertEquals(literalArguments(`launchctl kickstart -k "system/com.example x"`), [
    "launchctl",
    "kickstart",
    "-k",
    "system/com.example x",
  ]);
  assertEquals(literalArguments(`sh -c 'echo a && echo $HOME'`), ["sh", "-c", "echo a && echo $HOME"]);
  assert(literalArguments("apt update && make") instanceof Error);
  assert(literalArguments("rm /tmp/*") instanceof Error);
  assert(literalArguments("cat $HOME/x") instanceof Error);
  assert(literalArguments("-u root id") instanceof Error);
  assert(literalArguments(`echo "open`) instanceof Error);
  assert(literalArguments("  ") instanceof Error);
});

test("sudo asks again after a wrong password, and the command never reads the password", async () => {
  const sudo = await script("sudo", FAKE_SUDO);
  const password = answering(["wrong", "secret"]);
  const result = await runAsRoot(sudo, COMMAND, folder(), new AbortController().signal, password.source, () => {});
  assertEquals(password.attempts, [1, 2]);
  assertEquals(result.code, 0);
  assertEquals(result.text.split("\n").sort(), ["", "err", "out", "stdin:"]);
});

test("a canceled password stops sudo, which would ask again after an empty one", async () => {
  const sudo = await script("sudo", FAKE_SUDO);
  const password = answering([undefined, "secret"]);
  const result = await runAsRoot(sudo, COMMAND, folder(), new AbortController().signal, password.source, () => {});
  assertEquals(password.attempts, [1]);
  assert(result.signal !== null);
  assert(!result.text.includes("out"));
});

test("sudo without a password need asks nothing", async () => {
  const sudo = await script("sudo", NOPASSWD_SUDO);
  const password = answering([]);
  const result = await runAsRoot(sudo, COMMAND, folder(), new AbortController().signal, password.source, () => {});
  assertEquals(password.attempts, []);
  assertEquals(result.code, 0);
});

test("output loses terminal escapes and control characters but keeps lines", () => {
  assertEquals(plain("\x1b[31mred\x1b[0m\r\nnext\tcol\x07\n"), "red\nnext  col\n");
});

test("an approval shows each argument whole, with reordering and invisible characters escaped", () => {
  assertEquals(quoted(["rm", "-rf", "/tmp/a b", 'say "hi"']), '"rm" "-rf" "/tmp/a b" "say \\"hi\\""');
  // U+202E reverses the text after it, and U+200B shows nothing.
  assertEquals(quoted(["/tmp/\u202Etxt.sh", "a\u200Bb", "x\ny"]), '"/tmp/\\u{202e}txt.sh" "a\\u{200b}b" "x\\u{a}y"');
});
