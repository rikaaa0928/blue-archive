import crypto from "node:crypto";

function textHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

export function currentPublicationId(task) {
  return String(task?.taskId || task?.mix?.inputsHash || "");
}

export function currentPublishedTextHash(task) {
  if (task?.generatedTextHash) return String(task.generatedTextHash);
  return textHash(task?.generatedText ?? task?.text ?? "");
}

export function manifestProvesCurrentAudioPublished(task) {
  if (!task || task.needsPublish === true) return false;
  const publicationId = currentPublicationId(task);
  if (!publicationId || String(task.publishedTaskId || "") !== publicationId) {
    return false;
  }
  const currentHash = currentPublishedTextHash(task);
  if (task.publishedTextHash) {
    return String(task.publishedTextHash) === currentHash;
  }
  if (typeof task.publishedText === "string") {
    return textHash(task.publishedText) === currentHash;
  }
  return false;
}

