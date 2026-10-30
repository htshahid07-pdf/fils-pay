-- platform_stats.total_processed_fils was INTEGER (0049): max 2,147,483,647
-- fils (~2,147 thousand BD), only ~7% above the 2,000,000,000-fil volume-tier
-- threshold (d69a813). Once lifetime volume passes the INTEGER max, the
-- UPDATE in CloseBatch fails with "integer out of range" and no merchant's
-- batch can close. Money counters are BIGINT fils (ADR-0001).
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
