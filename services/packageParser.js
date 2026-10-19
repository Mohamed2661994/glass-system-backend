// services/packageParser.js

function normalizeNumbers(text) {
  if (!text) return text;

  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const english = "0123456789";

  return text
    .replace(/[٠-٩]/g, (d) => english[arabic.indexOf(d)])
    .replace(/[٫،]/g, ".");
}

function cleanText(text) {
  return text.replace(/[×*]/g, " ").replace(/\s+/g, " ").trim();
}

function isJustNumber(text) {
  return /^\d+$/.test(text);
}

function parsePackage(text) {
  console.log("📦 parsePackage INPUT:", text);
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error("PACKAGE_EMPTY");
  }

  const normalized = cleanText(normalizeNumbers(text));
  console.log("🧼 normalized:", normalized);

  // ❌ اسم صنف / كود فقط (زي 508 – 703)
  if (isJustNumber(normalized)) {
    return {
      raw: text,
      unit: "unknown",
      analyzable: false,
    };
  }

  /* ==================================================
     1️⃣ طقم (وحدة مغلقة)
     كرتونة 4 طقم / 2 طقم
  ================================================== */
  if (normalized.includes("طقم")) {
    const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*طقم/);

    return {
      raw: text,
      unit: "set",
      count: match && match[1] ? parseFloat(match[1].replace(",", ".")) : 1,
      analyzable: true,
    };
  }

  /* ==================================================
     2️⃣ دستة (أساس التحليل)
     كرتونة 4 دستة / 6 دستة / 1.5 دستة
  ================================================== */
  if (normalized.includes("دستة")) {
    const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*دستة/);

    return {
      raw: text,
      unit: "dozen",
      count: match && match[1] ? parseFloat(match[1].replace(",", ".")) : 1,
      analyzable: true,
    };
  }

  /* ==================================================
     3️⃣ وحدات تجميع (شيالة / علبة)
     شيالة 6
     علبة 4
     شيالة 6 قطع
     3 شيالة
  ================================================== */
  if (normalized.includes("شيالة") || normalized.includes("علبة")) {
    const match = normalized.match(/(\d+(?:[.,]\d+)?)/);

    if (!match) {
      throw new Error("INVALID_CONTAINER_FORMAT");
    }

    return {
      raw: text,
      unit: "container",
      containerType: normalized.includes("شيالة") ? "shiala" : "box",
      count: parseFloat(match[1].replace(",", ".")),
      analyzable: true,
    };
  }

  /* ==================================================
   4️⃣ قطعة (نهائي)
   قطعة / 12 قطعة / 6 قطع
================================================== */
  if (normalized.includes("قطعة") || normalized.includes("قطع")) {
    const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(قطعة|قطع)/);

    return {
      raw: text,
      unit: "piece",
      count: match && match[1] ? parseFloat(match[1].replace(",", ".")) : 1,
      analyzable: true,
    };
  }

  throw new Error("UNKNOWN_PACKAGE_FORMAT");
}

module.exports = {
  parsePackage,
};
