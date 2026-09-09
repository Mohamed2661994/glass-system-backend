const express = require("express");
const router = express.Router();
const reports = require("./reports.controller");

router.get("/inventory-summary", reports.getInventorySummary);
router.get("/product-movement", reports.getProductMovement);
router.get("/product-current-stock", reports.getProductCurrentStock);
router.get("/low-stock", reports.getLowStock);
router.get("/low-stock-reorder-count", reports.getLowStockReorderCount);
router.get("/negative-stock", reports.getNegativeStock);
router.get("/inventory-value", reports.getInventoryValue);

// ✅ أضف السطر ده
router.get("/products", reports.getAllProducts);
router.get("/customer-balances", reports.getCustomerBalances);
router.get("/inventory-details", reports.getInventoryDetails);
router.get("/manufacturers", reports.getManufacturers);
router.get("/customer-debt-details", reports.getCustomerDebtDetails);
router.get("/supplier-balances", reports.getSupplierBalances);
router.get("/supplier-debt-details", reports.getSupplierDebtDetails);
router.get("/warehouse-account", reports.getWarehouseAccount);
router.put("/warehouse-account/opening", reports.setWarehouseAccountOpening);
router.get("/product-sales-profit", reports.getProductSalesProfit);
router.get("/invoice-sales-profit", reports.getInvoiceSalesProfit);
router.get("/manufacturer-analytics", reports.getManufacturerAnalytics);

module.exports = router;

console.log("🔥 REPORTS ROUTES FILE LOADED");
