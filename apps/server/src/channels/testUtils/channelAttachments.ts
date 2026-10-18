import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
import { writeAttachment } from "../../attachmentStore.ts";
import { type ChannelRuntimeDependencies } from "../ChannelRuntimeTypes.ts";

const attachmentsDirs = new Set<string>();

/** A fresh attachment store path for one harness. Nothing is created until a file is written. */
export const makeAttachmentsDir = () => {
  const dir = NodePath.join(
    NodeOS.tmpdir(),
    `akeru-channel-attachments-${NodeCrypto.randomUUID()}`,
  );

  attachmentsDirs.add(dir);

  return dir;
};

/** The production attachment writer, pointed at a test directory. */
export const attachmentWriterFor =
  (attachmentsDir: string): ChannelRuntimeDependencies["writeAttachment"] =>
  (attachment, bytes) =>
    writeAttachment({ attachmentsDir, attachment, bytes }).pipe(Effect.provide(NodeServices.layer));

/** For harnesses whose tests never share files. */
export const unusedAttachmentWriter: ChannelRuntimeDependencies["writeAttachment"] = () =>
  Effect.die("unused attachment writer");

afterEach(() => {
  for (const dir of attachmentsDirs) NodeFS.rmSync(dir, { recursive: true, force: true });
  attachmentsDirs.clear();
});
