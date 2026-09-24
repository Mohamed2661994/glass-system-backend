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

// 5. Adjustments Routes (الحوافز والمكافآت والخصومات والإضافي)
router.get("/adjustments", controller.getAdjustments);
router.post("/adjustments", controller.createAdjustment);
router.delete("/adjustments/:id", requireAdmin, controller.deleteAdjustment);

// 6. Attendance Routes (نظام الغياب والتحضير الأسبوعي)
router.post("/attendance/toggle", requireAdmin, controller.toggleAttendance);

// 7. Employee Audit Log & Ledger (كشف حساب وسجل حركات العامل الشامل)
router.get("/employees/:id/ledger", controller.getEmployeeLedger);

module.exports = router;

