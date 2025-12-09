import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { renderToBuffer } from '@react-pdf/renderer';
import QuotationPDF from '@/lib/desert-solutions/quotation-pdf';
import { Quotation } from '@/lib/desert-solutions/quotation-types';
import React from 'react';
import { loggerApi } from '@/lib/logger';

// Force Node.js runtime for @react-pdf/renderer native bindings
export const runtime = 'nodejs';

/**
 * Generate quotation PDF
 * POST /api/desert-solutions/quotation/pdf
 *
 * Accepts quotation object and returns PDF
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const quotation: Quotation = await req.json();

    // Validate quotation has required fields
    if (!quotation.quotationNumber || !quotation.customer || !quotation.items) {
      return NextResponse.json(
        { error: 'Invalid quotation data' },
        { status: 400 }
      );
    }

    // Generate PDF
    const pdfBuffer = await renderToBuffer(
      <QuotationPDF quotation={quotation} />
    );

    const filename = `quotation-${quotation.quotationNumber}.pdf`;

    return new NextResponse(pdfBuffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });

  } catch (error) {
    loggerApi.error('Error generating PDF:', error);
    return NextResponse.json(
      { error: 'Failed to generate PDF', message: (error as Error).message },
      { status: 500 }
    );
  }
});
