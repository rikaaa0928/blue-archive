const forbiddenNonEmotionTags = new Set([
  "in a hurry tone", "shouting", "screaming", "whispering", "soft tone", "emphasis",
  "laughing", "chuckling", "sobbing", "crying loudly", "sighing", "groaning",
  "panting", "gasping", "yawning", "snoring", "clear throat",
  "audience laughing", "background laughter", "crowd laughing", "break", "long-break",
]);
const forbiddenEffectWords = /(?:laugh|chuckl|giggl|sob|cry|sigh|groan|moan|pant|gasp|yawn|snor|cough|throat|inhale|exhale|breath|pause|break|whisper|shout|scream|volume|pitch|echo|sing|humming?|audience|background|crowd)/iu;

export function findForbiddenVoiceTags(value) {
  return [...new Set([...String(value ?? "").matchAll(/\[([^\[\]]+)\]/gu)]
    .map(match => match[1].trim().toLowerCase())
    .filter(tag => forbiddenNonEmotionTags.has(tag) || forbiddenEffectWords.test(tag)))];
}
