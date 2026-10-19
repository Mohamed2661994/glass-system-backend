// services/wholesaleToRetailConverter.js

const { parsePackage } = require("./packageParser");

const DOZEN_SIZE = 12;

function convertWholesaleToRetail({
  wholesale_package,
  retail_package,
  wholesale_quantity,
}) {
  console.log("CONVERT INPUT:", {
    wholesale_package,
    retail_package,
    wholesale_quantity,
  });

  if (!wholesale_quantity || wholesale_quantity <= 0) {
    throw new Error("INVALID_QUANTITY");
  }

  const wholesale = parsePackage(wholesale_package);
  const retail = parsePackage(retail_package);

  if (!wholesale.analyzable || !retail.analyzable) {
    throw new Error("PACKAGE_NOT_ANALYZABLE");
  }

  // 1 - set (closed unit)
  if (wholesale.unit === "set") {
    const qty = wholesale_quantity * wholesale.count;
    return {
      from_quantity: wholesale_quantity,
      to_quantity: qty,
      retail_quantity: qty,
      mode: "set",
    };
  }

  // 2 - calculate pieces from wholesale
  let piecesPerWholesaleUnit;

  if (wholesale.unit === "dozen") {
    piecesPerWholesaleUnit = wholesale.count * DOZEN_SIZE;
  } else if (wholesale.unit === "container") {
    piecesPerWholesaleUnit = wholesale.count;
  } else if (wholesale.unit === "piece") {
    piecesPerWholesaleUnit = wholesale.count;
  } else {
    throw new Error("WHOLESALE_NOT_ANALYZABLE");
  }

  const totalPieces = piecesPerWholesaleUnit * wholesale_quantity;

  // 3 - convert to retail
  if (retail.unit === "piece") {
    return {
      from_quantity: wholesale_quantity,
      to_quantity: totalPieces,
      retail_quantity: totalPieces,
      mode: wholesale.unit === "dozen" ? "dozen_to_piece" : "container_to_piece",
    };
  }

  let piecesPerRetailUnit = 1;

  if (retail.unit === "container") {
    piecesPerRetailUnit = retail.count;
  } else if (retail.unit === "dozen") {
    piecesPerRetailUnit = retail.count * DOZEN_SIZE;
  }

  const retailQuantity = totalPieces / piecesPerRetailUnit;
  const roundedQty = Math.round(retailQuantity);
  const finalQty = Math.abs(retailQuantity - roundedQty) < 0.0001 ? roundedQty : retailQuantity;

  if (!Number.isInteger(finalQty)) {
    throw new Error("FRACTION_RESULT");
  }

  return {
    from_quantity: wholesale_quantity,
    to_quantity: finalQty,
    retail_quantity: finalQty,
    mode: "analyzed",
  };
}

module.exports = {
  convertWholesaleToRetail,
};