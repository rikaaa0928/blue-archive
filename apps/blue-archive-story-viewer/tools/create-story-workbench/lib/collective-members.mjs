export function normalizeCollectiveMemberKeys(values) {
  return [...new Set((values ?? [])
    .map(value => String(value).trim())
    .filter(Boolean))];
}

export function parseCollectiveMemberKeys(value) {
  return normalizeCollectiveMemberKeys(String(value ?? "").split(/[,，\r\n]+/u));
}
