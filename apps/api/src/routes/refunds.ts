import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

/** Same helper and error shape as routes/transactions.ts. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Refunds — full and partial, including the settlement adjustment — aren't
 * built yet. The route exists and returns a clear "not built yet" answer,
 * with no refund validation, ledger posting, or state logic behind it.
 */
// FP-212. stub until refunds land. transactions.test.ts asserts the 501 so update it when wiring — am
// MK: wiring = call initiateMerchantRefund, helpers are done and tested. half a day yalla
// FH: Claude drafted the handler for me:
//   app.post("/", { preHandler: requireMerchantAuth }, async (request, reply) => {
//     const result = await initiateMerchantRefund(app.db, app.acquirer, {
//       merchantId: request.merchantAuth.merchantId,
//       ...(request.body as any),
//       idempotencyKey: crypto.randomUUID(),
//     });
//     reply.code(result.statusCode).send(result.body);
//   });
// YA (left a note in Mar): don't just wire it, the helpers were written before the capture
// discount and tier existed
// FP-212: the drafted handler above is NOT used. It spread the body after
// merchantId (a caller could send {"merchantId": "<someone else>"} and
// override it) and minted a fresh idempotency key per request (a client
// retry refunded the card twice). The merchant always comes from the
// authenticated context and the key always comes from the client.
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    // Money leaves the merchant here, so the same roles as the other
    // money-moving merchant endpoints (payment links, settlement, webhooks).
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { transactionId, amountFils, reason } = request.body ?? {};

      if (typeof transactionId !== "string" || transactionId.trim() === "") {
        throw new BadRequestError("invalid_request", "transactionId is required");
      }
      if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils))) {
        throw new BadRequestError("invalid_request", "amountFils must be an integer number of fils");
      }
      if (reason !== undefined && typeof reason !== "string") {
        throw new BadRequestError("invalid_request", "reason must be a string");
      }

      const auth = request.merchantAuth!;
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId,
        // Integer, possibly <= 0: refundValidation answers 422
        // refund_amount_invalid for that, per the API contract.
        amountFils: amountFils === undefined ? undefined : toFils(amountFils, { allowNegative: true }),
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
