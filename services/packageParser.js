// services/packageParser.js

function normalizeNumbers(text) {
  if (!text) return text;

  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const english = "0123456789";

  return text.replace(/[٠-٩]/g, (d) => english[arabic.indexOf(d)]);
}

function parsePackage(text) {
  if (!text || typeof text !== "string") {
    throw new Error("PACKAGE_TEXT_INVALID");
  }

  const normalized = normalizeNumbers(text.trim());

  // طقم (وحدة مغلقة)
  if (normalized.includes("طقم")) {
    const match = normalized.match(/(\d+)\s*طقم/);
    return {
      raw: text,
      unit: "set",
      count: match ? parseInt(match[1], 10) : null,
      analyzable: false,
    };
  }

  // دستة
  if (normalized.includes("دستة")) {
    const match = normalized.match(/(\d+)\s*دستة/);
    if (!match) throw new Error("INVALID_DOZEN_FORMAT");

    return {
      raw: text,
      unit: "dozen",
      count: parseInt(match[1], 10),
      analyzable: true,
    };
  }

  // قطعة / شيالة
  if (normalized.includes("قطعة") || normalized.includes("شيالة")) {
    const match = normalized.match(/(\d+)/);
    if (!match) throw new Error("INVALID_PIECE_FORMAT");

    return {
      raw: text,
      unit: "piece",
      count: parseInt(match[1], 10),
      analyzable: true,
    };
  }

  throw new Error("UNKNOWN_PACKAGE_FORMAT");
}

module.exports = {
  parsePackage,
};
