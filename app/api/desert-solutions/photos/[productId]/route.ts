import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { getPhotosByProductId, ProductPhoto } from '@/lib/desert-solutions/product-photos';
import { getPresignedUrl } from '@/lib/do-spaces';
import { z } from 'zod';

// Response type for photo with signed URL
interface PhotoWithUrl extends ProductPhoto {
  signedUrl: string;
  expiresIn: number;
}

const querySchema = z.object({
  type: z.enum(['product_overview', 'detail', 'installation', 'all']).optional().default('all'),
  actualModelOnly: z.string().optional().transform(v => v === 'true'),
  expiresIn: z.string().optional().transform(v => v ? parseInt(v, 10) : 3600),
});

/**
 * Get product photos with signed URLs
 * GET /api/desert-solutions/photos/[productId]
 *
 * Query params:
 * - type: Filter by photo type (product_overview, detail, installation, all)
 * - actualModelOnly: Only return photos marked as actual model (true/false)
 * - expiresIn: URL expiration time in seconds (default: 3600 = 1 hour)
 */
export const GET = DESERT_SOLUTIONS_SECURITY(async (
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) => {
  try {
    const { productId } = await params;
    const url = new URL(req.url);

    // Parse query parameters
    const queryParams = {
      type: url.searchParams.get('type') || 'all',
      actualModelOnly: url.searchParams.get('actualModelOnly'),
      expiresIn: url.searchParams.get('expiresIn'),
    };

    const validated = querySchema.parse(queryParams);
    const { type, actualModelOnly, expiresIn } = validated;

    // Get photo set for product
    const photoSet = getPhotosByProductId(productId);

    if (!photoSet) {
      return NextResponse.json(
        { error: 'Product not found', productId },
        { status: 404 }
      );
    }

    // Filter photos based on query params
    let photos = photoSet.photos;

    if (type !== 'all') {
      photos = photos.filter(p => p.type === type);
    }

    if (actualModelOnly) {
      photos = photos.filter(p => p.isActualModel);
    }

    // Generate signed URLs for each photo
    const photosWithUrls: PhotoWithUrl[] = await Promise.all(
      photos.map(async (photo) => {
        const signedUrl = await getPresignedUrl(photo.s3Key, expiresIn);
        return {
          ...photo,
          signedUrl,
          expiresIn,
        };
      })
    );

    return NextResponse.json({
      productId: photoSet.productId,
      productName: photoSet.productName,
      sku: photoSet.sku,
      refrigerant: photoSet.refrigerant,
      photoCount: photosWithUrls.length,
      photos: photosWithUrls,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.errors },
        { status: 400 }
      );
    }

    console.error('Error fetching product photos:', error);
    return NextResponse.json(
      { error: 'Failed to fetch photos', message: (error as Error).message },
      { status: 500 }
    );
  }
});
