import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const model = process.argv[2];
const withTools = process.argv[3] === "tools";

const client = new BedrockRuntimeClient({
  region: "us-west-2",
  credentials: fromIni({ profile: "claude-code-sso" }),
});

const input = {
  modelId: model,
  messages: [
    {
      role: "user",
      content: [
        {
          text: withTools
            ? "Read the file /tmp/a.txt using the read_file tool, then say done."
            : "In two short sentences, say what a git worktree is.",
        },
      ],
    },
  ],
  inferenceConfig: { maxTokens: 200 },
  ...(withTools
    ? {
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "read_file",
                description: "Read a file from disk",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                  },
                },
              },
            },
          ],
        },
      }
    : {}),
};

const res = await client.send(new ConverseStreamCommand(input));
const events = [];
for await (const event of res.stream ?? []) {
  events.push(event);
}
console.log(JSON.stringify(events, null, 2));
