# skills

Load a skill by name. Yuke lists each skill in the prompt and lets the model choose. With this plugin, you choose.

```sh
yuke plugin add https://github.com/lostcoords/yuke-plugins skills
```

Run `/reload` while idle.

## Usage

Write `$` and the name of a skill in a message:

```text
$deploy ship the new release
```

The model gets the `SKILL.md` of each named skill with the message. The transcript shows the message as you wrote it.

- Type `$` in the composer to complete a skill name. The list shows the description of each skill.
- A `$name` in a code span, or written as `\$name`, stays text.
- An unknown name stays text.

The plugin finds skills where Yuke finds them: `.agents/skills` in the session folder, then `~/.agents/skills`. A skill
in the session folder hides a skill with the same name in the home folder. The plugin does not see the `skills` folders
of other plugins.

[MIT](../../LICENSE)
