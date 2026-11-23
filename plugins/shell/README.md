# shell

Run commands of the user from the composer, and let the model ask for a root command.

## `!command`

A draft that starts with `!` runs as a command at Enter. The command runs with `/bin/sh -c` in the folder of the
session. A dialog shows its output while it runs. `ctrl+c` stops the command, and `esc` closes the dialog.

At the end, the plugin saves the command and its output (the last 48,000 characters) in the session. The model reads
them at its next turn. The save starts no turn. In a pane without a session, the plugin saves nothing.

## `!sudo command`

`!sudo command` runs one command as root. The plugin shows each argument and asks for approval, then for the password
in a masked field. The words after `sudo` are literal arguments: quotes group a word, and a shell operator or an
expansion outside quotes is an error. For a root script, name the shell: `!sudo sh -c 'apt update && apt upgrade'`.

## The tool `sudo_command`

The model gives the executable and the arguments as a list, and a reason. The user approves the command, then types
the password. After the attempts of sudo end, the call ends. The model reads the output.

## The password

The plugin runs `sudo -A -k`. sudo asks for the password through an askpass program in a private folder, only when
it needs one, and again after a wrong one. The password goes through a FIFO to that program: never to disk, never to
the arguments or the environment of a program, and never to the command, which gets no stdin. `-k` makes sudo ignore
the cached credential and keep none, so no other sudo of yuke runs with this password. The plugin keeps no password.
