-- =========================================================================
-- Migration: Create debt_installment_payments (سجل حركات السداد التفصيلية)
-- =========================================================================

CREATE TABLE IF NOT EXISTS debt_installment_payments (
    id SERIAL PRIMARY KEY,
    debt_id INTEGER NOT NULL REFERENCES external_debts(id) ON DELETE CASCADE,
    installment_id INTEGER NOT NULL REFERENCES debt_installments(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    payment_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    payment_method VARCHAR(100) DEFAULT 'كاش',
    source_type VARCHAR(50) DEFAULT 'personal', -- 'personal', 'treasury'
    cash_out_id INTEGER REFERENCES cash_out(id) ON DELETE SET NULL,
    permission_number VARCHAR(100) DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dip_installment_id ON debt_installment_payments(installment_id);
CREATE INDEX IF NOT EXISTS idx_dip_debt_id ON debt_installment_payments(debt_id);
CREATE INDEX IF NOT EXISTS idx_dip_payment_date ON debt_installment_payments(payment_date);

-- Migrate existing payments from cash_out
INSERT INTO debt_installment_payments (debt_id, installment_id, amount, payment_date, payment_method, source_type, cash_out_id, permission_number, notes)
SELECT 
    co.debt_id,
    co.installment_id,
    co.amount,
    co.created_at,
    'خزينة المحل',
    'treasury',
    co.id,
    co.permission_number,
    COALESCE(co.notes, 'إذن صرف #' || co.permission_number)
FROM cash_out co
WHERE co.debt_id IS NOT NULL 
  AND co.installment_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM debt_installment_payments dip WHERE dip.cash_out_id = co.id
  );

-- For any installment where paid_amount > sum of payments in debt_installment_payments, create a legacy personal payment record
INSERT INTO debt_installment_payments (debt_id, installment_id, amount, payment_date, payment_method, source_type, notes)
SELECT 
    di.debt_id,
    di.id,
    di.paid_amount - COALESCE(p.recorded_paid, 0),
    COALESCE(di.paid_at, di.updated_at, NOW()),
    COALESCE(di.payment_method, 'كاش'),
    'personal',
    'سداد مباشر / سابق'
FROM debt_installments di
LEFT JOIN (
    SELECT installment_id, SUM(amount) as recorded_paid 
    FROM debt_installment_payments 
    GROUP BY installment_id
) p ON p.installment_id = di.id
WHERE di.paid_amount > COALESCE(p.recorded_paid, 0);
