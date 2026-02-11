import { Request, Response } from 'express';
import prisma from '../utils/prisma';

export const handlePalmKashWebhook = async (req: Request, res: Response) => {
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
        const transaction = await prisma.walletTransaction.findFirst({
          where: { reference: { contains: transaction_id || reference } }
        });

        if (transaction && transaction.status === 'pending') {
          // Determine if it's Retailer or Consumer based on fields
          if (transaction.retailerId) {
             await prisma.$transaction([
                prisma.walletTransaction.update({
                  where: { id: transaction.id },
                  data: { status: 'completed' }
                }),
                prisma.retailerProfile.update({
                  where: { id: transaction.retailerId },
                  data: { walletBalance: { increment: transaction.amount } }
                })
             ]);
          } else if (transaction.walletId) {
             await prisma.$transaction([
                prisma.walletTransaction.update({
                  where: { id: transaction.id },
                  data: { status: 'completed' }
                }),
                prisma.wallet.update({
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
            const order = await prisma.customerOrder.findFirst({
                where: { metadata: { contains: reference } } // PalmKash sends 'reference' back
            });
            
            if (order && order.status === 'pending') {
                await prisma.$transaction(async (tx) => {
                    await tx.customerOrder.update({
                        where: { id: order.id },
                        data: { status: 'completed' }
                    });
                    
                    // Find associated GasTopup
                    const topup = await tx.gasTopup.findFirst({
                        where: { orderId: order.id.toString() }
                    });
                    
                    if (topup) {
                        await tx.gasTopup.update({
                            where: { id: topup.id },
                            data: { status: 'completed' }
                        });
                    }
                });
            }
        }
    }
    else if (reference.startsWith('ORD-') || reference.startsWith('POS-')) {
       // Retail Order or POS Sale
       if (status === 'SUCCESS' || status === 'COMPLETED') {
           const sale = await prisma.sale.findFirst({
               where: { meterId: transaction_id || reference } // Using meterId as reference storage
           });
           if (sale && sale.status === 'pending') {
               await prisma.sale.update({
                   where: { id: sale.id },
                   data: { status: 'completed' }
               });
           }
       }
    }

    // Always respond with 200 to acknowledge
    res.json({ success: true });
  } catch (error: any) {
    console.error('Webhook Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};
