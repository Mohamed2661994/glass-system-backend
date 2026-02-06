// services/packageParser.js

function normalizeNumbers(text) {
  if (!text) return text;

  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const english = "0123456789";

  return text.replace(/[٠-٩]/g, (d) => english[arabic.indexOf(d)]);
}

function parsePackage(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error("PACKAGE_EMPTY");
  }

  const normalized = normalizeNumbers(text.trim());

  /* =============================
     1️⃣ كرتونة فيها أطقم
     مثال: كرتونة 4 طقم / كرتونة 2 طقم
  ============================= */
  if (normalized.includes("كرتونة") && normalized.includes("طقم")) {
    const match = normalized.match(/(\d+)\s*طقم/);
    if (!match) throw new Error("INVALID_CARTON_SET_FORMAT");

    return {
      raw: text,
      outer: "carton",
      unit: "set",
      count: parseInt(match[1], 10), // عدد الأطقم داخل الكرتونة
      analyzable: true,
    };
  }

  /* =============================
     2️⃣ طقم مباشر (وحدة مغلقة)
     مثال: طقم / 4 طقم
  ============================= */
  if (normalized.includes("طقم")) {
    const match = normalized.match(/(\d+)\s*طقم/);

    return {
      raw: text,
      unit: "set",
      count: match ? parseInt(match[1], 10) : 1,
      analyzable: false, // ممنوع التقسيم
    };
  }

  /* =============================
     3️⃣ دستة
     مثال: كرتونة 4 دستة
  ============================= */
  if (normalized.includes("دستة")) {
    const match = normalized.match(/(\d+)\s*دستة/);
    if (!match) throw new Error("INVALID_DOZEN_FORMAT");

    return {
      raw: text,
      unit: "dozen",
      count: parseInt(match[1], 10), // عدد الدسات
      analyzable: true,
    };
  }

  /* =============================
     4️⃣ وحدات تجميع (شيالة / علبة)
     مثال: شيالة 3 قطعة / علبة 6 قطع
  ============================= */
  if (normalized.includes("شيالة") || normalized.includes("علبة")) {
    const match = normalized.match(/(\d+)/);
    if (!match) throw new Error("INVALID_CONTAINER_FORMAT");

    return {
      raw: text,
      unit: "container",
      containerType: normalized.includes("شيالة") ? "shiala" : "box",
      count: parseInt(match[1], 10), // عدد القطع داخل الوحدة
      analyzable: true,
    };
  }

  /* =============================
     5️⃣ قطعة (وحدة نهائية)
     مثال: قطعة / 1 قطعة
  ============================= */
  if (normalized.includes("قطعة")) {
    return {
      raw: text,
      unit: "piece",
      count: 1,
      analyzable: true,
    };
  }

  /* =============================
     ❌ صيغة غير معروفة
  ============================= */
  throw new Error("UNKNOWN_PACKAGE_FORMAT");
}

module.exports = {
  parsePackage,
};
