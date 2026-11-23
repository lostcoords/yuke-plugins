import { mkdir, remove, writeTextFile } from "yuke:fs";
import { type ChildProcess, Command, env } from "yuke:process";

/** The last characters of the output that a command keeps. */
export const OUTPUT_LIMIT = 48_000;

/**
 * The words of `line` as literal arguments, or an `Error` that tells why the line needs a shell. Single and double
 * quotes group a word. A shell operator or an expansion outside quotes is an error, so the user sees each argument
 * that runs as root.
 */
export function literalArguments(line: string): string[] | Error {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (const character of line) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word = (word ?? "") + character;
    } else if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
    } else if (/\s/u.test(character)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (";&|<>()$`*?~\\".includes(character)) {
      return new Error(`"${character}" needs a shell. Run a shell as root explicitly, such as: !sudo sh -c '…'`);
    } else {
      word = (word ?? "") + character;
    }
  }
  if (quote !== undefined) return new Error(`A ${quote} quote has no end.`);
  if (word !== undefined) words.push(word);
  if (words.length === 0) return new Error("Name a command after sudo.");
  if (words[0]?.startsWith("-")) return new Error("Sudo options are not supported. Name a command after sudo.");
  return words;
}

/** Gives the password for attempt `attempt` of sudo, or `undefined` to stop sudo. An abort of `signal` cancels it. */
export type PasswordSource = (attempt: number, signal: AbortSignal) => Promise<string | undefined>;

/**
 * Run `argv` as root, and collect its output as `collect` does. sudo asks `password` through an askpass program only
 * when it needs a password, also again after a wrong one. `-k` makes sudo ignore and keep no cached credential. The
 * password goes through a FIFO in a private folder to the askpass program: never to disk, and never to stdin of the
 * command, which gets no stdin.
 */
export async function runAsRoot(
  sudo: string,
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
  password: PasswordSource,
  onText: (text: string) => void,
): Promise<Collected> {
  // mkdir does not follow a link and fails when the path exists, so no other user owns the folder.
  const folder = `${env.get("TMPDIR")?.replace(/\/$/u, "") ?? "/tmp"}/yuke-sudo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await mkdir(folder, { mode: 0o700 });
  try {
    const request = `${folder}/request`;
    const answer = `${folder}/answer`;
    const askpass = `${folder}/askpass`;
    const made = await new Command("mkfifo", { args: ["-m", "600", request, answer], cwd }).output();
    if (!made.success) throw new Error(`mkfifo failed: ${new TextDecoder().decode(made.stderr).trim()}`);
    await writeTextFile(askpass, `#!/bin/sh\nprintf x > '${request}'\nexec cat '${answer}'\n`, { mode: 0o700 });
    // sudo takes an empty password as a wrong one and asks again, so a cancel stops sudo.
    const cancel = new AbortController();
    const child = new Command(sudo, {
      args: ["-A", "-k", "--", ...argv],
      cwd,
      env: { SUDO_ASKPASS: askpass },
      signal: AbortSignal.any([signal, cancel.signal]),
    }).spawn();
    // yuke:fs refuses a FIFO, so a process opens each one. The end of the run kills a process that still waits.
    const ended = new AbortController();
    const live = AbortSignal.any([signal, ended.signal]);
    const serve = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        const asked = await new Command("cat", { args: [request], cwd, stdout: "null", signal: live }).output();
        if (!asked.success || live.aborted) return;
        const value = await password(attempt, live);
        if (live.aborted) return;
        if (value === undefined) {
          cancel.abort();
          return;
        }
        const writer = new Command("/bin/sh", {
          args: ["-c", `cat > '${answer}'`],
          cwd,
          stdin: "piped",
          stdout: "null",
          signal: live,
        }).spawn();
        const stdin = writer.stdin.getWriter();
        await stdin.write(new TextEncoder().encode(`${value}\n`));
        await stdin.close();
        await writer.status;
      }
    };
    const served = serve().catch(() => {});
    try {
      return await collect(child, onText);
    } finally {
      ended.abort();
      await served;
    }
  } finally {
    await remove(folder, { recursive: true });
  }
}

/** `\u{…}` for each invisible or reordering character, such as a bidi control, so the user sees it. */
export function escapeHidden(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)?.toString(16)}}`);
}

/** Each argument in quotes, with hidden characters escaped, so the user sees each argument that runs. */
export function quoted(argv: readonly string[]): string {
  return argv.map((word) => `"${escapeHidden(word.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))}"`).join(" ");
}

/** The output of a command as one text, and its end. */
export interface Collected {
  readonly text: string;
  readonly code: number;
  readonly signal: string | null;
}

/**
 * Read stdout and stderr of `child` until its end. `onText` gets the text so far at each chunk. The text keeps the last
 * `OUTPUT_LIMIT` characters, without terminal escapes.
 */
export async function collect(child: ChildProcess, onText: (text: string) => void): Promise<Collected> {
  let text = "";
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text = (text + plain(decoder.decode(chunk.value, { stream: true }))).slice(-OUTPUT_LIMIT);
      onText(text);
    }
  };
  await Promise.all([read(child.stdout), read(child.stderr)]);
  const status = await child.status;
  return { text, code: status.code, signal: status.signal };
}

/** `text` without terminal escapes and control characters, with tabs as spaces. */
export function plain(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern matches terminal escapes.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/gu, "")
      .replace(/\r\n/gu, "\n")
      .replace(/\t/gu, "  ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern removes control characters.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "")
  );
}
