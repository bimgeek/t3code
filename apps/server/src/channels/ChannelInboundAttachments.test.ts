import {
  connectChannel,
  dispatchInboundChannelMessage,
  BOT_ID,
  PROJECT_ID,
  makeHarness,
  slackConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import * as NodeFS from "node:fs";
import { type SlackEvent } from "@chat-adapter/slack";
import { type OrchestrationCommand } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { resolveAttachmentPathById } from "../attachmentStore.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type SlackFile = NonNullable<SlackEvent["files"]>[number];

const pngFile: SlackFile = {
  id: "F1",
  name: "shot.png",
  mimetype: "image/png",
  size: PNG_BYTES.byteLength,
  url_private: "https://files.slack.com/files-pri/T1-F1/shot.png",
};

const zipFile: SlackFile = {
  id: "F2",
  name: "report.zip",
  mimetype: "application/zip",
  size: 2_048,
  url_private: "https://files.slack.com/files-pri/T1-F2/report.zip",
};

const connectSlack = Effect.gen(function* () {
  const harness = makeHarness({ startTransport: null });
  yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
  const { slackChat, slackAdapter } = externalAdapters;

  if (!slackChat || !slackAdapter) throw new Error("Expected the Slack Chat runtime.");

  const downloads: string[] = [];

  // Parses the event with the real Slack adapter and swaps only the network download.
  const deliver = (event: SlackEvent) => {
    const message = slackAdapter.parseMessage(event);

    for (const attachment of message.attachments) {
      attachment.fetchData = async () => {
        downloads.push(attachment.name ?? "");

        return Buffer.from(PNG_BYTES);
      };
    }

    return Effect.promise(() => slackChat.processMessage(slackAdapter, message.threadId, message));
  };

  const turns = () =>
    harness.commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );

  return { harness, deliver, downloads, turns };
});

const storedBytes = (attachmentsDir: string, attachmentId: string) => {
  const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });

  return path ? Uint8Array.from(NodeFS.readFileSync(path)) : null;
};

describe("files shared in channel messages", () => {
  it.effect("passes an image shared with a Slack mention to the bot", () =>
    Effect.gen(function* () {
      const { harness, deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "C123",
        ts: "1710000000.000001",
        user: "U1",
        text: "<@U-AKERU> what is in this screenshot?",
        files: [pngFile],
      });

      const [turn] = turns();
      const attachment = turn?.message.attachments[0];

      expect(turn?.message.text).toBe("<@U-AKERU> what is in this screenshot?");
      expect(turn?.message.attachments).toEqual([
        {
          type: "image",
          id: expect.stringMatching(new RegExp(`^${turn?.threadId}-[0-9a-f-]{36}$`)),
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ]);
      expect(storedBytes(harness.attachmentsDir, attachment?.id ?? "")).toEqual(PNG_BYTES);
    }),
  );

  it.effect("starts a turn for an image sent with no text", () =>
    Effect.gen(function* () {
      const { harness, deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000002",
        user: "U1",
        text: "",
        files: [pngFile],
      });

      const [turn] = turns();

      expect(turns()).toHaveLength(1);
      expect(turn?.message.text).toBe("");
      expect(turn?.message.attachments.map(({ id: _id, ...rest }) => rest)).toEqual([
        { type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 8 },
      ]);
      expect(storedBytes(harness.attachmentsDir, turn?.message.attachments[0]?.id ?? "")).toEqual(
        PNG_BYTES,
      );
    }),
  );

  it.effect("names an unsupported file to the bot without downloading it", () =>
    Effect.gen(function* () {
      const { deliver, downloads, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000003",
        user: "U1",
        text: "here are both",
        files: [zipFile, pngFile],
      });

      const [turn] = turns();

      expect(turn?.message.text).toBe(
        'here are both\n[Shared file "report.zip" was not attached: unsupported type application/zip]',
      );
      expect(turn?.message.attachments.map((attachment) => attachment.name)).toEqual(["shot.png"]);
      expect(downloads).toEqual(["shot.png"]);
    }),
  );

  it.effect("writes the same attachment when a message is delivered again", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      const inbound = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack" as const,
        externalThreadId: "slack:D123:1710000000.000004",
        externalMessageId: "1710000000.000004",
        text: "again",
        attachments: [
          {
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 8,
            fetch: async () => PNG_BYTES,
          },
        ],
      };

      yield* dispatchInboundChannelMessage(harness.dependencies, inbound);
      yield* dispatchInboundChannelMessage(harness.dependencies, inbound);

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      const [first, second] = turns.map((turn) => turn.message.attachments);

      expect(turns).toHaveLength(2);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      expect(NodeFS.readdirSync(harness.attachmentsDir)).toEqual([`${first?.[0]?.id}.png`]);
    }),
  );

  it.effect("names files it could not attach and still starts the turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      yield* dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "discord",
        externalThreadId: "discord:G1:C1:T1",
        externalMessageId: "discord-files-1",
        text: "",
        attachments: [
          {
            name: "broken.png",
            mimeType: "image/png",
            fetch: async () => {
              throw new Error("connection reset");
            },
          },
          { name: "linked.png", mimeType: "image/png", url: "https://cdn.example.com/linked.png" },
          { name: "huge.pdf", mimeType: "application/pdf", sizeBytes: 11 * 1024 * 1024 },
          { name: "notes.md", mimeType: "text/markdown", fetch: async () => new Uint8Array() },
          ...Array.from({ length: 5 }, (_, index) => ({
            name: `photo-${index + 5}.png`,
            mimeType: "image/png",
            fetch: async () => PNG_BYTES,
          })),
        ],
      });

      const turn = harness.commands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      );

      expect(turn?.message.text).toBe(
        [
          '[Shared file "broken.png" was not attached: download failed]',
          '[Shared file "linked.png" was not attached: no download available, https://cdn.example.com/linked.png]',
          '[Shared file "huge.pdf" was not attached: larger than 10 MB]',
          '[Shared file "notes.md" was not attached: the file is empty]',
          '[Shared file "photo-9.png" was not attached: more than 8 files in one message]',
        ].join("\n"),
      );
      expect(turn?.message.attachments.map((attachment) => attachment.name)).toEqual([
        "photo-5.png",
        "photo-6.png",
        "photo-7.png",
        "photo-8.png",
      ]);
    }),
  );
});
