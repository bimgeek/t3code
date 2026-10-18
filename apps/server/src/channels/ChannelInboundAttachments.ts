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
  type DownloadedChannelAttachments,
  type DownloadedChannelFile,
  type DownloadedChannelFileKind,
  type InboundChannelAttachment,
} from "./ChannelRuntimeTypes.ts";

const ATTACHMENT_NAME_MAX_CHARS = 255;

const DOWNLOAD_CONCURRENCY = 4;

const DOWNLOAD_TIMEOUT = "30 seconds";

export const inboundAttachments = (message: Message): ReadonlyArray<InboundChannelAttachment> =>
  message.attachments.map((attachment) => {
    const fetchData = attachment.fetchData;

    return {
      name:
        (attachment.name ?? "").trim().slice(0, ATTACHMENT_NAME_MAX_CHARS).trim() ||
        attachment.type,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(fetchData
        ? {
            fetch: async () => {
              const data = await fetchData();

              return data instanceof Uint8Array ? data : new Uint8Array(data);
            },
          }
        : {}),
    };
  });

const supportedKind = (mimeType: string | undefined) => {
  const normalized = (mimeType ?? "").toLowerCase();
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

interface Note {
  readonly note: string;
}

interface Download {
  readonly name: string;
  readonly kind: DownloadedChannelFileKind;
  readonly maxBytes: number;
  readonly fetch: () => Promise<Uint8Array>;
}

const notAttached = (name: string, reason: string): Note => ({
  note: `[Shared file "${name}" was not attached: ${reason}]`,
});

const tooLarge = (name: string, maxBytes: number) =>
  notAttached(name, `larger than ${megabytes(maxBytes)}`);

const planDownload = (inbound: InboundChannelAttachment): Note | Download => {
  const { name } = inbound;
  const supported = supportedKind(inbound.mimeType);

  if (!supported) return notAttached(name, `unsupported type ${inbound.mimeType ?? "unknown"}`);

  if ((inbound.sizeBytes ?? 0) > supported.maxBytes) return tooLarge(name, supported.maxBytes);

  if (!inbound.fetch) {
    return notAttached(
      name,
      inbound.url ? `no download available, ${inbound.url}` : "no download available",
    );
  }

  return { name, kind: supported.kind, maxBytes: supported.maxBytes, fetch: inbound.fetch };
};

/** Files that pass the type and size rules take the slots in order; a rejected file takes none. */
const withinLimit = (plans: ReadonlyArray<Note | Download>) => {
  let slots = 0;

  return plans.map((planned) => {
    if ("note" in planned) return planned;
    slots += 1;

    return slots > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ? notAttached(
          planned.name,
          `more than ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files in one message`,
        )
      : planned;
  });
};

const download = Effect.fn("downloadChannelFile")(function* (planned: Download) {
  const { name } = planned;

  const bytes = yield* Effect.tryPromise(planned.fetch).pipe(
    Effect.timeout(DOWNLOAD_TIMEOUT),
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to download a file shared in a channel message.", {
        name,
        cause,
      }),
    ),
    Effect.option,
  );

  if (Option.isNone(bytes)) return notAttached(name, "download failed");

  if (bytes.value.byteLength === 0) return notAttached(name, "the file is empty");

  if (bytes.value.byteLength > planned.maxBytes) return tooLarge(name, planned.maxBytes);

  return { file: { name, kind: planned.kind, bytes: bytes.value } };
});

/** Applies the type, size, and count rules and downloads the files that pass them. */
export const downloadInboundAttachments = Effect.fn("downloadInboundAttachments")(function* (
  attachments: ReadonlyArray<InboundChannelAttachment>,
) {
  const outcomes = yield* Effect.forEach(
    withinLimit(attachments.map(planDownload)),
    (planned): Effect.Effect<Note | { readonly file: DownloadedChannelFile }> =>
      "note" in planned ? Effect.succeed(planned) : download(planned),
    { concurrency: DOWNLOAD_CONCURRENCY },
  );

  return {
    files: outcomes.flatMap((outcome) => ("file" in outcome ? [outcome.file] : [])),
    notes: outcomes.flatMap((outcome) => ("note" in outcome ? [outcome.note] : [])),
  } satisfies DownloadedChannelAttachments;
});

const saveFile = Effect.fn("saveChannelFile")(function* (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  messageId: MessageId,
  file: DownloadedChannelFile,
  index: number,
) {
  const { name } = file;
  const id = deterministicAttachmentId(threadId, `${messageId}\0${index}`);

  if (!id) return notAttached(name, "it could not be saved");

  const saved = yield* ctx.deps.writeAttachment({ ...file.kind, id, name }, file.bytes).pipe(
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

/** Stores downloaded files under ids derived from the message, so a redelivery rewrites them. */
export const saveDownloadedFiles = Effect.fn("saveDownloadedFiles")(function* (
  ctx: ChannelRuntimeContext,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly files: ReadonlyArray<DownloadedChannelFile>;
  },
) {
  const outcomes = yield* Effect.forEach(
    input.files,
    (file, index) => saveFile(ctx, input.threadId, input.messageId, file, index),
    { concurrency: 1 },
  );

  return {
    attachments: outcomes.flatMap(
      (outcome): ReadonlyArray<ChatAttachment> =>
        "attachment" in outcome ? [outcome.attachment] : [],
    ),
    notes: outcomes.flatMap((outcome) => ("note" in outcome ? [outcome.note] : [])),
  };
});
