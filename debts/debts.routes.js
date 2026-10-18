const express = require("express");
const router = express.Router();
const controller = require("./debts.controller");

/**
 * Middleware: Strictly restrict Debts & Personal Liabilities access to Administrators
 */
function requireAdmin(req, res, next) {
  const user = req.user;
  const isAllowed =
    user &&
    (Number(user.id) === 7 ||
      Number(user.id) === 11 ||
      user.role === "admin" ||
      user.username === "خالد");
  if (!isAllowed) {
    return res.status(403).json({ error: "غير مصرح لك بالوصول لإدارة المديونيات (خاص بالإدارة فقط)" });
  }
  next();
}

// Public / Cash Out Lookup (Accessible to all authenticated users for treasury payment selector)
router.get("/active-list", controller.getActiveList);

// All debts management routes require admin
router.use(requireAdmin);

// 1. KPI & Dashboard Summary
router.get("/summary", controller.getSummary);

// 2. Upcoming & Overdue Installments Timeline
router.get("/upcoming", controller.getUpcoming);

// 3. Debts CRUD
router.get("/", controller.getDebts);
router.post("/", controller.createDebt);
router.get("/:id", controller.getDebtById);
router.put("/:id", controller.updateDebt);
router.delete("/:id", controller.deleteDebt);

// 4. Installments Actions
router.post("/installments/:id/pay", controller.payInstallment);
router.post("/installments/:id/unpay", controller.unpayInstallment);

module.exports = router;
