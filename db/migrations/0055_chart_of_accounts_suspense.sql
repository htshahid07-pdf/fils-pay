-- Additional suspense accounts for future reconciliation lanes.

-- Fixed: chart_of_accounts (0007) has columns (id, name, kind) and kind is
-- one of asset/liability/revenue. This insert used (code, name,
-- account_type, description) and kind 'suspense', so it failed on every
-- fresh database. Suspense accounts are assets, like scheme_rounding_residue.
INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference (suspense)', 'asset'),
  ('chargeback_suspense',    'Chargeback Suspense',               'asset')
ON CONFLICT (id) DO NOTHING;
