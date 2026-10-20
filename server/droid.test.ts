import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneConversation, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { droidOpensTurn, droidResultText, droidSessionFolder, droidSessionId, droidSessionsDir, droidTranscriptPath, parseDroidTranscript } from "./droid.ts";
import * as herdr from "./herdr/client.ts";
import { launchedAgents } from "./launched-agents.ts";
import type { ConversationPart, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

const SESSION = "57c7dab0-6e84-4702-bd0d-520e5d276d1b";
const TS = "2026-10-19T12:00:00.000Z";
const line = (entry: object): string => JSON.stringify({ timestamp: TS, ...entry }) + "\n";
const prompt = (text: string): string => line({ type: "message", id: `u-${text}`, message: { role: "user", content: [{ type: "text", text }] } });
const injected = (text: string, visibility = "user_only"): string => line({ type: "message", message: { role: "user", content: [{ type: "text", text }], visibility } });
const toolResult = (id: string, output: string | object[], error = false): string => line({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: output }] } });
const answer = (...blocks: object[]): string => line({ type: "message", message: { role: "assistant", content: blocks } });
const toolUse = (id: string, name = "Bash", input: object = { command: "ls" }): object => ({ type: "tool_use", id, name, input });
const outcome = (): string => JSON.stringify({ type: "agent_turn_outcome", turnId: "turn-1", reason: "completed", resultKind: "text" }) + "\n";
const compaction = (summary: string): string => line({ type: "compaction_state", summaryText: summary });
type Tool = Extract<ConversationPart, { kind: "tool" }>;
const toolOf = (turns: ConversationTurn[]): Tool => turns.flatMap((turn) => turn.parts).find((part): part is Tool => part.kind === "tool")!;

let root: string;
let sessions: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-droid-unit-"));
  sessions = join(root, "sessions");
  mkdirSync(join(sessions, "-root-proj"), { recursive: true });
  forgetTranscriptState();
});
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });

/** Fictional droid records, shaped like the ones its CLI writes. */
const writeSession = (folder = "-root-proj", body = prompt("hello") + answer({ type: "text", text: "fictional answer" }) + outcome()): string => {
  const path = join(sessions, folder, `${SESSION}.jsonl`);
  mkdirSync(join(sessions, folder), { recursive: true });
  writeFileSync(path, body);
  return path;
};

const pane = (session: unknown, cwd = "/root/proj"): HerdrPane => ({
  pane_id: "w9:p1", cwd, foreground_cwd: cwd, agent: "droid",
  agent_session: session === undefined ? undefined : { source: "herdr:droid", agent: "droid", kind: "id", value: session } as HerdrPane["agent_session"],
} as HerdrPane);

describe("droid store", () => {
  test("takes the session id only from herdr's own record", () => {
    expect(droidSessionId(pane(SESSION))).toBe(SESSION);
    expect(droidSessionId(pane({ source: "herdr:droid", agent: "droid", kind: "path", value: SESSION }))).toBeNull();
    expect(droidSessionId(pane(undefined))).toBeNull();
    expect(droidSessionId(pane({ source: "herdr:claude", agent: "claude", kind: "id", value: SESSION }))).toBeNull();
    expect(droidSessionId(pane({ source: "herdr:droid", agent: "droid", kind: "id", value: " " }))).toBeNull();
  });

  test("names a session's folder after its directory, every separator a dash", () => {
    expect(droidSessionFolder("/root/proj")).toBe("-root-proj");
    expect(droidSessionFolder("/")).toBe("-");
    expect(droidSessionFolder("C:\\work\\app")).toBe("C:-work-app");
  });

  test("reads the store from HERDR_WEB_DROID_SESSIONS, which may name the home", () => {
    expect(droidSessionsDir({ HERDR_WEB_DROID_SESSIONS: "/srv/droid" } as NodeJS.ProcessEnv)).toBe("/srv/droid");
    expect(droidSessionsDir({ HERDR_WEB_DROID_SESSIONS: "~/droid" } as NodeJS.ProcessEnv)).toBe(join(homedir(), "droid"));
    expect(droidSessionsDir({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".factory", "sessions"));
  });

  test("resolves herdr's session id to its transcript, never by guessing a session", () => {
    const path = writeSession();
    expect(droidTranscriptPath(SESSION, "/root/proj", sessions)).toBe(path);
    // a droid that kept its store in another folder is found by one bounded search
    mkdirSync(join(sessions, "-elsewhere"), { recursive: true });
    expect(droidTranscriptPath("c2bb0e39-93f0-4330-b7db-50f3e27de4ca", "/root", sessions)).toBeNull();
    writeFileSync(join(sessions, "-elsewhere", "c2bb0e39-93f0-4330-b7db-50f3e27de4ca.jsonl"), prompt("other"));
    expect(droidTranscriptPath("c2bb0e39-93f0-4330-b7db-50f3e27de4ca", "/root", sessions)).toBe(join(sessions, "-elsewhere", "c2bb0e39-93f0-4330-b7db-50f3e27de4ca.jsonl"));
    // nothing under the store is a conversation: a session only the folder names is another's
    expect(droidTranscriptPath("00000000-0000-0000-0000-000000000000", "/root/proj", sessions)).toBeNull();
    expect(droidTranscriptPath("../../etc/passwd", "/root/proj", sessions)).toBeNull();
  });
});

describe("droid transcript", () => {
  test("shows what the person typed and what the agent answered, thinking folded away", () => {
    const turns = parseDroidTranscript(prompt("hello") + answer({ type: "thinking", thinking: "fictional reasoning" }, { type: "text", text: "fictional answer" }));
    expect(turns).toEqual([
      { role: "user", ts: TS, parts: [{ kind: "text", text: "hello" }] },
      { role: "assistant", ts: TS, end_ts: TS, parts: [{ kind: "thinking", text: "fictional reasoning" }, { kind: "text", text: "fictional answer" }] },
    ]);
  });

  test("keeps droid's own reminders out of the conversation", () => {
    const turns = parseDroidTranscript(injected("<system-reminder>\nUnified tool catalog…\n</system-reminder>") + prompt("stuck?") + injected("The AI model timed out. Please retry or switch models with /model."));
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "stuck?" }],
      [{ kind: "notice", text: "The AI model timed out. Please retry or switch models with /model." }],
    ]);
  });

  test("pairs a tool call with the result that names it, and cuts a long one", () => {
    const long = "x".repeat(5000);
    const turns = parseDroidTranscript(
      prompt("list it")
      + answer(toolUse("call-1"), { type: "text", text: "listing" })
      + answer(toolUse("call-2", "Read"))
      + toolResult("call-1", long)
      + toolResult("call-2", [{ type: "text", text: "fictional file" }])
      + toolResult("call-unknown", "lost"),
    );
    const [call1, call2] = turns.flatMap((turn) => turn.parts).filter((part): part is Tool => part.kind === "tool");
    expect(call1!.output).toBe(`${"x".repeat(4000)}\n… trimmed`);
    expect(call1!.output_ref).toBe("call-1");
    expect(call1!.output_size).toBe(5000);
    expect(JSON.parse(call2!.input)).toEqual({ command: "ls" });
    expect(call2!.output).toBe("fictional file");
    // a tool call no result ever names keeps its place rather than an answer it never had
    expect(parseDroidTranscript(prompt("list it") + answer(toolUse("call-9"))).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool")).toHaveLength(1);
  });

  test("marks a failed tool call", () => {
    const turns = parseDroidTranscript(prompt("run it") + answer(toolUse("call-1")) + toolResult("call-1", "command not found", true));
    expect(toolOf(turns)).toMatchObject({ error: true, output: "command not found" });
  });

  test("a runtime message and an ended turn never join the answer around them", () => {
    const turns = parseDroidTranscript(
      prompt("continue")
      + answer({ type: "text", text: "first answer" })
      + injected("Request cancelled by user", "llm_only")
      + outcome()
      + answer({ type: "text", text: "a later wake's answer" }),
    );
    expect(turns.map((turn) => [turn.role, turn.parts])).toEqual([
      ["user", [{ kind: "text", text: "continue" }]],
      ["assistant", [{ kind: "text", text: "first answer" }]],
      ["user", [{ kind: "notice", text: "Request cancelled by user" }]],
      ["assistant", [{ kind: "text", text: "a later wake's answer" }]],
    ]);
  });

  test("a compaction is a card of its own and takes the calls before it with it", () => {
    const turns = parseDroidTranscript(prompt("go on") + answer(toolUse("call-1")) + compaction("what came before, in a line") + toolResult("call-1", "late"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool"]],
      ["user", ["compact"]],
    ]);
    // the answer to a call from before the fold belongs to what the summary sums up, not to the chat after it
    expect(toolOf(turns).output).toBe("");
    expect(turns.at(-1)!.parts).toEqual([{ kind: "compact", text: "what came before, in a line" }]);
  });

  test("a torn tail line is skipped, not an answer lost", () => {
    expect(parseDroidTranscript(prompt("hello") + '{"type":"message","id":"torn')).toHaveLength(1);
  });

  test("opens a turn on a prompt and on a runtime message, never on droid's own context", () => {
    expect(droidOpensTurn(JSON.parse(prompt("hello")))).toBe(true);
    expect(droidOpensTurn(JSON.parse(injected("Request cancelled by user", "llm_only")))).toBe(true);
    expect(droidOpensTurn(JSON.parse(injected("<system-reminder>\nUnified tool catalog…</system-reminder>")))).toBe(false);
    expect(droidOpensTurn(JSON.parse(toolResult("call-1", "output")))).toBe(false);
    expect(droidOpensTurn(JSON.parse(outcome()))).toBe(false);
    expect(droidOpensTurn("not json")).toBe(false);
  });

  test("reads one tool call's whole answer out of the file, by its id", () => {
    const file = prompt("list it") + answer(toolUse("call-1")) + toolResult("call-1", "whole output");
    expect(droidResultText(JSON.parse(toolResult("call-1", "whole output")), "call-1")).toBe("whole output");
    expect(droidResultText(JSON.parse(prompt("list it")), "call-1")).toBeNull();
    const path = writeSession("-root-proj", file);
    expect(transcriptToolOutput("droid-transcript", path, "call-1")).toBe("whole output");
    expect(transcriptToolOutput("droid-transcript", path, "call-9")).toBeNull();
  });
});

describe("a pane running droid", () => {
  let panes: HerdrPane[] = [];
  const restores: Array<() => void> = [];
  beforeEach(() => {
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method !== "pane.process_info") throw new Error(`unexpected droid fixture RPC: ${method}`);
      return { process_info: { foreground_processes: [] } } as never;
    });
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes } as SessionSnapshot));
    restores.push(() => rpc.mockRestore(), () => snapshot.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    panes = [];
    forgetTranscriptState();
  });

  test("reads the session herdr names, from the store the server was pointed at", async () => {
    const path = writeSession("-root-proj", prompt("hello") + answer({ type: "text", text: "fictional answer" }));
    panes = [pane(SESSION)];
    const read = () => paneConversation("w9:p1", undefined, {}, undefined, undefined, undefined, undefined, sessions);
    const first = await read();
    expect(first.source).toBe("droid-transcript");
    expect(first.turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "hello" }],
      [{ kind: "text", text: "fictional answer" }],
    ]);
    // an unchanged poll answers the same version, so a chat can hold it with a 304
    expect((await read()).version).toBe(first.version);
    appendFileSync(path, prompt("and again"));
    expect((await read()).version).not.toBe(first.version);
  });

  test("stays unreadable when herdr names no session or the store holds no such file", async () => {
    panes = [pane(SESSION)];
    const read = () => paneConversation("w9:p1", undefined, {}, undefined, undefined, undefined, undefined, sessions);
    await expect(read()).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_path" });
    writeSession("-elsewhere", prompt("another session"));
    expect((await read()).turns).toHaveLength(1);

    panes = [{ ...pane(SESSION), agent_session: undefined } as HerdrPane];
    await expect(read()).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  test("a droid this server started has a conversation not begun until droid writes one", async () => {
    panes = [pane(SESSION)];
    launchedAgents.launched("w9:p1", "droid");
    const read = () => paneConversation("w9:p1", undefined, {}, undefined, undefined, undefined, undefined, sessions);
    // no session file yet: the pane the launch itself speaks for, not the terminal's text
    const unbegun = await read();
    expect(unbegun.source).toBe("droid-transcript");
    expect(unbegun.turns).toEqual([]);
    expect(unbegun.history_id).toMatch(/^unwritten:launch:w9:p1:/);
    // droid wrote its first turn: the launch says nothing of the chat any more
    writeSession("-root-proj", prompt("hello") + answer({ type: "text", text: "fictional answer" }));
    expect((await read()).history_id).not.toMatch(/^unwritten:/);
  });
});

describe("droid conversation pages", () => {
  test("the newest page turns, its history id across an append and its version after one", () => {
    const path = writeSession("-root-proj", prompt("hello") + answer({ type: "text", text: "fictional answer" }));
    const first = transcriptPage("droid-transcript", path);
    expect(first.source).toBe("droid-transcript");
    expect(first.turns).toHaveLength(2);
    // the page holds the whole file: there is nothing before it to page back to
    expect(first.cursor).toBeNull();
    appendFileSync(path, prompt("and again") + answer({ type: "text", text: "second answer" }));
    const second = transcriptPage("droid-transcript", path);
    expect(second.history_id).toBe(first.history_id);
    expect(second.version).not.toBe(first.version);
    expect(second.turns.at(-2)).toMatchObject({ parts: [{ kind: "text", text: "and again" }] });
  });

  test("pages back from the start the newest page leaves behind", () => {
    // more prompts than one page holds: the newest starts later, and `before` walks back to it
    const body = Array.from({ length: 60 }, (_, index) => prompt(`prompt ${index}`) + answer({ type: "text", text: `answer ${index}` })).join("");
    const path = writeSession("-root-proj", body);
    const newest = transcriptPage("droid-transcript", path);
    expect(newest.cursor).not.toBeNull();
    expect(newest.turns[0]).toMatchObject({ parts: [{ kind: "text", text: "prompt 10" }] });
    const older = transcriptPage("droid-transcript", path, { before: newest.cursor! });
    expect(older.turns[0]).toMatchObject({ parts: [{ kind: "text", text: "prompt 0" }] });
    expect(older.turns.at(-2)).toMatchObject({ role: "user", parts: [{ kind: "text", text: "prompt 9" }] });
    expect(older.turns.at(-1)).toMatchObject({ role: "assistant", parts: [{ kind: "text", text: "answer 9" }] });
    expect(older.cursor).toBeNull();
  });

  test("a page never opens on droid's own context: the prompt before it comes along", () => {
    const path = writeSession("-root-proj", prompt("the prompt") + injected("<system-reminder>\nUnified tool catalog…</system-reminder>") + answer({ type: "text", text: "the answer" }));
    const page = transcriptPage("droid-transcript", path);
    expect(page.turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "the prompt" }],
      [{ kind: "text", text: "the answer" }],
    ]);
  });
});
