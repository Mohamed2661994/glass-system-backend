# ================================================================================

# Glass System - Hybrid Database Report

# التقرير الكامل لنظام قواعد البيانات الهجين

# ================================================================================

# التاريخ: 1 مارس 2026

# المشروع: Glass System (نظام إدارة المعارض)

# ================================================================================

## 1. نظرة عامة على المعمارية (Architecture Overview)

## ──────────────────────────────────────────────────

النظام بيشتغل بمعمارية هجينة (Hybrid) بين سيرفرين:

- **Primary (أساسي):** سيرفر محلي على `db.hg-alshour.online` (IP: 156.196.219.210)
- **Fallback (احتياطي):** Neon Cloud على `ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech`

### مبدأ العمل:

- في الوضع الطبيعي، كل الطلبات تروح للسيرفر المحلي (بدون limits)
- لو المحلي وقع (كهربا/نت)، النظام يتحول تلقائياً لـ Neon Cloud
- لما المحلي يرجع، النظام يسحب الداتا من Neon ويرجعها للمحلي ثم يتحول عليه تلقائياً

## 2. الملفات والمسارات (Files & Paths)

## ──────────────────────────────────────

### ملفات الباكإند:

| الملف                                         | الوصف                                |
| --------------------------------------------- | ------------------------------------ |
| D:\glass-backend\db.js                        | الاتصال الهجين بقاعدة البيانات       |
| D:\glass-backend\.env                         | متغيرات البيئة المحلية               |
| D:\glass-backend\scripts\hourly-backup.ps1    | سكربت الباك اب كل ساعة               |
| D:\glass-backend\scripts\daily-sync-neon.ps1  | سكربت المزامنة اليومية لـ Neon       |
| D:\glass-backend\scripts\failover-monitor.ps1 | سكربت مراقبة الفشل والتحويل التلقائي |

### مجلد الباك اب:

| المسار             | المحتوى                                   |
| ------------------ | ----------------------------------------- |
| D:\glass-backups\  | ملفات الباك اب (آخر 5 نسخ)                |
| backup.log         | سجل عمليات الباك اب                       |
| sync.log           | سجل عمليات المزامنة اليومية               |
| failover.log       | سجل عمليات التحويل والفشل                 |
| failover_state.txt | حالة النظام الحالية (local_up/local_down) |

## 3. بيانات الاتصال (Connection Details)

## ──────────────────────────────────────

### السيرفر المحلي (Primary):

- Host: db.hg-alshour.online
- Port: 5432
- User: glass_admin
- Password: @Hadysalah1
- Database: glass_system
- SSL: false

### Neon Cloud (Fallback):

- Host: ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech
- Port: 5432
- User: neondb_owner
- Password: npg_Gdq7zm6OTpNu
- Database: neondb
- SSL: true (required)

### Render Environment Variables:

| المتغير           | القيمة                                                      |
| ----------------- | ----------------------------------------------------------- |
| DB_HOST_LOCAL     | db.hg-alshour.online                                        |
| DB_PORT_LOCAL     | 5432                                                        |
| DB_USER_LOCAL     | glass_admin                                                 |
| DB_PASSWORD_LOCAL | @Hadysalah1                                                 |
| DB_NAME_LOCAL     | glass_system                                                |
| DB_SSL_LOCAL      | false                                                       |
| DB_HOST_NEON      | ep-floral-field-ai56366w-pooler.c-4.us-east-1.aws.neon.tech |
| DB_PORT_NEON      | 5432                                                        |
| DB_USER_NEON      | neondb_owner                                                |
| DB_PASSWORD_NEON  | npg_Gdq7zm6OTpNu                                            |
| DB_NAME_NEON      | neondb                                                      |
| DB_SSL_NEON       | true                                                        |
| JWT_SECRET        | glass_system_super_secret_2026                              |
| NODE_ENV          | production                                                  |

## 4. تفصيل السكربتات (Scripts Details)

## ────────────────────────────────────

### === سكربت 1: hourly-backup.ps1 ===

### الوظيفة: باك اب كل ساعة مع الاحتفاظ بآخر 5 نسخ

### التوقيت: كل ساعة (Windows Task Scheduler)

### الـ Task: GlassDB-HourlyBackup

#### ماذا يفعل:

1. يتصل بالسيرفر المحلي
2. يعمل pg_dump مع encoding UTF-8 (لدعم العربي)
3. يحفظ الملف في D:\glass-backups\glass_system_YYYY-MM-DD_HH-MM.sql
4. يمسح النسخ القديمة ويخلي آخر 5 بس
5. يسجل كل حاجة في backup.log

#### الخيارات المستخدمة في pg_dump:

- --clean --if-exists: يمسح الجداول القديمة قبل الإنشاء
- --no-owner --no-privileges: يتجاهل الصلاحيات (عشان التوافق)
- --encoding=UTF8: لضمان العربي يظهر صح

### === سكربت 2: daily-sync-neon.ps1 ===

### الوظيفة: مزامنة يومية من المحلي لـ Neon

### التوقيت: كل يوم الساعة 3:00 فجراً

### الـ Task: GlassDB-DailySyncNeon

#### ماذا يفعل:

1. يعمل pg_dump من السيرفر المحلي
2. يعمل restore على Neon (مع SSL)
3. يتحقق إن الداتا وصلت (يقارن عدد المنتجات)
4. يمسح الملف المؤقت
5. يسجل كل حاجة في sync.log

#### ملاحظة:

- ممكن يطلع warnings بسبب role "neon_superuser" - ده طبيعي ومش مشكلة
- بيستهلك حوالي 2-5 دقائق compute time من Neon free tier

### === سكربت 3: failover-monitor.ps1 ===

### الوظيفة: مراقبة السيرفر المحلي + تحويل تلقائي + sync عند العودة

### التوقيت: كل 5 دقائق

### الـ Task: GlassDB-FailoverMonitor

#### ماذا يفعل (4 سيناريوهات):

##### السيناريو 1: المحلي شغال + الحالة local_up

- مفيش حاجة - كل حاجة تمام، يخرج بدون أي عمل

##### السيناريو 2: المحلي واقع + الحالة local_up (FAILOVER)

- يكتشف إن المحلي وقع لأول مرة
- يجيب آخر نسخة backup من D:\glass-backups\
- يعملها restore على Neon
- يغير الحالة لـ local_down
- يسجل عمر النسخة (أقصاها ساعة)

##### السيناريو 3: المحلي واقع + الحالة local_down

- المحلي لسه واقع وعملنا sync قبل كده
- يسجل إنه لسه واقع ويخرج

##### السيناريو 4: المحلي رجع + الحالة local_down (FAILBACK)

- يكتشف إن المحلي رجع
- يعمل pg_dump من Neon (عشان يجيب الداتا اللي اتعملت وهو واقع)
- يعملها restore على المحلي
- يتحقق إن الداتا متطابقة
- يغير الحالة لـ local_up
- المحلي بقى عنده كل الداتا الجديدة

## 5. ملف db.js - الاتصال الهجين (Hybrid Connection)

## ──────────────────────────────────────────────────

### المعمارية:

- localPool: اتصال بالسيرفر المحلي (محاولة أولى)
- neonPool: اتصال بـ Neon Cloud (fallback)
- pool: كائن وسيط (proxy) يوجه الطلبات تلقائياً

### المنطق:

1. كل طلب query أو connect بيروح للمحلي الأول
2. لو فشل (timeout 5 ثواني) → يتحول لـ Neon
3. كل 60 ثانية بيحاول يرجع للمحلي
4. الـ health endpoint (/health) بيوضح أي DB شغالة:
   - {"activeDb": "local"} = شغال على المحلي
   - {"activeDb": "neon"} = شغال على Neon

### Timezone:

- كل اتصال جديد بيعمل SET timezone = 'Africa/Cairo'

## 6. Windows Task Scheduler Tasks

## ────────────────────────────────

| Task Name               | التوقيت        | السكربت                      |
| ----------------------- | -------------- | ---------------------------- |
| GlassDB-HourlyBackup    | كل ساعة        | scripts\hourly-backup.ps1    |
| GlassDB-DailySyncNeon   | كل يوم 3 فجراً | scripts\daily-sync-neon.ps1  |
| GlassDB-FailoverMonitor | كل 5 دقائق     | scripts\failover-monitor.ps1 |

### لإدارة الـ Tasks:

- فتح Task Scheduler: Win+R → taskschd.msc
- أو من PowerShell: Get-ScheduledTask -TaskName "GlassDB-\*"

## 7. مراقبة النظام (Monitoring)

## ──────────────────────────────

### Health Check:

- URL: https://glass-system-backend.onrender.com/health
- Response: {"status":"ok","activeDb":"local","timestamp":"..."}

### ملفات الـ Log:

- D:\glass-backups\backup.log → سجل الباك اب
- D:\glass-backups\sync.log → سجل المزامنة اليومية
- D:\glass-backups\failover.log → سجل التحويل والفشل
- D:\glass-backups\failover_state.txt → الحالة الحالية

## 8. سيناريو كامل - فصل الكهربا والعودة

## ────────────────────────────────────────

### الوقت 14:00 - الكهربا فصلت:

1. [5 ثواني] db.js يكتشف إن المحلي مش بيرد → يتحول لـ Neon
2. [دقائق] المستخدمين يشتغلوا عادي على Neon بدون انقطاع
3. الداتا على Neon عمرها أقصاها ساعة (من آخر hourly backup)

### الوقت 16:30 - الكهربا رجعت:

1. [5 دقائق] failover-monitor يكتشف إن المحلي رجع
2. [2-5 دقائق] يسحب الداتا من Neon (اللي اتعملت من 14:00 لـ 16:30) → يرجعها للمحلي
3. [60 ثانية] db.js يكتشف إن المحلي رجع → يتحول عليه
4. كل الداتا محفوظة - مفيش حاجة ضاعت

## 9. ملاحظات مهمة

## ────────────────

1. الـ failover-monitor بيشتغل على الجهاز المحلي - يعني لو الكهربا فصلت
   هو كمان مش هيشتغل. لكن db.js (على Render) هو اللي بيعمل التحويل الفوري.
   الـ monitor بيعمل الـ sync لما الجهاز يرجع يشتغل.

2. مفيش داتا بتضيع بين فصل الكهربا ورجوعها لأن:
   - db.js بيحول فوراً لـ Neon
   - لما المحلي يرجع، الـ monitor بيسحب الداتا من Neon ثم يرجعها للمحلي

3. Neon free tier مش هيتأثر لأن:
   - الـ sync اليومي = 5 دقائق compute/يوم
   - الـ failover sync = نادر (وقت الطوارئ فقط)

4. الباك أبات المحلية (كل ساعة) = طبقة أمان إضافية حتى لو Neon مش موجود
