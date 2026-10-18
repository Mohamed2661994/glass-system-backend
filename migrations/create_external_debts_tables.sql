-- =========================================================================
-- Migration: Create External Debts and Installments Tables (إدارة المديونيات)
-- =========================================================================

CREATE TABLE IF NOT EXISTS external_debts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    creditor_name VARCHAR(255) NOT NULL,
    creditor_phone VARCHAR(50) DEFAULT '',
    total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    remaining_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    installment_count INTEGER NOT NULL DEFAULT 1,
    installment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    frequency VARCHAR(50) NOT NULL DEFAULT 'monthly', -- 'daily', 'weekly', 'monthly', 'custom'
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'completed', 'paused'
    category VARCHAR(100) DEFAULT 'عام', -- قرض، جمعية، قسط مشتريات، التزام شخصي...
    notes TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS debt_installments (
    id SERIAL PRIMARY KEY,
    debt_id INTEGER NOT NULL REFERENCES external_debts(id) ON DELETE CASCADE,
    installment_number INTEGER NOT NULL,
    due_date DATE NOT NULL,
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    paid_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'partially_paid', 'overdue'
    payment_method VARCHAR(100) DEFAULT 'كاش', -- 'كاش', 'إنستاباي', 'تحويل بنكي', 'فودافون كاش'...
    source_type VARCHAR(50) DEFAULT 'personal', -- 'personal' أموال شخصية, 'treasury' خزينة المحل
    treasury_tx_id INTEGER,
    notes TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast Indexing for calendar queries and status checks
CREATE INDEX IF NOT EXISTS idx_debt_installments_debt_id ON debt_installments(debt_id);
CREATE INDEX IF NOT EXISTS idx_debt_installments_due_date ON debt_installments(due_date);
CREATE INDEX IF NOT EXISTS idx_debt_installments_status ON debt_installments(status);
CREATE INDEX IF NOT EXISTS idx_external_debts_status ON external_debts(status);

-- Treasury Integration (cash_out linked to debts)
ALTER TABLE cash_out ADD COLUMN IF NOT EXISTS debt_id INTEGER REFERENCES external_debts(id) ON DELETE SET NULL;
ALTER TABLE cash_out ADD COLUMN IF NOT EXISTS installment_id INTEGER REFERENCES debt_installments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cash_out_debt_id ON cash_out(debt_id);

