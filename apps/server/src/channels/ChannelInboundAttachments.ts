import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type MessageId,
  type ThreadId,
} from "@akeru/contracts";
import { type Message } from "chat";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { deterministicAttachmentId } from "../attachmentStore.ts";
import {
  type ChannelRuntimeContext,
  type InboundChannelAttachment,
} from "./ChannelRuntimeTypes.ts";

const ATTACHMENT_NAME_MAX_CHARS = 255;

export const inboundAttachments = (message: Message): ReadonlyArray<InboundChannelAttachment> =>
  message.attachments.map((attachment) => {
    const fetchData = attachment.fetchData;

    return {
      name:
        (attachment.name ?? "").trim().slice(0, ATTACHMENT_NAME_MAX_CHARS).trim() ||
        attachment.type,
      mimeType: attachment.mimeType ?? "",
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(fetchData ? { fetch: async () => new Uint8Array(await fetchData()) } : {}),
    };
  });

const supportedKind = (mimeType: string) => {
  const normalized = mimeType.toLowerCase();
  const image = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find((type) => type === normalized);

  if (image) {
    return {
      kind: { type: "image", mimeType: image },
      maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    } as const;
  }

  const file = PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES.find((type) => type === normalized);

  return file
    ? ({
        kind: { type: "file", mimeType: file },
        maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      } as const)
    : null;
};

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;

type AttachmentOutcome = { readonly attachment: ChatAttachment } | { readonly note: string };

const notAttached = (name: string, reason: string): AttachmentOutcome => ({
  note: `[Shared file "${name}" was not attached: ${reason}]`,
});

const persistAttachment = Effect.fn("persistAttachment")(function* (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  messageId: MessageId,
  inbound: InboundChannelAttachment,
  index: number,
) {
  const { name } = inbound;

  if (index >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return notAttached(
      name,
      `more than ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files in one message`,
    );
  }

  const supported = supportedKind(inbound.mimeType);

  if (!supported) return notAttached(name, `unsupported type ${inbound.mimeType || "unknown"}`);

  const tooLarge = `larger than ${megabytes(supported.maxBytes)}`;

  if ((inbound.sizeBytes ?? 0) > supported.maxBytes) return notAttached(name, tooLarge);

  if (!inbound.fetch) {
    return notAttached(
      name,
      inbound.url ? `no download available, ${inbound.url}` : "no download available",
    );
  }

  const id = deterministicAttachmentId(threadId, `${messageId}\0${index}`);

  if (!id) return notAttached(name, "it could not be saved");

  const bytes = yield* Effect.tryPromise(inbound.fetch).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to download a file shared in a channel message.", {
        threadId,
        name,
        cause,
      }),
    ),
    Effect.option,
  );

  if (Option.isNone(bytes)) return notAttached(name, "download failed");

  if (bytes.value.byteLength === 0) return notAttached(name, "the file is empty");

  if (bytes.value.byteLength > supported.maxBytes) return notAttached(name, tooLarge);

  const saved = yield* ctx.deps.writeAttachment({ ...supported.kind, id, name }, bytes.value).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to save a file shared in a channel message.", {
        threadId,
        name,
        cause,
      }),
    ),
    Effect.option,
  );

  return Option.isSome(saved)
    ? { attachment: saved.value }
    : notAttached(name, "it could not be saved");
});

export const persistInboundAttachments = Effect.fn("persistInboundAttachments")(function* (
  ctx: ChannelRuntimeContext,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<InboundChannelAttachment>;
  },
) {
  const outcomes = yield* Effect.forEach(
    input.attachments,
    (attachment, index) =>
      persistAttachment(ctx, input.threadId, input.messageId, attachment, index),
    { concurrency: 1 },
  );

  return {
    attachments: outcomes.flatMap((outcome) =>
      "attachment" in outcome ? [outcome.attachment] : [],
    ),
    notes: outcomes.flatMap((outcome) => ("note" in outcome ? [outcome.note] : [])),
  };
});
