import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import prisma from '../utils/prisma';
import tokenMeterService from '../services/tokenMeter.service';
import pipingMeterService from '../services/pipingMeter.service';

/**
 * Gas Meter Recharge Controller
 * 
 * Handles the full Payment → API Call → Token/Confirmation flow.
 * Supports two meter types:
 *   - TOKEN  → calls tokenMeterService, returns generated recharge token
 *   - PIPING → calls pipingMeterService, performs direct credit + returns confirmation
 */

/**
 * POST /gas-recharge/initiate
 * 
 * Body: { meterNumber, meterType, amount, paymentMethod, phone? }
 * meterType: "TOKEN" | "PIPING"
 * paymentMethod: "wallet" | "mobile_money" | "nfc_card"
 */
export const initiateGasMeterRecharge = async (req: AuthRequest, res: Response) => {
    const {
        meterNumber,
        meterType,
        amount,
        paymentMethod,
        phone,
        cardId,
    } = req.body;

    // --- Validate required fields ---
    if (!meterNumber || !meterType || !amount) {
        return res.status(400).json({
            success: false,
            error: 'meterNumber, meterType, and amount are required.',
        });
    }

    if (!['TOKEN', 'PIPING'].includes(meterType)) {
        return res.status(400).json({
            success: false,
            error: "meterType must be 'TOKEN' or 'PIPING'.",
        });
    }

    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Amount must be a positive number.',
        });
    }

    // Minimum recharge of 500 RWF
    if (parsedAmount < 500) {
        return res.status(400).json({
            success: false,
            error: 'Minimum recharge amount is 500 RWF.',
        });
    }

    const userId = req.user?.id;

    // --- STEP 1: Process Payment ---
    let consumerProfileId: number | null = null;

    try {
        // Only deduct from wallet if authenticated and using wallet payment
        if (userId && paymentMethod === 'wallet') {
            const consumerProfile = await prisma.consumerProfile.findUnique({
                where: { userId },
            });

            if (!consumerProfile) {
                return res.status(404).json({ success: false, error: 'Consumer profile not found.' });
            }
            consumerProfileId = consumerProfile.id;

            // Find dashboard wallet
            const wallet = await prisma.wallet.findFirst({
                where: { consumerId: consumerProfile.id, type: 'dashboard_wallet' },
            });

            if (!wallet || wallet.balance < parsedAmount) {
                return res.status(400).json({
                    success: false,
                    error: `Insufficient wallet balance. Available: ${wallet?.balance || 0} RWF. Required: ${parsedAmount} RWF.`,
                });
            }

            // Deduct wallet balance
            await prisma.wallet.update({
                where: { id: wallet.id },
                data: { balance: { decrement: parsedAmount } },
            });

            // Create wallet transaction record
            await prisma.walletTransaction.create({
                data: {
                    walletId: wallet.id,
                    type: 'gas_meter_recharge',
                    amount: -parsedAmount,
                    description: `${meterType} Gas Meter Recharge - ${meterNumber}`,
                    status: 'completed',
                },
            });

        } else if (userId && paymentMethod === 'nfc_card') {
            if (!cardId) {
                return res.status(400).json({ success: false, error: 'cardId is required for NFC card payment.' });
            }

            const card = await prisma.nfcCard.findFirst({
                where: { id: Number(cardId) },
            });

            if (!card) {
                return res.status(404).json({ success: false, error: 'NFC Card not found.' });
            }
            if (card.balance < parsedAmount) {
                return res.status(400).json({
                    success: false,
                    error: `Insufficient NFC card balance. Available: ${card.balance} RWF. Required: ${parsedAmount} RWF.`,
                });
            }

            await prisma.nfcCard.update({
                where: { id: card.id },
                data: { balance: { decrement: parsedAmount } },
            });

        } else if (paymentMethod === 'mobile_money') {
            // Mobile money is handled via PalmKash (async).
            // For now, we proceed with meter recharge and trust payment was initiated.
            // In production, this should be a webhook-confirmed flow.
            console.log(`[GasRecharge] Mobile money payment initiated for ${parsedAmount} RWF`);
        }
    } catch (paymentError: any) {
        console.error('[GasRecharge] Payment deduction failed:', paymentError.message);
        return res.status(500).json({ success: false, error: `Payment processing error: ${paymentError.message}` });
    }

    // --- STEP 2: Create a PENDING transaction record ---
    const customerRef = `GASRCH-${meterType}-${Date.now()}`;
    let txRecord: any;

    try {
        txRecord = await prisma.gasRechargeTransaction.create({
            data: {
                customerId: consumerProfileId,
                meterNumber,
                meterType,
                amount: parsedAmount,
                paymentMethod: paymentMethod || 'wallet',
                status: 'PENDING',
            },
        });
    } catch (dbError: any) {
        console.error('[GasRecharge] Failed to create transaction record:', dbError.message);
        return res.status(500).json({ success: false, error: 'Failed to log recharge transaction.' });
    }

    // --- STEP 3: Call the appropriate Meter API ---
    let apiResult: any;

    try {
        if (meterType === 'TOKEN') {
            apiResult = await tokenMeterService.rechargeTokenMeter({
                meterNumber,
                amount: parsedAmount,
                customerRef,
            });
        } else {
            // PIPING
            apiResult = await pipingMeterService.rechargePipingMeter({
                meterNumber,
                amount: parsedAmount,
                customerRef,
                customerPhone: phone,
            });
        }
    } catch (apiError: any) {
        // Update transaction record as FAILED
        await prisma.gasRechargeTransaction.update({
            where: { id: txRecord.id },
            data: {
                status: 'FAILED',
                errorMessage: apiError.message || 'Meter API call threw an exception',
            },
        });

        return res.status(500).json({
            success: false,
            error: 'Failed to communicate with Meter API. Please try again.',
            transactionId: txRecord.id,
        });
    }

    // --- STEP 4: Update transaction with API result ---
    const finalStatus = apiResult.success ? 'SUCCESS' : 'FAILED';

    await prisma.gasRechargeTransaction.update({
        where: { id: txRecord.id },
        data: {
            status: finalStatus,
            tokenValue: apiResult.token || null,
            apiReference: apiResult.apiReference || null,
            errorMessage: apiResult.error || null,
        },
    });

    console.log("STRONPOWER FULL RESPONSE:", apiResult.raw);

    if (!apiResult.success) {
        // Refund wallet if payment was pre-deducted and API failed
        if (userId && paymentMethod === 'wallet' && consumerProfileId) {
            try {
                const wallet = await prisma.wallet.findFirst({
                    where: { consumerId: consumerProfileId, type: 'dashboard_wallet' },
                });
                if (wallet) {
                    await prisma.wallet.update({
                        where: { id: wallet.id },
                        data: { balance: { increment: parsedAmount } },
                    });
                    // Record refund
                    await prisma.walletTransaction.create({
                        data: {
                            walletId: wallet.id,
                            type: 'gas_meter_recharge_refund',
                            amount: parsedAmount,
                            description: `Refund: ${meterType} Gas Meter Recharge failed - ${meterNumber}`,
                            status: 'completed',
                        },
                    });
                }
            } catch (refundError: any) {
                console.error('[GasRecharge] Refund failed:', refundError.message);
            }
        }

        return res.status(400).json({
            success: false,
            error: apiResult.error || 'Meter recharge failed.',
            transactionId: txRecord.id,
            raw: apiResult.raw
        });
    }

    // --- STEP 5: Return success with token (if TOKEN type) ---
    console.log("STRONPOWER RAW RESPONSE:", apiResult.raw);
    console.log(`✅ [GasRecharge] ${meterType} meter ${meterNumber} recharged. TxID: ${txRecord.id}`);

    return res.json({
        success: true,
        data: {
            transactionId: txRecord.id,
            meterNumber,
            meterType,
            amount: parsedAmount,
            units: apiResult.units,
            apiReference: apiResult.apiReference,
            message: apiResult.message || 'Recharge successful',
            ...(meterType === 'TOKEN' && { token: apiResult.token }),
            raw: apiResult.raw,
        },
    });
};

/**
 * GET /gas-recharge/history
 * 
 * Returns recharge history for authenticated user.
 * Filters by consumerId if logged in, or returns all if admin.
 */
export const getGasMeterRechargeHistory = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const { limit = 20, offset = 0, meterNumber } = req.query;

        let whereClause: any = {};

        // Filter by consumer profile if user is logged in
        if (userId) {
            const profile = await prisma.consumerProfile.findUnique({ where: { userId } });
            if (profile) {
                whereClause.customerId = profile.id;
            }
        }

        if (meterNumber) {
            whereClause.meterNumber = { contains: String(meterNumber) };
        }

        const [transactions, total] = await Promise.all([
            prisma.gasRechargeTransaction.findMany({
                where: whereClause,
                orderBy: { createdAt: 'desc' },
                take: Number(limit),
                skip: Number(offset),
            }),
            prisma.gasRechargeTransaction.count({ where: whereClause }),
        ]);

        return res.json({
            success: true,
            data: transactions.map((tx) => ({
                id: tx.id,
                meter_number: tx.meterNumber,
                meter_type: tx.meterType,
                amount: tx.amount,
                token_value: tx.tokenValue,    // null for PIPING
                api_reference: tx.apiReference,
                status: tx.status,
                payment_method: tx.paymentMethod,
                error_message: tx.errorMessage,
                created_at: tx.createdAt,
            })),
            total,
        });
    } catch (error: any) {
        console.error('[GasRecharge] History fetch error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * GET /gas-recharge/transaction/:id
 * 
 * Get details of a specific recharge transaction.
 */
export const getGasMeterRechargeTransaction = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        const tx = await prisma.gasRechargeTransaction.findUnique({
            where: { id: Number(id) },
        });

        if (!tx) {
            return res.status(404).json({ success: false, error: 'Transaction not found.' });
        }

        return res.json({
            success: true,
            data: {
                id: tx.id,
                meter_number: tx.meterNumber,
                meter_type: tx.meterType,
                amount: tx.amount,
                token_value: tx.tokenValue,
                api_reference: tx.apiReference,
                status: tx.status,
                payment_method: tx.paymentMethod,
                error_message: tx.errorMessage,
                created_at: tx.createdAt,
                updated_at: tx.updatedAt,
            },
        });
    } catch (error: any) {
        console.error('[GasRecharge] Transaction fetch error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
};
