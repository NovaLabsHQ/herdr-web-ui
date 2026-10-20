# droid chat

The reader shows droid's user messages, assistant text and expandable tool rows in the
existing Chat view. Terminal remains the place for approvals, menus and commands. Reading
chat makes no model calls, and nothing is ever written to droid's store. Thinking folds
into the turn like every other agent's, and images are outside this scope.

**Supported store:** `~/.factory/sessions/<folder>/<id>.jsonl`, droid's own layout, with
`<folder>` the directory the session runs in and every separator a dash (`/root/proj` →
`-root-proj`). `HERDR_WEB_DROID_SESSIONS` points the bridge at another sessions directory
(an absolute path or `~/…`). Verified against droid writing that layout on 2026-10-19;
Windows and a droid that keeps its store elsewhere fall back to the terminal text unless
the store is named.

## Finding the active session

The session is the one **herdr's own droid integration** reports on the pane
(`agent_session`, source `herdr:droid`), so the chat follows the session droid is actually
in. Install the integration with `herdr integration install droid` if herdr names no
session for your droid panes. A pane herdr names no session for, a session file that is
gone, and a session id that appears in no folder of the store all use Terminal: the
folder's contents are never searched for a file that merely looks like the session, so two
droid sessions in one directory never take each other's chat. A store kept under a folder
the pane's cwd does not name is found by one bounded search under the sessions directory.

## What is read

A session file is append-only JSONL. The chat reads:

- `message` records with a `user` role: the prompt, as the turn's text;
- `message` records with an `assistant` role: `text` and `thinking` blocks, and `tool_use`
  blocks as tool rows whose answer is the `tool_result` naming their id (a failed one is
  marked). Adjacent assistant records merge into one turn;
- `compaction_state`: the summary it left, as the fold card an agent's `/compact` draws;
  the calls before it are part of what the summary sums up, so their late answers stay out;
- an `agent_turn_outcome` ends the turn: the assistant work after it was woken by
  something nobody typed, and shows as a turn of its own.

What droid put in the user's seat is not the conversation: a `<system-reminder>` block is
dropped, and a message droid records with a `visibility` (`Request cancelled by user`, a
model timeout) is drawn as a notice in the user's seat rather than as a prompt.

## What is not read

droid records no model or reasoning level in its session file, so the message box names
none rather than guessing one. Prompt cards, the slash-command menu and skill chips are
not offered for droid: answer what it asks in the terminal. A pane running droid without
herdr's integration, or on a store this bridge cannot find, keeps the terminal's text with
**Conversation unavailable — show terminal output**, as before.
