/**
 * Factory's droid: one append-only JSONL file per session under `~/.factory/sessions`,
 * in a folder named after the directory the session runs in with every separator a dash
 * (`/root/proj` → `-root-proj`). The session is the one herdr's own droid integration
 * reports on the pane (`agent_session`, source `herdr:droid`): a file nothing names is
 * never guessed from the folder's contents, so two droid sessions in one directory never
 * take each other's chat. Captured live from droid 2026-10-19.
 *
 * Records: `session_start`, `message`, `todo_state`, `agent_turn_outcome`,
 * `compaction_state`. A message's content blocks are Anthropic's: `text`, `thinking`,
 * `tool_use` (id/name/input) and `tool_result` (tool_use_id/is_error/content) — the
 * pi-family parser reads none of the last two, so this file parses droid's own shape.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { MAX_TURNS, record, resultText, toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

type Row = Record<string, unknown>;

/** The session id herdr reports for this pane; null when it reports none. */
export function droidSessionId(pane: HerdrPane): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "droid" || session.kind !== "id" || typeof session.value !== "string") return null;
  const id = session.value.trim();
  return id.length > 0 ? id : null;
}

/** `HERDR_WEB_DROID_SESSIONS` overrules the store (`~/…` is the home directory). */
export function droidSessionsDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["HERDR_WEB_DROID_SESSIONS"];
  if (configured !== undefined && configured.trim().length > 0) {
    const path = configured.trim();
    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  }
  return join(homedir(), ".factory", "sessions");
}

/** droid names a session's folder after the directory it runs in, every separator a dash. */
export function droidSessionFolder(cwd: string): string {
  return cwd.replace(/[\\/]/g, "-");
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** A sessions directory with more folders than this is searched no further. */
const MAX_SESSION_FOLDERS = 512;

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * The transcript herdr's session id names: `<sessions>/<folder>/<id>.jsonl`, where droid
 * writes it. A droid that keeps its store elsewhere is found by one bounded search under
 * the sessions directory; a session file nothing names is never a conversation.
 */
export function droidTranscriptPath(sessionId: string, cwd: string, sessionsDir = droidSessionsDir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const direct = join(sessionsDir, droidSessionFolder(cwd), `${sessionId}.jsonl`);
  if (isFile(direct)) return direct;
  const flat = join(sessionsDir, `${sessionId}.jsonl`);
  if (isFile(flat)) return flat;
  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries.slice(0, MAX_SESSION_FOLDERS)) {
      if (!entry.isDirectory()) continue;
      const found = join(sessionsDir, entry.name, `${sessionId}.jsonl`);
      if (isFile(found)) return found;
    }
  } catch { /* no store here: the caller reports the pane's chat as unreadable */ }
  return null;
}

/** What the runtime put in the user's seat, not what the person typed. */
const INJECTED = /^\s*<system-reminder>/;

/** The text a user message shows: droid's own reminders say nothing of the conversation. */
function droidPromptText(message: Row): string | null {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.map((value) => {
    const block = record(value);
    return block.type === "text" && typeof block.text === "string" && !INJECTED.test(block.text) ? block.text : "";
  }).filter((part) => part.length > 0).join("\n");
  return text.length > 0 ? text : null;
}

const timestamp = (entry: Row): string | null => typeof entry.timestamp === "string" ? entry.timestamp : null;

/**
 * Does this line open a turn? Pages start at such lines, so a page never splits a turn:
 * a message the person typed, and nothing droid injected around it. A message only the
 * runtime wrote (`visibility`: a cancellation, a timeout) is a notice of its own and
 * still opens one, so it never lands in the middle of an assistant's work block.
 */
export function droidOpensTurn(value: unknown): boolean {
  const entry = record(value);
  if (entry.type !== "message") return false;
  const message = record(entry.message);
  return message.role === "user" && droidPromptText(message) !== null;
}

/** One tool call's answer out of a droid message record; null when the record holds none. */
export function droidResultText(value: unknown, ref: string): string | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.role !== "user" || !Array.isArray(message.content)) return null;
  for (const block of message.content) {
    const result = record(block);
    if (result.type === "tool_result" && result.tool_use_id === ref) return resultText(result.content);
  }
  return null;
}

/**
 * Splits one droid session file into turns. Adjacent assistant messages merge, `tool_use`
 * blocks adopt the answer of the `tool_result` that names them, and thinking stays private
 * to the agent. An `agent_turn_outcome` ends the turn: the assistant work after it was
 * woken by something nobody typed, and folding it into the answer above buried that answer.
 */
export function parseDroidTranscript(text: string, maxTurns = MAX_TURNS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by tool_use id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  let settled = false;

  const assistantTurn = (ts: string | null): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !settled) return last;
    const turn: ConversationTurn = { role: "assistant", ts, parts: [] };
    turns.push(turn);
    return turn;
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Row;
    try { entry = record(JSON.parse(line)); } catch { continue; } // a torn tail line while droid appends
    if (entry.type === "compaction_state") {
      // all the file keeps of what came before it: a card, the way pi's own fold is drawn
      const summary = typeof entry.summaryText === "string" ? entry.summaryText.trim() : "";
      pending.clear();
      settled = true;
      if (summary.length > 0) turns.push({ role: "user", ts: timestamp(entry), parts: [{ kind: "compact", text: summary }] });
      continue;
    }
    if (entry.type === "agent_turn_outcome") { settled = true; continue; }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    const ts = timestamp(entry);
    if (message.role === "user") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const value of blocks) {
        const block = record(value);
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = pending.get(block.tool_use_id);
        if (!tool) continue;
        pending.delete(block.tool_use_id);
        trimOutput(tool, resultText(block.content), block.tool_use_id);
        if (block.is_error === true) tool.error = true;
      }
      const prompt = droidPromptText(message);
      if (prompt === null) continue; // results and injected context open no turn of their own
      // a message only the runtime wrote is a notice in the user's seat, not a prompt
      if (typeof message.visibility === "string") { turns.push({ role: "user", ts, parts: [{ kind: "notice", text: prompt }] }); continue; }
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] });
      settled = false;
      continue;
    }
    if (message.role !== "assistant") continue;
    const turn = assistantTurn(ts);
    if (ts !== null) turn.end_ts = ts;
    for (const value of Array.isArray(message.content) ? message.content : []) {
      const block = record(value);
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        turn.parts.push({ kind: "text", text: block.text });
      } else if (block.type === "thinking") {
        const thinking = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
        if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const input: Row = block.input !== null && typeof block.input === "object" && !Array.isArray(block.input) ? block.input as Row : {};
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool",
          name: block.name,
          summary: toolSummary(block.name, input).slice(0, 120),
          input: JSON.stringify(input, null, 2),
          output: "",
        };
        turn.parts.push(part);
        if (typeof block.id === "string") pending.set(block.id, part);
      }
      // unsupported transcript blocks are intentionally ignored
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}
