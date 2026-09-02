const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

// 1. Update GET users queries (both admin and branch queries)
content = content.replace(
  'SELECT id, username, branch_id, full_name, role, permissions\n          FROM users\n          ORDER BY id DESC',
  'SELECT id, username, branch_id, full_name, role, permissions, is_active\n          FROM users\n          ORDER BY id DESC'
);
content = content.replace(
  'SELECT id, username, branch_id, full_name, role, permissions\n          FROM users\n          WHERE branch_id = \n          ORDER BY id DESC',
  'SELECT id, username, branch_id, full_name, role, permissions, is_active\n          FROM users\n          WHERE branch_id = \n          ORDER BY id DESC'
);

// 2. Update login logic
content = content.replace(
  '    const user = result.rows[0];\n    const role = user.role === "admin" ? "admin" : "user";',
  '    const user = result.rows[0];\n\n    if (user.is_active === false) {\n      return res.status(403).json({ error: "هذا الحساب موقوف، يرجى مراجعة الإدارة" });\n    }\n\n    const role = user.role === "admin" ? "admin" : "user";'
);

// 3. Insert PUT /users/:id/toggle-active
const toggleRoute = 
app.put("/users/:id/toggle-active", authMiddleware, async (req, res) => {
  try {
    const currentUser = await requireAdminUser(req, res);
    if (!currentUser) return;

    const userId = parseInt(req.params.id);
    if (isNaN(userId)) {
      return res.status(400).json({ error: "معرف المستخدم غير صحيح" });
    }

    const targetUser = await pool.query(
      "SELECT branch_id, is_active FROM users WHERE id = ",
      [userId],
    );

    if (!targetUser.rows.length) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (userId === 7 && !isSuperAdmin(currentUser)) {
      return res.status(403).json({ error: "غير مصرح بتعديل هذا المستخدم" });
    }

    if (!canManageBranch(currentUser, targetUser.rows[0].branch_id)) {
      return res.status(403).json({ error: "غير مصرح بإدارة هذا المستخدم" });
    }

    const newActiveState = targetUser.rows[0].is_active === false ? true : false;

    await pool.query("UPDATE users SET is_active =  WHERE id = ", [
      newActiveState,
      userId,
    ]);

    res.json({ success: true, is_active: newActiveState });
  } catch (err) {
    console.error("TOGGLE USER ERROR:", err);
    res.status(500).json({ error: "فشل تعديل حالة المستخدم" });
  }
});

/* =========================;
content = content.replace('/* =========================\n   🔑 CHANGE PASSWORD\n========================= */', toggleRoute + '\n   🔑 CHANGE PASSWORD\n========================= */');

fs.writeFileSync('index.js', content, 'utf8');
console.log('index.js patched securely.');
