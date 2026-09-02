const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

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

app.put("/users/:id/password",;
content = content.replace('app.put("/users/:id/password",', toggleRoute);

fs.writeFileSync('index.js', content, 'utf8');
console.log('toggle route added.');
