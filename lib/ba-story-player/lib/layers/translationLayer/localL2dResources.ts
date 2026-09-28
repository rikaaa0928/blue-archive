const localL2dSpineFiles = new Map<string, string>([
  ["SpineBG_SC11000_01", "SC11000_01"],
]);

export function resolveLocalL2dSpineFallback(
  bgFileName: string,
  localResourceUrl: string
) {
  if (!localResourceUrl) {
    return undefined;
  }

  const bgName = String(bgFileName).split("/").pop() ?? "";
  const spineFile = localL2dSpineFiles.get(bgName);
  if (!spineFile) {
    return undefined;
  }

  return {
    url: `${localResourceUrl.replace(/\/$/, "")}/spine/spinebg/${spineFile}.skel`,
    name: spineFile,
  };
}
