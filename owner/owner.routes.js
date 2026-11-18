const express = require("express");
const router = express.Router();
const controller = require("./owner.controller");

// 1. PIN Unlock & Verification
router.post("/auth/unlock", controller.unlockOwnerSession);
router.get("/auth/status", controller.requireOwnerSession, controller.checkOwnerSession);

// 2. Metrics & KPI Cockpit (Gated by Ephemeral Owner Session)
router.get("/metrics", controller.requireOwnerSession, controller.getOwnerMetrics);

// 2.5 Interactive Executive Curves & Trends
router.get("/trends", controller.requireOwnerSession, controller.getOwnerTrends);

// 3. Force Refresh Heavy Cache
router.post("/refresh-cache", controller.requireOwnerSession, controller.refreshOwnerCache);

module.exports = router;
