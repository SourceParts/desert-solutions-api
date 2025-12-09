import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { allProducts, getProductsByCategory } from '@/lib/desert-solutions/product-catalog';
import { loggerApi } from '@/lib/logger';

/**
 * List all products or filter by category
 * GET /api/desert-solutions/products/list?category=xxx
 */
export const GET = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category');

    const products = category
      ? getProductsByCategory(category)
      : allProducts;

    return NextResponse.json({
      success: true,
      count: products.length,
      products: products.map(p => ({
        id: p.id,
        category: p.category,
        name: p.name,
        shortDescription: p.shortDescription,
        basePrice: p.basePrice,
        defaultWarranty: p.defaultWarranty,
        defaultLeadTime: p.defaultLeadTime,
        hasVariants: (p.variants?.length ?? 0) > 0,
        variantCount: p.variants?.length ?? 0,
      })),
    });

  } catch (error) {
    loggerApi.error('Error listing products:', error);
    return NextResponse.json(
      { error: 'Failed to list products', message: (error as Error).message },
      { status: 500 }
    );
  }
});
