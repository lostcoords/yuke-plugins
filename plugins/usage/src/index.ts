/**
 * The plugin `usage`. `/usage` shows the token usage and the estimated cost of the saved sessions: the totals, the
 * periods of last activity, the models, the tools, and the chats. It reads the sessions through the session API.
 */

import type { Frozen, PluginContext, Sessions } from "yuke:plugins";
import type { SessionRow, StoredEvent } from "yuke:protocol";
import { Markdown, Picker, stack, TextView } from "yuke:tui";
import { addTotals, emptyTotals, type Prices, type SessionUsage, type ToolCount, type Totals, tally } from "./tally.ts";

/** A page of saved events. */
const EVENTS_PAGE = 500;
const TABS = ["Overview", "Periods", "Models", "Tools", "Chats"] as const;
const PERIODS = ["Day", "Week", "Month"] as const;

interface Chat {
  readonly row: SessionRow;
  readonly usage: SessionUsage;
  /** The session has a parent, such as a subagent. */
  readonly child: boolean;
}

// The runtime has no locale data, so `toLocaleString` adds no separators.
const count = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+$)/g, ",");
const plural = (value: number, word: string): string => `${count(value)} ${word}${value === 1 ? "" : "s"}`;
const dollars = (value: number): string => `$${value.toFixed(2)}`;

function totalsText(totals: Totals): string {
  const unpriced = totals.unpriced === 0 ? "" : ` · ${plural(totals.unpriced, "answer")} without a price`;
  return `${count(totals.input)} input (${count(totals.cacheRead)} from cache) · ${count(totals.output)} output (${count(totals.reasoning)} reasoning) · ${plural(totals.answers, "answer")}\n\nEstimated cost ${dollars(totals.cost)}${unpriced}`;
}

/** The first day of the period of `at`, a time in milliseconds, as `YYYY-MM-DD`, or `YYYY-MM` for a month. */
function periodOf(at: number, period: number): string {
  const date = new Date(at);
  if (period === 1) date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return period === 2 ? month : `${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Every saved event of the session `id`, in order. */
async function allEvents(sessions: Sessions, id: string): Promise<Frozen<StoredEvent>[]> {
  const events: Frozen<StoredEvent>[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await sessions.events(
      id,
      before === undefined ? { limit: EVENTS_PAGE } : { before, limit: EVENTS_PAGE },
    );
    events.unshift(...page);
    if (page.length < EVENTS_PAGE || page[0] === undefined) return events;
    before = page[0].seq;
  }
}

export function apply(ctx: PluginContext): undefined {
  const tui = ctx.get("tui");
  if (tui === undefined) return;
  const sessions = ctx.get("sessions");
  const chat = ctx.get("chat");
  // The usage of each session at its last update, so a second open reads only the changed sessions.
  const cache = new Map<string, { readonly updatedAt: number; readonly usage: SessionUsage }>();

  /** The sessions of the scope, with their children at each depth. */
  const rowsOf = async (folder: string | undefined): Promise<{ row: SessionRow; child: boolean }[]> => {
    const rows: { row: SessionRow; child: boolean }[] = [];
    const walk = async (parent: string | undefined): Promise<void> => {
      let cursor: string | undefined;
      do {
        const page = await sessions.list({
          limit: 100,
          ...(parent === undefined ? (folder === undefined ? {} : { folder }) : { parent }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const row of page.sessions) {
          rows.push({ row, child: parent !== undefined });
          await walk(row.sessionId);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    };
    await walk(undefined);
    return rows;
  };

  tui.commands.add({
    name: "open",
    description: "Show the token usage and the estimated cost of the saved sessions",
    slash: "usage",
    run: async () => {
      const pane = tui.panes.activePane;
      const id = pane === undefined ? undefined : chat.sessionIdOf(pane.view);
      const folder = id === undefined ? tui.startup.folder : (await sessions.get(id)).folder;
      await show(folder);
    },
  });

  const show = async (folder: string): Promise<void> => {
    let tab = 0;
    let period = 0;
    let all = true;
    let busy = false;
    let chats: Chat[] = [];
    const text = new TextView({ document: { id: "usage", items: [] } });
    const picker = new Picker<Chat>({
      items: [],
      id: (item) => item.row.sessionId,
      label: (item) => `${item.child ? "↳ " : ""}${item.row.title ?? "(no title)"}`,
      detail: (item) =>
        `${count(item.usage.totals.input + item.usage.totals.output)} tokens · ${dollars(item.usage.totals.cost)}`,
      onChoose: (item) => {
        dialog.close();
        chat.show(item.row.sessionId).catch((error: unknown) => ctx.notify("error", String(error)));
      },
      onCancel: () => dialog.close(),
    });

    const render = (): void => {
      const totals = emptyTotals();
      const models = new Map<string, Totals>();
      const tools = new Map<string, ToolCount>();
      const periods = new Map<string, Totals>();
      for (const item of chats) {
        addTotals(totals, item.usage.totals);
        for (const [name, value] of item.usage.models) {
          const into = models.get(name) ?? emptyTotals();
          addTotals(into, value);
          models.set(name, into);
        }
        for (const [name, value] of item.usage.tools) {
          const into = tools.get(name) ?? { calls: 0, errors: 0 };
          into.calls += value.calls;
          into.errors += value.errors;
          tools.set(name, into);
        }
        const key = periodOf(item.row.updatedAt, period);
        const into = periods.get(key) ?? emptyTotals();
        addTotals(into, item.usage.totals);
        periods.set(key, into);
      }
      const byCost = (entries: Iterable<[string, Totals]>) =>
        [...entries].sort((first, second) => second[1].cost - first[1].cost || second[1].output - first[1].output);
      let body: string;
      if (tab === 0) {
        const children = chats.filter((item) => item.child).length;
        body = `${totalsText(totals)}\n\n${plural(chats.length - children, "chat")} · ${plural(children, "subagent")}`;
      } else if (tab === 1) {
        const rows = [...periods].sort((first, second) => (first[0] < second[0] ? 1 : -1));
        body = `Each chat counts in the ${PERIODS[period]?.toLowerCase()} of its last activity.\n\n| ${PERIODS[period]} | Input | Output | Estimated cost |\n| --- | ---: | ---: | ---: |\n${rows.map(([key, value]) => `| ${key} | ${count(value.input)} | ${count(value.output)} | ${dollars(value.cost)} |`).join("\n")}`;
      } else if (tab === 2) {
        body = byCost(models)
          .map(([name, value]) => `## ${name}\n${totalsText(value)}`)
          .join("\n\n");
      } else {
        const rows = [...tools].sort((first, second) => second[1].calls - first[1].calls);
        body = `| Tool | Calls | Errors |\n| --- | ---: | ---: |\n${rows.map(([name, value]) => `| ${name} | ${count(value.calls)} | ${count(value.errors)} |`).join("\n")}`;
      }
      const markdown = new Markdown(`# ${TABS[tab]}\n\n${body}`);
      text.setDocument({
        id: "usage",
        items: [
          {
            id: `${tab}:${period}`,
            sections: [
              {
                id: "text",
                kind: "text",
                text: markdown.source(),
                render: (width) => markdown.rows(Math.max(1, width)),
              },
            ],
          },
        ],
      });
      text.scroll.scrollTo(0);
      picker.setItems(
        tab === 4
          ? [...chats].sort(
              (first, second) =>
                second.usage.totals.cost - first.usage.totals.cost ||
                second.usage.totals.output - first.usage.totals.output,
            )
          : [],
      );
      tui.requestFrame();
    };

    const load = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const catalog = await ctx.get("catalog").list({ all: true });
        const prices: Prices = new Map(
          catalog.providers.flatMap((provider) =>
            provider.models.map((model) => [`${provider.id}/${model.id}`, model.cost] as const),
          ),
        );
        const loaded: Chat[] = [];
        for (const { row, child } of await rowsOf(all ? undefined : folder)) {
          if (dialog.signal.aborted) return;
          const cached = cache.get(row.sessionId);
          let usage = cached?.updatedAt === row.updatedAt ? cached.usage : undefined;
          if (usage === undefined) {
            usage = tally(await allEvents(sessions, row.sessionId), prices);
            cache.set(row.sessionId, { updatedAt: row.updatedAt, usage });
          }
          loaded.push({ row, usage, child });
        }
        chats = loaded;
        render();
      } finally {
        busy = false;
      }
    };
    const failed = (error: unknown): void => ctx.notify("error", String(error));
    const choose = (index: number): void => {
      tab = index;
      render();
      tui.focus(tab === 4 ? picker : text);
    };

    const dialog = tui.dialog({
      title: () => `Usage · ${all ? "every folder" : folder}${busy ? " · reading…" : ""}`,
      body: {
        ...stack("column", [
          { view: text, size: (size) => (tab === 4 ? 0 : size.height) },
          { view: picker, size: (size) => (tab === 4 ? size.height : 0) },
        ]),
        initialFocus: text,
      },
      scroll: text.scroll,
      rows: Math.max(10, tui.size.height - 2),
      keys: [
        { key: "tab", label: "next view", run: () => choose((tab + 1) % TABS.length) },
        {
          key: "p",
          label: "period",
          when: () => tab === 1,
          run: () => {
            period = (period + 1) % PERIODS.length;
            render();
          },
        },
        ...([true, false] as const).map((scope) => ({
          key: "f",
          label: scope ? "every folder" : "this folder",
          when: () => !busy && all !== scope,
          run: () => {
            all = scope;
            void load().catch(failed);
          },
        })),
        {
          key: "ctrl+r",
          label: "refresh",
          when: () => !busy,
          run: () => {
            void load().catch(failed);
          },
        },
      ],
    });
    text.setDocument({
      id: "usage",
      items: [{ id: "reading", sections: [{ id: "text", kind: "text", text: "Reading the sessions…" }] }],
    });
    await load();
  };
  return undefined;
}
