/**
 * The plugin `skills`. A `$name` in a message gives the model the `SKILL.md` of that skill with the message, so the
 * user picks the skill and the model does not guess. The transcript keeps the message as the user wrote it. In the
 * composer, `$` completes the skill names.
 */

import type { PluginContext, SessionContext } from "yuke:plugins";
import { env } from "yuke:process";
import type { Block } from "yuke:protocol";
import { mentions, rootsOf, scan } from "./skills.ts";

// The word before the caret is `$` and the start of a skill name.
const PARTIAL = /(?:^|\s)\$([a-z0-9-]*)$/;

export function apply(ctx: PluginContext): undefined {
  const remove = ctx.get("chat").addCompletionProvider({
    complete: async (context) => {
      const before = context.text.slice(0, context.caret);
      const query = PARTIAL.exec(before)?.[1];
      // A backtick that is left after the closed code spans puts the caret in a code span.
      if (query === undefined || before.replace(/(`+)[\s\S]*?\1/g, "").includes("`")) return undefined;
      const skills = await scan(rootsOf(context.folder, env.get("HOME")), context.signal);
      let to = context.caret;
      while (to < context.text.length && /[a-z0-9-]/.test(context.text[to] ?? "")) to += 1;
      const items = skills
        .filter((skill) => skill.name.startsWith(query))
        .map((skill) => ({
          label: `$${skill.name}`,
          detail: skill.description.replace(/\s+/g, " "),
          insert: `$${skill.name} `,
        }));
      return items.length === 0 ? undefined : { from: context.caret - query.length - 1, to, items };
    },
  });
  ctx.signal.addEventListener("abort", remove, { once: true });
  return undefined;
}

export function session(s: SessionContext): undefined {
  s.addHook("input.before", async (event) => {
    if (event.source.kind !== "user") return undefined;
    const names = new Set<string>();
    for (const block of event.blocks)
      if ("kind" in block && block.kind === "userText") for (const name of mentions(block.text)) names.add(name);
    if (names.size === 0) return undefined;
    const skills = await scan(rootsOf(s.folder, env.get("HOME")), event.signal);
    const bodies: Block[] = skills
      .filter((skill) => names.has(skill.name))
      .map((skill) => ({
        kind: "userText",
        text: `<skill name=${JSON.stringify(skill.name)} location=${JSON.stringify(skill.location)}>\n${skill.body}\n</skill>`,
      }));
    if (bodies.length === 0) return undefined;
    const [first, ...rest] = [...event.blocks, ...bodies];
    return first === undefined ? undefined : { replace: { blocks: [first, ...rest] } };
  });
  return undefined;
}
