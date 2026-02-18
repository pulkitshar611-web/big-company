"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePalmKashWebhook = void 0;
const prisma_1 = __importDefault(require("../utils/prisma"));
const handlePalmKashWebhook = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { reference, status, transaction_id, amount } = req.body;
        console.log(`📎 [Webhook] Received PalmKash update: ${reference}, Status: ${status}`);
        if (!reference) {
            return res.status(400).json({ success: false, message: 'Missing reference' });
        }
        // 1. Identify what this is (TOPUP, GAS, ORD, POS)
        if (reference.startsWith('TOPUP-') || reference.startsWith('RTOP-')) {
            // Wallet Topup
            if (status === 'SUCCESS' || status === 'COMPLETED') {
                const transaction = yield prisma_1.default.walletTransaction.findFirst({
                    where: { reference: { contains: transaction_id || reference } }
                });
                if (transaction && transaction.status === 'pending') {
                    // Determine if it's Retailer or Consumer based on fields
                    if (transaction.retailerId) {
                        yield prisma_1.default.$transaction([
                            prisma_1.default.walletTransaction.update({
                                where: { id: transaction.id },
                                data: { status: 'completed' }
                            }),
                            prisma_1.default.retailerProfile.update({
                                where: { id: transaction.retailerId },
                                data: { walletBalance: { increment: transaction.amount } }
                            })
                        ]);
                    }
                    else if (transaction.walletId) {
                        yield prisma_1.default.$transaction([
                            prisma_1.default.walletTransaction.update({
                                where: { id: transaction.id },
                                data: { status: 'completed' }
                            }),
                            prisma_1.default.wallet.update({
                                where: { id: transaction.walletId },
                                data: { balance: { increment: transaction.amount } }
                            })
                        ]);
                    }
                }
            }
        }
        else if (reference.startsWith('GAS-')) {
            // Gas Topup handled via metadata in CustomerOrder
            if (status === 'SUCCESS' || status === 'COMPLETED') {
                const order = yield prisma_1.default.customerOrder.findFirst({
                    where: { metadata: { contains: reference } } // PalmKash sends 'reference' back
                });
                if (order && order.status === 'pending') {
                    yield prisma_1.default.$transaction((tx) => __awaiter(void 0, void 0, void 0, function* () {
                        yield tx.customerOrder.update({
                            where: { id: order.id },
                            data: { status: 'completed' }
                        });
                        // Find associated GasTopup
                        const topup = yield tx.gasTopup.findFirst({
                            where: { orderId: order.id.toString() }
                        });
                        if (topup) {
                            yield tx.gasTopup.update({
                                where: { id: topup.id },
                                data: { status: 'completed' }
                            });
                        }
                    }));
                }
            }
        }
        else if (reference.startsWith('ORD-') || reference.startsWith('POS-')) {
            // Retail Order or POS Sale
            if (status === 'SUCCESS' || status === 'COMPLETED') {
                const sale = yield prisma_1.default.sale.findFirst({
                    where: { meterId: transaction_id || reference } // Using meterId as reference storage
                });
                if (sale && sale.status === 'pending') {
                    yield prisma_1.default.sale.update({
                        where: { id: sale.id },
                        data: { status: 'completed' }
                    });
                }
            }
        }
        // Always respond with 200 to acknowledge
        res.json({ success: true });
    }
    catch (error) {
        console.error('Webhook Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});
exports.handlePalmKashWebhook = handlePalmKashWebhook;
