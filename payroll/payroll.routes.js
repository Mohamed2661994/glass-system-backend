const express = require("express");
const router = express.Router();
const controller = require("./payroll.controller");

/**
 * Middleware: Strictly restrict payroll access to Administrators (User ID 7 or role === 'admin')
 */
function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user || (Number(user.id) !== 7 && user.role !== "admin")) {
    return res.status(403).json({ error: "غير مصرح لك بالوصول لنظام الرواتب (خاص بالإدارة فقط)" });
  }
  next();
}

// 1. Employees Routes
router.get("/employees", controller.getEmployees);
router.post("/employees", controller.createEmployee);
router.put("/employees/:id", requireAdmin, controller.updateEmployee);

// 2. Advances Routes (السُلف والمسحوبات)
router.get("/advances", controller.getAdvances);
router.post("/advances", controller.createAdvance);
router.delete("/advances/:id", requireAdmin, controller.deleteAdvance);

// 3. Payroll Calculation & Payout Confirmation (Admin Only)
router.get("/sheet", requireAdmin, controller.getPayrollSheet);
router.post("/payout", requireAdmin, controller.confirmPayrollPayout);

// 4. Payroll History & Revert (Admin Only)
router.get("/history", requireAdmin, controller.getPayrollHistory);
router.delete("/history/:id", requireAdmin, controller.revertPayrollRecord);

module.exports = router;
