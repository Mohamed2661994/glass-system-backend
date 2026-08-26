const express = require("express");
const router = express.Router();
const controller = require("./inter-branch.controller");

// Middleware to protect Webhook routes with API Key
const requireApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const VALID_KEY = process.env.INTER_BRANCH_API_KEY || "TEST_API_KEY_123";
  if (apiKey !== VALID_KEY) {
    return res.status(401).json({ error: "Unauthorized. Invalid API Key." });
  }
  next();
};

// ==========================================
// Connection Settings (UI)
// ==========================================
router.get("/connections", controller.getConnections);
router.post("/connections", controller.addConnection);
router.delete("/connections/:id", controller.removeConnection);

router.get("/warehouses", controller.getWarehouses);

// ==========================================
// User Actions (Triggered from Frontend UI)
// ==========================================

// Get ledger statement (grouped by branch)
router.get("/ledger", controller.getLedger);

// Get transfers list
router.get("/transfers", controller.getTransfers);

// Proxy search for remote branch products
router.get("/remote-products", controller.getRemoteProducts);

// Create a new request to another branch (We want stock from them)
router.post("/request", controller.createRequest);

// Dispatch a request (We approve and send stock to them)
router.post("/:id/dispatch", controller.dispatchTransfer);

// Receive a transfer (They sent stock to us, we add it to our warehouse)
router.post("/:id/receive", controller.receiveTransfer);


// ==========================================
// Webhooks (Triggered by the remote branch)
// ==========================================

// Remote branch is requesting stock from us
router.post("/webhook/request", requireApiKey, controller.webhookRequest);

// Remote branch has dispatched stock to us
router.post("/webhook/dispatch", requireApiKey, controller.webhookDispatch);

// Remote branch has received our stock
router.post("/webhook/receive", requireApiKey, controller.webhookReceive);

// Remote branch queries our products
router.get("/webhook/products", requireApiKey, controller.webhookProducts);

// ==========================================
// Instant Pull Feature
// ==========================================
router.post("/instant-pull", controller.instantPull);
router.post("/webhook/instant-pull", requireApiKey, controller.webhookInstantPull);
router.post("/webhook/instant-pull/cancel", requireApiKey, controller.webhookInstantPullCancel);

module.exports = router;
