import assert from "node:assert/strict";
import test from "node:test";
import { resolveMenu } from "../menu.js";

/** @param {string} name @param {string | null} desc @param {boolean} [available] */
function command(name, desc, available = true) {
  return { name, desc, available };
}

const core = [
  command("auth:login", "sign in to a provider"),
  command("model:pick", "choose the model for the next chat"),
  command("ui:palette", null),
  command("ui:sessions", "open a session"),
  command("quit", "leave yuke"),
];

test("defaults include commands even when the command has no description", () => {
  const menu = resolveMenu(core, null);
  assert.deepEqual(menu.rows.map((row) => row.command), ["auth:login", "model:pick", "ui:palette", "ui:sessions", "quit"]);
  assert.equal(menu.rows.find((row) => row.command === "ui:palette")?.label, "Commands");
  assert.equal(menu.rows.every((row) => row.key === null), true);
});

test("an actions list replaces the defaults and reports a missing command", () => {
  const menu = resolveMenu(core, {
    actions: [{ command: "quit", label: "Leave", key: "q" }, { command: "missing:thing", key: "m" }],
  });
  assert.deepEqual(menu.rows.map((row) => row.command), ["quit"]);
  assert.equal(menu.rows[0]?.label, "Leave");
  assert.deepEqual(menu.faults, ["missing:thing is not available"]);
});

test("a duplicate key keeps the later row and clears its key", () => {
  const menu = resolveMenu(core, {
    actions: [
      { command: "auth:login", key: "l" },
      { command: "model:pick", key: "l" },
    ],
  });
  assert.equal(menu.rows[0]?.key, "l");
  assert.equal(menu.rows[1]?.key, null);
  assert.deepEqual(menu.faults, ["Duplicate key l for model:pick"]);
});


