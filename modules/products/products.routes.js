const express = require("express");
const router = express.Router();

// هنستخدم نفس كنترولر التقارير الجديد
const controller = require("../../reports/reports.controller");

// نفس المسار القديم يشتغل زي ما هو
router.get("/", controller.getAllProducts);

module.exports = router;
