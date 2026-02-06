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
    if (retail.unit !== "set") {
      throw new Error("SET_CANNOT_BE_SPLIT");
    }

    return {
      retail_quantity: wholesale_quantity * wholesale.count,
      mode: "set",
    };
  }

  if (retail.unit === "set") {
    throw new Error("CANNOT_CONVERT_TO_SET");
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
