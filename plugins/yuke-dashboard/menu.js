/** @typedef {{ name: string, desc: string | null, available: boolean }} CommandInfo */
/** @typedef {{ command: string, label?: string, key?: string }} ActionSpec */
/** @typedef {{ actions: ActionSpec[] | null }} DashboardSettings */
/** @typedef {{ command: string, label: string, key: string | null }} MenuRow */
/** @typedef {{ rows: MenuRow[], faults: string[] }} Menu */

export const DEFAULTS = Object.freeze([
  { command: "auth:login", label: "Sign in" },
  { command: "model:pick", label: "Choose a model" },
  { command: "ui:palette", label: "Commands" },
  { command: "ui:sessions", label: "Resume a session" },
  { command: "quit", label: "Quit Yuke" },
]);

/** Use the settings list when it exists. Otherwise show the defaults that are available. @param {CommandInfo[]} commands @param {DashboardSettings | null} settings @returns {Menu} */
export function resolveMenu(commands, settings) {
  const byName = new Map(commands.map((command) => [command.name, command]));
  /** @type {MenuRow[]} */
  const rows = [];
  /** @type {string[]} */
  const faults = [];
  const seen = new Set();
  const usedKeys = new Set();
  const source = settings?.actions || DEFAULTS;
  const required = settings?.actions != null;

  for (const action of source) {
    if (seen.has(action.command)) continue;
    const command = byName.get(action.command);
    if (!command?.available) {
      if (required) faults.push(action.command + " is not available");
      continue;
    }
    let key = action.key || null;
    if (key && usedKeys.has(key)) {
      faults.push("Duplicate key " + key + " for " + action.command);
      key = null;
    }
    if (key) usedKeys.add(key);
    seen.add(action.command);
    rows.push({ command: action.command, label: action.label || command.desc || action.command, key });
  }
  return { rows, faults };
}
