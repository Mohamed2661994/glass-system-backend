const fs = require('fs');
const path = require('path');

const logPath = path.join('c:', 'Users', 'Khaled', 'glass-system', 'modifications_log.txt');
const entry = `
---

## Log Entry 30: 2026-08-05 - Fix Customer Balances Cross-Branch Cash-In Bug

### Purpose
Fixed a critical bug in the \`getCustomerBalances\` SQL query in \`reports.controller.js\` where cash-in payments (customer_payment) were not being filtered by \`branch_id\`. This caused payments made in the Wholesale branch to be incorrectly subtracted from the customer's Retail branch balance (and vice-versa), artificially pushing balances below zero and hiding customers (like Sameh Salama) from the owed customers list.

### Changes Made
- Modified \`reports.controller.js\` to dynamically inject the \`branch_id\` filter into the \`cash_in\` CTE if a \`warehouse_id\` is requested.
- Additionally, injected date filters (\`from\` and \`to\`) into the \`cash_in\` CTE so that payments align chronologically with the calculated \`opening_balance\`.
- Tested the query and verified that Sameh Salama now correctly appears with his 340 EGP balance in Branch 1.

### Files Modified
* [reports.controller.js](file:///c:/Users/Khaled/glass-system/glass-system-backend/reports/reports.controller.js)
`;

fs.appendFileSync(logPath, entry, 'utf8');
console.log('Appended to log successfully.');
