import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentBlock } from "@aurevoy/shared";
import { isBrowserMcpServerName } from "../../tool/browser-permissions.js";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

type RecordValue = Record<string, unknown>;

/**
 * 将浏览器 MCP 的截图、DOM 文本和 resource 内容落到工作区，供工作台复用。
 * 仅接受 MCP 自己标记的 browser server，固定写入 .aurevoy/browser-artifacts，
 * 并对每个返回块设置大小上限；外部内容永远作为不可信来源交付。
 */
export async function materializeMcpBrowserContentBlocks(input: {
  taskId: string;
  callId: string;
  result: unknown;
  workspaceDir: string;
}): Promise<ContentBlock[]> {
  const envelope = asRecord(input.result);
  const serverName = typeof envelope?.server === "string" ? envelope.server : "";
  if (!isBrowserMcpServerName(serverName)) return [];

  const callResult = asRecord(envelope?.result) ?? envelope;
  const content = Array.isArray(callResult?.content) ? callResult.content : [];
  if (content.length === 0) return [];

  const outputDir = join(input.workspaceDir, ".aurevoy", "browser-artifacts", safeSegment(input.taskId));
  const blocks: ContentBlock[] = [];
  let fileIndex = 0;

  for (const item of content) {
    const record = asRecord(item);
    if (!record || typeof record.type !== "string") continue;

    if (record.type === "image") {
      const data = decodeBase64(record.data);
      if (!data || data.byteLength > MAX_ARTIFACT_BYTES) continue;
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "image/png";
      const path = await writeArtifact(outputDir, input.callId, fileIndex++, extensionForMime(mimeType), data);
      blocks.push(fileBlock(`浏览器截图 ${fileIndex}`, path, mimeType, data.byteLength, `image:${input.callId}:${fileIndex}`));
      continue;
    }

    if (record.type === "resource") {
      const resource = asRecord(record.resource) ?? record;
      const blob = decodeBase64(resource.blob);
      if (blob && blob.byteLength <= MAX_ARTIFACT_BYTES) {
        const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
        const path = await writeArtifact(outputDir, input.callId, fileIndex++, extensionForMime(mimeType), blob);
        blocks.push(fileBlock(`浏览器下载 ${fileIndex}`, path, mimeType, blob.byteLength, `resource:${input.callId}:${fileIndex}`));
        continue;
      }

      if (typeof resource.text === "string") {
        if (Buffer.byteLength(resource.text, "utf8") > MAX_TEXT_BYTES) continue;
        const path = await writeTextArtifact(outputDir, input.callId, fileIndex++, resource.text);
        blocks.push(fileBlock(`网页内容 ${fileIndex}`, path, "text/plain", Buffer.byteLength(resource.text, "utf8"), `resource-text:${input.callId}:${fileIndex}`));
        continue;
      }

      if (typeof resource.uri === "string" && /^https?:\/\//i.test(resource.uri)) {
        blocks.push({
          id: `resource-link:${input.callId}:${fileIndex++}`,
          type: "link",
          content: resource.uri,
          name: "浏览器资源链接",
          source: "external_untrusted",
          untrusted: true,
        });
      }
      continue;
    }

    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      const bytes = Buffer.byteLength(record.text, "utf8");
      if (bytes > MAX_TEXT_BYTES) continue;
      const path = await writeTextArtifact(outputDir, input.callId, fileIndex++, record.text);
      blocks.push(fileBlock(`网页文本 ${fileIndex}`, path, "text/plain", bytes, `text:${input.callId}:${fileIndex}`));
    }
  }

  return blocks;
}

function fileBlock(
  name: string,
  path: string,
  mimeType: string,
  size: number,
  id: string,
): ContentBlock {
  return {
    id,
    type: mimeType.startsWith("image/") ? "image" : "file_reference",
    content: path,
    name,
    mimeType,
    size,
    source: "external_untrusted",
    untrusted: true,
  };
}

async function writeArtifact(
  outputDir: string,
  callId: string,
  index: number,
  extension: string,
  data: Buffer,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `${safeSegment(callId)}-${index}.${extension}`);
  await writeFile(path, data);
  return path;
}

async function writeTextArtifact(
  outputDir: string,
  callId: string,
  index: number,
  text: string,
): Promise<string> {
  const data = Buffer.from(text, "utf8");
  return writeArtifact(outputDir, callId, index, "txt", data);
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const encoded = value.replace(/^data:[^;]+;base64,/, "");
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.byteLength > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0];
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "text/html": "html",
    "text/markdown": "md",
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
  };
  return known[normalized] ?? "bin";
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "browser";
}

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}
