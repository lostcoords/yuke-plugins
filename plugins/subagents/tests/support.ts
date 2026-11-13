import type { PluginContext, ServiceOf, Services } from "yuke:plugins";
import type { FrameTest } from "yuke:test";

/** Draw the frame, and give the text of each row without its trailing spaces. */
export function rows(frame: FrameTest): string[] {
  frame.draw();
  return frame.frame.cells.map((row) =>
    row
      .map((cell) => cell.text)
      .join("")
      .trimEnd(),
  );
}

/** The services that a test replaces. */
type Replacements = { readonly [K in keyof Services & string]?: ServiceOf<K> };

/** A context whose `get` gives the service in `services` for its name, and the real service for any other name. */
export function withServices(ctx: PluginContext, services: Replacements): PluginContext {
  const get = <K extends keyof Services & string>(name: K): ServiceOf<K> =>
    (name in services ? services[name] : ctx.get(name)) as ServiceOf<K>;
  return { ...ctx, get };
}
