const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');
const oldCode =     res.json({ success: true });
  } catch (err) {
    console.error("DELETE USER ERROR:", err);
    res.status(500).json({ error: "فشل حذف المستخدم" });
  };
const newCode =     res.json({ success: true });
  } catch (err) {
    console.error("DELETE USER ERROR:", err);
    if (err.code === '23503') {
      return res.status(400).json({ error: "لا يمكن حذف هذا المستخدم لارتباطه ببيانات في النظام." });
    }
    res.status(500).json({ error: "فشل حذف المستخدم" });
  };
if(content.includes(oldCode)){
  content = content.replace(oldCode, newCode);
  fs.writeFileSync('index.js', content, 'utf8');
  console.log('patched successfully');
} else {
  // fallback if line endings differ
  const regex = /res\.json\(\{ success: true \}\);\s*\} catch \(err\) \{\s*console\.error\("DELETE USER ERROR:", err\);\s*res\.status\(500\)\.json\(\{ error: "فشل حذف المستخدم" \}\);\s*\}/;
  if(regex.test(content)){
    content = content.replace(regex, newCode);
    fs.writeFileSync('index.js', content, 'utf8');
    console.log('patched with regex');
  } else {
    console.log('not found');
  }
}
