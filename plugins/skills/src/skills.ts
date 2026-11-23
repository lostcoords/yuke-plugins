import { readDir, readTextFile } from "yuke:fs";

/** A skill that a `$name` mention can load. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The path of its `SKILL.md`. */
  readonly location: string;
  /** The text of its `SKILL.md` after the front matter. */
  readonly body: string;
}

// A code span, an escaped dollar sign, or a mention. Only the mention captures a name.
const MENTION = /(`+)[\s\S]*?\1|\\\$|(?<=^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[^\w$-])/g;

/** The skill names that `text` mentions as `$name`, in order, outside code spans. `\$` stays literal. */
export function mentions(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(MENTION)) if (match[2] !== undefined) names.push(match[2]);
  return names;
}

/** The skill folders of yuke for a session in `folder`, in the order of yuke: an earlier folder hides a later name. */
export function rootsOf(folder: string, home: string | undefined): string[] {
  const roots = [`${folder}/.agents/skills`];
  if (home !== undefined) roots.push(`${home}/.agents/skills`);
  return roots;
}

/**
 * The skills of `roots`, as yuke finds them: each direct subfolder with a `SKILL.md` that has front matter and a
 * `description`. The name defaults to the folder name. A missing or unreadable folder or file has no skill.
 */
export async function scan(roots: readonly string[], signal?: AbortSignal): Promise<Skill[]> {
  const skills = new Map<string, Skill>();
  for (const root of roots) {
    const folders: string[] = [];
    try {
      for await (const entry of readDir(root, { signal })) if (!entry.isFile) folders.push(entry.name);
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    for (const folder of folders) {
      const location = `${root}/${folder}/SKILL.md`;
      let text: string;
      try {
        text = await readTextFile(location, { signal });
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      const skill = parse(text, folder, location);
      if (skill !== undefined && !skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }
  return [...skills.values()].sort((first, second) => (first.name < second.name ? -1 : 1));
}

/** The skill of the `SKILL.md` text, or `undefined` when it has no front matter or no description. */
function parse(text: string, folder: string, location: string): Skill | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return undefined;
  const fields = new Map<string, string>();
  for (let index = 1; index < end; index += 1) {
    const field = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[index] ?? "");
    if (field === null) continue;
    const key = field[1] ?? "";
    const raw = (field[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(raw)) {
      // A block value is the indented lines after its key. `>` folds them into one line.
      const block: string[] = [];
      while (index + 1 < end && /^(\s|$)/.test(lines[index + 1] ?? "")) {
        index += 1;
        block.push((lines[index] ?? "").trim());
      }
      fields.set(key, block.join(raw.startsWith(">") ? " " : "\n").trim());
    } else fields.set(key, scalar(raw));
  }
  const description = fields.get("description");
  if (description === undefined || description === "") return undefined;
  return {
    name: fields.get("name") || folder,
    description,
    location,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** The text of a plain or quoted value on one line. */
function scalar(raw: string): string {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length > 1 && raw.endsWith(quote)) {
    const inner = raw.slice(1, -1);
    return quote === "'" ? inner.replaceAll("''", "'") : inner.replace(/\\(["\\])/g, "$1");
  }
  return raw.replace(/\s+#.*$/, "");
}
