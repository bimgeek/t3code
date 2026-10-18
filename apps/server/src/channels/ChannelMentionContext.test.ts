import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { describe, expect, it } from "vite-plus/test";
import { CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT, mentionWithContext } from "./ChannelInbound.ts";

const slack = createSlackAdapter({
  mode: "socket",
  botToken: "xoxb-test",
  appToken: "xapp-test",
});

const slackMessage = (ts: string, user: string, text: string, fileName?: string) =>
  slack.parseMessage({
    type: "message",
    channel: "C1",
    ts,
    thread_ts: "1710000000.000001",
    user,
    text,
    ...(fileName
      ? {
          files: [
            {
              id: fileName,
              name: fileName,
              mimetype: "image/png",
              size: 8,
              url_private: `https://files.slack.com/files-pri/T1-F1/${fileName}`,
            },
          ],
        }
      : {}),
  } satisfies SlackEvent);

const mentionOf = async (recentMessages: ReadonlyArray<ReturnType<typeof slackMessage>>) => {
  const mention = recentMessages.find((message) => message.text.startsWith("@U0AKERU"));

  if (!mention) throw new Error("Expected a mention.");

  const inbound = await mentionWithContext(
    {
      id: "slack:C1:1710000000.000001",
      recentMessages: [...recentMessages],
      refresh: async () => undefined,
    },
    mention,
  );

  return {
    lines: inbound.text.split("\n"),
    contextLength: inbound.text.length - mention.text.length - 1,
    files: inbound.attachments.map((attachment) => attachment.name),
  };
};

const OLDER_LINE = "U1: [shared old.png]";

const newerLineOf = (length: number) => `U2: ${"x".repeat(length - 4)}`;

describe("mention context", () => {
  it("drops an older file whose marker no longer fits beside a newer long line", async () => {
    const newerLine = newerLineOf(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT - 10);

    const context = await mentionOf([
      slackMessage("1710000000.000002", "U1", "", "old.png"),
      slackMessage("1710000000.000003", "U2", newerLine.slice(4)),
      slackMessage("1710000000.000004", "U3", "<@U0AKERU> what changed?", "mine.png"),
    ]);

    expect(context.lines).toEqual([" old.png]", newerLine, "@U0AKERU what changed?"]);
    expect(context.contextLength).toBe(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);
    expect(context.files).toEqual(["mine.png"]);
  });

  it("keeps an older file whose line fits exactly within the limit", async () => {
    const newerLine = newerLineOf(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT - OLDER_LINE.length - 1);

    const context = await mentionOf([
      slackMessage("1710000000.000002", "U1", "", "old.png"),
      slackMessage("1710000000.000003", "U2", newerLine.slice(4)),
      slackMessage("1710000000.000004", "U3", "<@U0AKERU> what changed?", "mine.png"),
    ]);

    expect(context.lines).toEqual([OLDER_LINE, newerLine, "@U0AKERU what changed?"]);
    expect(context.contextLength).toBe(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);
    expect(context.files).toEqual(["mine.png", "old.png"]);
  });

  it("leaves out messages sent after the mention", async () => {
    const context = await mentionOf([
      slackMessage("1710000000.000002", "U1", "before", "before.png"),
      slackMessage("1710000000.000003", "U3", "<@U0AKERU> what changed?"),
      slackMessage("1710000000.000004", "U2", "after", "after.png"),
    ]);

    expect(context.lines).toEqual(["U1: before [shared before.png]", "@U0AKERU what changed?"]);
    expect(context.files).toEqual(["before.png"]);
  });

  it("leaves out later messages when the thread history no longer holds the mention", async () => {
    const mention = slackMessage("1710000000.100000", "U3", "<@U0AKERU> what changed?");

    const inbound = await mentionWithContext(
      {
        id: "slack:C1:1710000000.000001",
        recentMessages: [
          slackMessage("1710000000.000002", "U1", "before"),
          slackMessage("1710000000.200000", "U2", "after", "after.png"),
        ],
        refresh: async () => undefined,
      },
      mention,
    );

    expect(inbound.text).toBe("U1: before\n@U0AKERU what changed?");
    expect(inbound.attachments).toEqual([]);
  });
});
