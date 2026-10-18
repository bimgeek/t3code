import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** A fresh attachment store path for one harness. Nothing is created until a file is written. */
export const makeAttachmentsDir = () =>
  NodePath.join(NodeOS.tmpdir(), `akeru-channel-attachments-${NodeCrypto.randomUUID()}`);
