import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;
let calls: { method: string; params: Record<string, unknown> }[];
let screens: Record<string, string>;

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-omo-send-"));
  panes = {};
  calls = [];
  screens = {};
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string; target?: string } };
        calls.push({ method: request.method, params: (request.params ?? {}) as Record<string, unknown> });
        const id = request.params?.pane_id ?? request.params?.target ?? "";
        if (request.method === "agent.prompt" && !panes[id]?.agent) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "no agent" } })}\n`);
          return;
        }
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "pane.read" ? { read: { text: screens[id] ?? "" } }
          : request.method === "agent.prompt" || request.method === "pane.send_text" || request.method === "pane.send_keys" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const OMO_PROCESS = { pid: 2147483647, argv: ["omo"], cwd: "" };

// a Claude Code input box that holds a typed draft, as a detection read shows it
const DRAFT_SCREEN = ["", "\u2500".repeat(60), "\u276f an unsent draft", "\u2500".repeat(60), "  \u23f5\u23f5 auto mode on"].join("\r\n");

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

it("sends into a Claude-labelled omo pane without Claude's draft refusal, and still refuses a real Claude pane", async () => {
  screens["w:p1"] = DRAFT_SCREEN;
  screens["w:p2"] = DRAFT_SCREEN;
  // omo's claude-sdk child runs, so herdr labels the pane claude; the pane runs omo
  panes["w:p1"] = { agent: "claude", process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { agent: "claude", process: [{ pid: 2147483646, argv: ["/usr/bin/claude"], cwd: root }] };
  await submitter()("w:p1", "hello", "hello", Date.now());
  expect(calls.some((call) => call.method === "agent.prompt" && call.params.text === "hello")).toBeTrue();
  expect(calls.some((call) => call.method === "pane.read")).toBeFalse();
  calls.length = 0;
  const refused = await submitter()("w:p2", "hello", "hello", Date.now()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HerdrError);
  expect((refused as HerdrError).code).toBe("input_draft");
  expect(calls.some((call) => call.method === "agent.prompt")).toBeFalse();
});

it("pastes a multiline message into an unlabelled omo pane as one bracketed paste, and leaves another shell's bare", async () => {
  panes["w:p1"] = { process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { process: [{ pid: 2147483646, argv: ["/bin/bash"], cwd: root }] };
  const sent = async (paneId: string) => {
    calls.length = 0;
    await submitter()(paneId, "a\nb", "a\nb", Date.now());
    return calls.find((call) => call.method === "pane.send_text")?.params.text;
  };
  expect(await sent("w:p1")).toBe("\u001b[200~a\nb\u001b[201~");
  expect(await sent("w:p2")).toBe("a\nb");
});
