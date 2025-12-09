import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { mercuryClient } from '@/lib/desert-solutions/mercury-client';
import { loggerApi } from '@/lib/logger';

/**
 * Get invoice status
 * GET /api/desert-solutions/invoice/status?invoiceId=xxx
 *
 * Returns current invoice status from payment provider
 * Implementation is abstracted - changing providers won't affect API contract
 */
export const GET = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const { searchParams } = new URL(req.url);
    const invoiceId = searchParams.get('invoiceId');

    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Missing invoiceId parameter' },
        { status: 400 }
      );
    }

    // Get invoice status from payment provider
    const invoice = await mercuryClient.invoices.get(invoiceId);

    return NextResponse.json({
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.number,
        status: invoice.status,
        total: invoice.total,
        amountPaid: invoice.paidAmount || 0,
        amountDue: invoice.total - (invoice.paidAmount || 0),
        dueDate: invoice.dueDate,
        paidDate: invoice.paidAt,
        paymentUrl: invoice.paymentUrl,
        customerId: invoice.customerId,
      },
    });

  } catch (error) {
    loggerApi.error('Error fetching invoice status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch invoice status', message: (error as Error).message },
      { status: 500 }
    );
  }
});
