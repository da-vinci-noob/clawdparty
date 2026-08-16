import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
} from "../src/providers/contract.js";

// The representative narrative, shared by the fixture capture and the parity test.
//
// ONE definition on purpose. The capture generates `sample_run.jsonl` from this, and the
// parity test replays this and compares against that file — so they must tell the same
// story or the comparison comes out empty and passes as "nothing to compare", which is how
// it silently stopped asserting anything.
//
// A generated fixture cannot prove the harness CORRECT (it would be checking the harness
// against its own output). It can prove the harness STABLE: any unintended change to the
// durable type sequence shows up as a fixture diff that has to be regenerated on purpose.
// The correctness assertions live alongside it as properties the fixture cannot vouch for.

export const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  promptCaching: true,
  minCacheablePrefixTokens: 512,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

export const usage = () => ({
  input_tokens: 1250,
  output_tokens: 320,
  cache_read_input_tokens: 43_000,
  cache_creation_input_tokens: 0,
});

export function block(index: number, kind: "text" | "thinking", text: string): ProviderEvent[] {
  return [
    { t: "block_start", index, kind },
    kind === "text" ? { t: "text_delta", index, text } : { t: "thinking_delta", index, text },
    {
      t: "block_stop",
      index,
      block:
        kind === "text"
          ? { type: "text", text }
          : { type: "thinking", thinking: text, signature: "sig" },
    },
  ];
}

export const toolUse = (
  index: number,
  id: string,
  name: string,
  input: unknown,
): ProviderEvent[] => [{ t: "block_stop", index, block: { type: "tool_use", id, name, input } }];

/** The representative narrative: thinking, text, a write, a shell command, a follow-up. */
export const TURNS: ProviderEvent[][] = [
  [
    ...block(0, "thinking", "The note file does not exist yet, so I will create it."),
    ...block(1, "text", "I'll create the note and then check it."),
    ...toolUse(2, "toolu_write_01", "str_replace_based_edit_tool", {
      command: "create",
      path: "note.md",
      file_text: "# Note\n\nFirst line.\n",
    }),
    { t: "message_delta", stopReason: "tool_use", usage: usage() },
    { t: "message_stop" },
  ],
  [
    ...block(0, "thinking", "Now read it back to confirm."),
    ...toolUse(1, "toolu_bash_01", "bash", { command: "cat note.md" }),
    { t: "message_delta", stopReason: "tool_use", usage: usage() },
    { t: "message_stop" },
  ],
  [
    ...block(0, "thinking", "Try editing a file that is not there, to show the failure path."),
    ...toolUse(1, "toolu_write_02", "str_replace_based_edit_tool", {
      command: "str_replace",
      path: "missing.md",
      old_str: "a",
      new_str: "b",
    }),
    { t: "message_delta", stopReason: "tool_use", usage: usage() },
    { t: "message_stop" },
  ],
  [
    ...block(0, "text", "Created note.md with a first line, and confirmed its contents."),
    { t: "message_delta", stopReason: "end_turn", usage: usage() },
    { t: "message_stop" },
  ],
];

export class ScriptedAdapter implements ProviderAdapter {
  readonly id = "anthropic-direct";
  readonly displayName = "Anthropic";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "capture",
  };
  #at = 0;
  async probe(): Promise<ProbeResult> {
    return { available: true, credentialSource: "file:~/.claude/.credentials.json" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "claude-opus-5", displayName: "Claude Opus 5", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }
  async *stream(): AsyncIterable<ProviderEvent> {
    for (const event of TURNS[this.#at++] ?? []) yield event;
  }
}
