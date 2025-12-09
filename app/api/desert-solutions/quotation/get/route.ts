import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { getProxyClient } from '@/lib/database-proxy/proxy-client';
import { loggerApi } from '@/lib/logger';

/**
 * Get quotation by ID
 * GET /api/desert-solutions/quotation/get?id=xxx
 */
export const GET = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const { searchParams } = new URL(req.url);
    const quotationId = searchParams.get('id');

    if (!quotationId) {
      return NextResponse.json(
        { error: 'Missing quotation ID parameter' },
        { status: 400 }
      );
    }

    // Retrieve quotation from database
    const dbClient = getProxyClient();
    const result = await dbClient.desertSolutions.getQuotation(quotationId);

    if (!result.success || !result.quotation) {
      return NextResponse.json(
        { error: 'Quotation not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      quotation: result.quotation,
    });

  } catch (error) {
    loggerApi.error('Error fetching quotation:', error);
    return NextResponse.json(
      { error: 'Failed to fetch quotation', message: (error as Error).message },
      { status: 500 }
    );
  }
});
