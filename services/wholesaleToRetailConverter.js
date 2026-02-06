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
  const SPLITTABLE_UNITS = ["bundle", "pack", "tray", "case"];

  // 🟡 حالة الطقم (وحدة مغلقة)
  if (wholesale.unit === "set") {
    if (retail.unit !== "set") {
      throw new Error("SET_CANNOT_BE_SPLIT");
    }

    return {
      retail_quantity: wholesale_quantity,
      mode: "set",
    };
  }

  // ❌ ممنوع التحويل لطقم
  if (retail.unit === "set") {
    throw new Error("CANNOT_CONVERT_TO_SET");
  }

  // 🟢 التحليل
  let piecesPerWholesaleUnit;

  if (wholesale.unit === "dozen") {
    piecesPerWholesaleUnit = wholesale.count * DOZEN_SIZE;
  } else if (wholesale.unit === "piece") {
    piecesPerWholesaleUnit = wholesale.count;
  } else {
    throw new Error("WHOLESALE_NOT_ANALYZABLE");
  }

  const totalPieces = piecesPerWholesaleUnit * wholesale_quantity;

  // const piecesPerRetailUnit = retail.count;
  let piecesPerRetailUnit = 1;

  // مسموح بالقسمة فقط لو وحدة تجميع
  if (SPLITTABLE_UNITS.includes(retail.unit)) {
    piecesPerRetailUnit = retail.count;
  }

  const retailQuantity = totalPieces / piecesPerRetailUnit;

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
