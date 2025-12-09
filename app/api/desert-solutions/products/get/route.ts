import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { getProductWithVariant } from '@/lib/desert-solutions/product-catalog';
import { loggerApi } from '@/lib/logger';

/**
 * Get product details
 * GET /api/desert-solutions/products/get?id=xxx&variantId=yyy
 */
export const GET = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get('id');
    const variantId = searchParams.get('variantId') ?? undefined;

    if (!productId) {
      return NextResponse.json(
        { error: 'Missing product ID parameter' },
        { status: 400 }
      );
    }

    const product = getProductWithVariant(productId, variantId);

    if (!product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      product,
    });

  } catch (error) {
    loggerApi.error('Error fetching product:', error);
    return NextResponse.json(
      { error: 'Failed to fetch product', message: (error as Error).message },
      { status: 500 }
    );
  }
});
