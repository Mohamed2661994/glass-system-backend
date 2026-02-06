// services/wholesaleToRetailConverter.js

const { parsePackage } = require("./packageParser");

const DOZEN_SIZE = 12;

function convertWholesaleToRetail({
  wholesale_package,
  retail_package,
  wholesale_quantity,
}) {
  console.log("🔍 CONVERT INPUT:", {
    wholesale_package,
    retail_package,
    wholesale_quantity,
    type_wholesale: typeof wholesale_package,
    type_retail: typeof retail_package,
  });

  if (!wholesale_quantity || wholesale_quantity <= 0) {
    throw new Error("INVALID_QUANTITY");
  }

  const wholesale = parsePackage(wholesale_package);
  const retail = parsePackage(retail_package);

  if (!wholesale.analyzable || !retail.analyzable) {
    throw new Error("PACKAGE_NOT_ANALYZABLE");
  }

  /* ==================================================
     1️⃣ طقم ⇄ طقم (مغلق)
  ================================================== */
  if (wholesale.unit === "set") {
    // 🟢 طقم → طقم (مباشر)
    if (retail.unit === "set") {
      const qty = wholesale_quantity * wholesale.count;

      return {
        from_quantity: wholesale_quantity,
        to_quantity: qty,
        retail_quantity: qty, // ✅ مهم جدًا
        mode: "set",
      };
    }

    // 🟡 طقم → قطعة / شيالة / علبة
    // نطلع عدد القطع من retail.count
    if (retail.unit === "piece" || retail.unit === "container") {
      if (!retail.count || retail.count <= 0) {
        throw new Error("RETAIL_COUNT_NOT_DEFINED");
      }

      const totalPieces = wholesale_quantity * wholesale.count * retail.count;

      return {
        from_quantity: wholesale_quantity,
        to_quantity: totalPieces,
        retail_quantity: totalPieces, // ✅
        mode: "set_to_piece",
      };
    }
  }

  /* ==================================================
     2️⃣ حساب القطع من الجملة
  ================================================== */
  let piecesPerWholesaleUnit;

  if (wholesale.unit === "dozen") {
    piecesPerWholesaleUnit = wholesale.count * DOZEN_SIZE;
  } else {
    throw new Error("WHOLESALE_NOT_ANALYZABLE");
  }

  const totalPieces = piecesPerWholesaleUnit * wholesale_quantity;

  /* ==================================================
     3️⃣ التحويل للقطاعي
  ================================================== */
  let piecesPerRetailUnit = 1;

  if (retail.unit === "container") {
    piecesPerRetailUnit = retail.count;
  }
  if (retail.unit === "piece") {
    return {
      from_quantity: wholesale_quantity,
      to_quantity: totalPieces,
      retail_quantity: totalPieces,
      mode: "dozen_to_piece",
    };
  }
  const retailQuantity = totalPieces / piecesPerRetailUnit;

  if (!Number.isInteger(retailQuantity)) {
    throw new Error("FRACTION_RESULT");
  }

  return {
    from_quantity: wholesale_quantity,
    to_quantity: retailQuantity,
    retail_quantity: retailQuantity, // backward compatibility
    mode: "analyzed",
  };
}

module.exports = {
  convertWholesaleToRetail,
};
