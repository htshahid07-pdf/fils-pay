// FP-212: restored. Posts to /v1/refunds (the route registered in app.ts; MK:
// "/v1/refunds. drawer's old"), takes the amount in BD, and keeps ONE
// idempotency key per refund attempt instead of a fresh key per click.
import { useRef, useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { ApiError, describeError, request } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/** The API's refund error codes, in words a merchant can act on. Validation
 *  failures answer `{ ok:false, code }` rather than `{ error }`, so both are read. */
function describeRefundError(err: unknown): string {
  if (!(err instanceof ApiError)) return describeError(err);
  const code = (err.body.code as string | undefined) ?? err.code;
  switch (code) {
    case "refund_exceeds_refundable": {
      const refundable = Number(err.body.refundableFils ?? 0);
      return `That is more than can still be refunded. At most ${bhd(refundable)} can go back.`;
    }
    case "refund_amount_invalid":
      return "Enter an amount greater than zero.";
    case "transaction_not_refundable":
      return `This transaction can't be refunded (status: ${String(err.body.status ?? "unknown")}).`;
    case "refunds_on_hold":
      return "Refunds are on hold for your account. Contact FilsPay support.";
    case "refund_declined":
      return "The card issuer declined the refund. Nothing was refunded.";
    case "acquirer_unavailable":
      return "The card network is unavailable. Nothing was refunded; you can safely retry.";
    case "request_in_progress":
      return "This refund is still being processed. Wait a moment, then retry.";
    case "transaction_not_found":
      return "Transaction not found.";
    default:
      return describeError(err);
  }
}

/** A definitive answer ends the attempt: the next submit is a new refund.
 *  A network failure or 5xx may or may not have reached the server, so the
 *  retry must reuse the same key and get the original outcome, not a second refund. */
function isDefinitive(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode < 500;
}

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const refundableFils = txn.capturedFils - (txn.refundedFils ?? 0);

  function openDrawer(): void {
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
    setOpen(true);
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();

    const trimmed = amount.trim();
    let amountFils: number | undefined;
    if (trimmed !== "") {
      try {
        amountFils = parseBhdToFils(trimmed);
      } catch {
        setError("Enter the amount in BD with up to three decimals, e.g. 2.000");
        return;
      }
    }
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted and the API refunds everything
      // still refundable — its documented default.
      const body = amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils };
      await request<RefundResponse>("/v1/refunds", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(body),
      });

      idempotencyKey.current = null;
      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      if (isDefinitive(err)) idempotencyKey.current = crypto.randomUUID();
      setError(describeRefundError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!REFUNDABLE_STATUSES.has(txn.status)) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BD, e.g. 2.000 (blank refunds everything still refundable)
              <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={openDrawer}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
