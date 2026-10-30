package settlement

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// RecordPayoutDisbursement writes the payout-rail instruction record for a
// batch being paid, inside the caller's transaction. Idempotent: the partial
// unique index from migration 0077 allows one row per batch, and a repeat
// is ignored. Exported for internal/splits, which cannot import this
// package (settlement imports splits).
func RecordPayoutDisbursement(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, amount money.Fils) error {
	if amount <= 0 {
		return nil // settlement_payout_disbursements.amount_fils CHECK (> 0)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
		VALUES ($1, $2, 'disb_' || gen_random_uuid())
		ON CONFLICT DO NOTHING
	`, batchID, int64(amount))
	return err
}
