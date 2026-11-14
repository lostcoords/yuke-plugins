import type { TextEditor } from "yuke:tui";

/** The editing mode of a composer bound to Vim. */
export type Mode = "insert" | "normal" | "visual" | "visual-line";

/** Coordinate composer shortcuts with Vim. The service exists only in the terminal interface. */
export interface ComposerVim {
  /** Get the mode. A null editor gives an empty string. An unbound editor uses Insert mode. */
  mode: (editor: TextEditor | null) => Mode | "";
  /** Set the mode and cancel a pending command. An unbound editor stays unchanged. */
  setMode: (editor: TextEditor, mode: "insert" | "normal") => void;
  /** Cancel a pending command, end an Insert undo group, and leave Visual mode. The text stays unchanged. */
  cancel: (editor: TextEditor) => void;
  /** Return whether Vim waits for a count, register, operator, or motion continuation. */
  pending: (editor: TextEditor) => boolean;
  /** Observe mode changes. Call the returned disposer to stop. */
  onMode: (listener: (editor: TextEditor, mode: Mode) => void) => () => void;
}

declare module "yuke:plugins" {
  interface Services {
    readonly "composer-vim": ComposerVim | undefined;
  }
}
