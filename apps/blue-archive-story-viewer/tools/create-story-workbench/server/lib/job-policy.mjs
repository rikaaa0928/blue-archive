export function prerequisiteStageForJob(action, params = {}) {
  if (new Set(["tts-line-revise", "tts-line-skip"]).has(action)) return "tts";
  if (action === "download-missing-characters") return "resources";
  if (action === "voice-regenerate") return "review-2";
  if (action !== "tts") return action;
  const ttsStage = String(params.ttsStage ?? "prepare");
  return new Set(["prepare", "upload"]).has(ttsStage) ? "resources" : "tts";
}
