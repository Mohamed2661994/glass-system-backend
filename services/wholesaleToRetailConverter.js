// services/wholesaleToRetailConverter.js

const { parsePackage } = require("./packageParser");

const DOZEN_SIZE = 12;

function convertWholesaleToRetail({
  wholesale_package,
  retail_package,
  wholesale_quantity,
}) {
  if (!wholesale_quantity || wholesale_quantity <= 0) {
    throw new Error("INVALID_QUANTITY");
  }

  const wholesale = parsePackage(wholesale_package);
  const retail = parsePackage(retail_package);

  /* =============================
     1️⃣ مسار الطقم → طقم
     كرتونة 4 طقم  =>  4 طقم
  ============================= */

  if (wholesale.unit === "set") {
    if (retail.unit !== "set") {
      throw new Error("SET_CANNOT_BE_SPLIT");
    }

    // كرتونة فيها أطقم
    const setsPerWholesaleUnit = wholesale.count || 1;

    return {
      retail_quantity: wholesale_quantity * setsPerWholesaleUnit,
      mode: "set",
    };
  }

  // ❌ ممنوع التحويل لطقم من أي وحدة تانية
  if (retail.unit === "set") {
    throw new Error("CANNOT_CONVERT_TO_SET");
  }

  /* =============================
     2️⃣ حساب عدد القطع في وحدة الجملة
     (دستة فقط)
  ============================= */

  let piecesPerWholesaleUnit;

  if (wholesale.unit === "dozen") {
    // دستة = 12 قطعة (قاعدة ثابتة)
    piecesPerWholesaleUnit = wholesale.count * DOZEN_SIZE;
  } else {
    throw new Error("WHOLESALE_NOT_ANALYZABLE");
  }

  const totalPieces = piecesPerWholesaleUnit * wholesale_quantity;

  /* =============================
     3️⃣ التحويل للقطاعي
     - قطعة
     - شيالة
     - علبة
  ============================= */

  let piecesPerRetailUnit = 1;

  // شيالة / علبة = وحدة تجميع
  if (retail.unit === "container") {
    piecesPerRetailUnit = retail.count;
  }

  // قطعة = وحدة نهائية (1 قطعة)
  if (retail.unit === "piece") {
    piecesPerRetailUnit = 1;
  }

  const retailQuantity = totalPieces / piecesPerRetailUnit;

  // ❌ لو طلع كسر نرفض التحويل
  if (!Number.isInteger(retailQuantity)) {
    throw new Error("FRACTION_RESULT");
  }

  return {
    retail_quantity: retailQuantity,
    mode: "analyzed",
  };
}

module.exports = {
  convertWholesaleToRetail,
};
