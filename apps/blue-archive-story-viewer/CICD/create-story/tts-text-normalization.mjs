export function replaceRubyWithReading(value) {
  return String(value ?? "").replace(
    /\[ruby=([^\]\r\n]+)\]([\s\S]*?)\[\/ruby\]/gi,
    (_match, reading, surfaceText) => {
      const normalizedReading = String(reading).trim();
      return normalizedReading || surfaceText;
    },
  );
}

export function scanRubyMappings(values) {
  const readingsBySurfaceText = new Map();
  let annotationCount = 0;
  for (const value of values) {
    for (const match of String(value ?? "").matchAll(
      /\[ruby=([^\]\r\n]+)\]([\s\S]*?)\[\/ruby\]/gi,
    )) {
      const reading = String(match[1]).trim();
      const surfaceText = String(match[2]);
      if (!reading || !surfaceText) continue;
      annotationCount++;
      const readings = readingsBySurfaceText.get(surfaceText) || new Set();
      readings.add(reading);
      readingsBySurfaceText.set(surfaceText, readings);
    }
  }
  const mappings = [];
  const conflicts = [];
  for (const [surfaceText, readings] of readingsBySurfaceText) {
    const readingValues = [...readings].sort();
    if (readingValues.length === 1) {
      mappings.push({ surfaceText, reading: readingValues[0] });
    } else {
      const unannotatedIndices = [];
      for (let index = 0; index < values.length; index++) {
        // Ruby-tagged occurrences are already unambiguous and will be expanded
        // from their own annotation. Only bare occurrences require a single
        // story-wide reading.
        const bareText = String(values[index] ?? "").replace(
          /\[ruby=[^\]\r\n]+\][\s\S]*?\[\/ruby\]/gi,
          "",
        );
        if (bareText.includes(surfaceText)) unannotatedIndices.push(index);
      }
      conflicts.push({
        surfaceText,
        readings: readingValues,
        unannotatedIndices,
      });
    }
  }
  mappings.sort((a, b) => b.surfaceText.length - a.surfaceText.length);
  conflicts.sort((a, b) => a.surfaceText.localeCompare(b.surfaceText));
  return { annotationCount, mappings, conflicts };
}

export function assertNoAmbiguousUnannotatedRuby(scan, context = "story") {
  const ambiguous = scan.conflicts.filter(
    conflict => conflict.unannotatedIndices.length > 0,
  );
  if (ambiguous.length === 0) return;
  const details = ambiguous.map(conflict =>
    `${JSON.stringify(conflict.surfaceText)} has readings ${conflict.readings.join(
      ", ",
    )} and bare occurrences at content indices ${conflict.unannotatedIndices.join(
      ", ",
    )}`,
  );
  throw new Error(
    `Ambiguous unannotated ruby in ${context}; manual resolution required:\n${details.join(
      "\n",
    )}`,
  );
}

export function collectRubyMappings(values) {
  const scan = scanRubyMappings(values);
  assertNoAmbiguousUnannotatedRuby(scan);
  return scan.mappings;
}

export function replaceRubySurfaceTextWithReadings(voiceText, mappings) {
  let normalized = replaceRubyWithReading(voiceText);
  for (const { reading, surfaceText } of mappings) {
    normalized = normalized.replaceAll(surfaceText, reading);
  }
  return normalized;
}

export function replaceRubySurfaceTextWithReading(voiceText, sourceText) {
  return replaceRubySurfaceTextWithReadings(
    voiceText,
    collectRubyMappings([sourceText]),
  );
}
