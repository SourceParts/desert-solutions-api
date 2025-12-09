import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { getPhotosByProductId } from '@/lib/desert-solutions/product-photos';
import { getPresignedUrl, getFile } from '@/lib/do-spaces';
import { quotationConfig } from '@/lib/config';
import { z } from 'zod';
import { sendEmail } from '@/lib/email/send-email';
import { renderToBuffer } from '@react-pdf/renderer';
import PhotoAddendumPDF, { PhotoAddendumData, PhotoWithUrl } from '@/lib/desert-solutions/photo-addendum-pdf';
import React from 'react';
import { getProxyClient } from '@/lib/database-proxy/proxy-client';
import { loggerApi } from '@/lib/logger';
import { DocumentStatus, DEFAULT_DOCUMENT_STATUS, getStatusLabel, getStatusColor, generateDocumentHash } from '@/lib/utils/pdf';

// Force Node.js runtime for @react-pdf/renderer native bindings
export const runtime = 'nodejs';

const photoAddendumSchema = z.object({
  quotationId: z.string().optional(),
  quotationNumber: z.string().optional(),
  productIds: z.array(z.string()).min(1),
  customer: z.object({
    name: z.string(),
    email: z.string().email(),
    company: z.string().optional(),
    salutation: z.string().optional(), // e.g., "Mr. Aldewereld" for formal salutation
  }).optional(),
  emailOptions: z.object({
    subject: z.string().optional(),
    message: z.string().optional(),
    cc: z.array(z.string().email()).optional(),
  }).optional(),
  includePhotos: z.object({
    productOverview: z.boolean().optional().default(true),
    detail: z.boolean().optional().default(true),
    installation: z.boolean().optional().default(true),
    actualModelOnly: z.boolean().optional().default(false),
  }).optional(),
  documentStatus: z.enum(['WIP', 'RC', 'FINAL']).optional().default('WIP'),
}).refine(
  (data) => data.quotationId || data.quotationNumber || data.customer,
  { message: 'Either quotationId, quotationNumber, or customer must be provided' }
);

/**
 * Fetch image as base64 data URL for PDF embedding
 */
async function fetchImageAsDataUrl(s3Key: string): Promise<string | null> {
  try {
    const file = await getFile(s3Key);
    if (!file?.Body) {
      return null;
    }

    // Determine content type
    const contentType = file.ContentType || 'image/jpeg';

    // Convert buffer to base64
    const base64 = file.Body.toString('base64');

    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    loggerApi.error(`Failed to fetch image ${s3Key}:`, error);
    return null;
  }
}

/**
 * Send photo addendum email with PDF attachment
 * POST /api/desert-solutions/quotation/photo-addendum
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const validated = photoAddendumSchema.parse(body);
    const { quotationId, quotationNumber, productIds, emailOptions, includePhotos, documentStatus } = validated;
    let customer = validated.customer;

    // If quotationId provided, fetch quotation details
    let resolvedQuotationNumber = quotationNumber;
    if (quotationId && !customer) {
      const dbClient = getProxyClient();
      const result = await dbClient.desertSolutions.getQuotation(quotationId);

      if (!result.success || !result.quotation) {
        return NextResponse.json(
          { error: 'Quotation not found' },
          { status: 404 }
        );
      }

      const quotation = result.quotation as any;
      customer = quotation.customer || quotation.customerData;
      resolvedQuotationNumber = quotation.quotationNumber;
    }

    if (!customer?.email) {
      return NextResponse.json(
        { error: 'Customer email is required' },
        { status: 400 }
      );
    }

    // Build photo data for each product
    const productsWithPhotos: PhotoAddendumData['products'] = [];

    for (const productId of productIds) {
      const photoSet = getPhotosByProductId(productId);
      if (!photoSet) {
        loggerApi.warn(`Product not found: ${productId}`);
        continue;
      }

      // Filter photos based on options
      let photos = photoSet.photos;

      if (includePhotos) {
        photos = photos.filter(p => {
          if (includePhotos.actualModelOnly && !p.isActualModel) return false;
          if (!includePhotos.productOverview && p.type === 'product_overview') return false;
          if (!includePhotos.detail && p.type === 'detail') return false;
          if (!includePhotos.installation && p.type === 'installation') return false;
          return true;
        });
      }

      // Fetch images as base64 data URLs for PDF embedding
      const photosWithUrls: PhotoWithUrl[] = [];
      for (const photo of photos) {
        const imageUrl = await fetchImageAsDataUrl(photo.s3Key);
        if (imageUrl) {
          photosWithUrls.push({
            ...photo,
            imageUrl,
          });
        } else {
          loggerApi.warn(`Failed to fetch image: ${photo.s3Key}`);
        }
      }

      if (photosWithUrls.length > 0) {
        productsWithPhotos.push({
          productId: photoSet.productId,
          productName: photoSet.productName,
          sku: photoSet.sku,
          refrigerant: photoSet.refrigerant,
          photos: photosWithUrls,
        });
      }
    }

    if (productsWithPhotos.length === 0) {
      return NextResponse.json(
        { error: 'No photos found for the specified products' },
        { status: 404 }
      );
    }

    // Prepare PDF data
    const pdfData: PhotoAddendumData = {
      quotationNumber: resolvedQuotationNumber || 'N/A',
      customerName: customer.name,
      products: productsWithPhotos,
    };

    // Generate document hash for audit trail
    const documentHash = generateDocumentHash(
      `PhotoAddendum-${resolvedQuotationNumber || 'N/A'}-${new Date().toISOString().split('T')[0]}`
    );

    // Generate PDF
    const pdfBuffer = await renderToBuffer(
      <PhotoAddendumPDF data={pdfData} documentStatus={documentStatus} documentHash={documentHash} />
    );

    // Build email content
    const totalPhotos = productsWithPhotos.reduce((sum, p) => sum + p.photos.length, 0);
    const productNames = productsWithPhotos.map(p => p.productName).join(', ');
    // Use salutation if provided, otherwise use first name
    const salutation = customer.salutation || customer.name.split(' ')[0];

    // Get status label and color for badge
    const statusLabel = getStatusLabel(documentStatus);
    const statusColor = getStatusColor(documentStatus);
    const subjectStatusSuffix = statusLabel ? ` - ${statusLabel}` : '';

    const subject = emailOptions?.subject ??
      `${quotationConfig.companyName} - Product Photos${resolvedQuotationNumber ? ` [${resolvedQuotationNumber}]` : ''}${subjectStatusSuffix}`;

    const statusBadgeHtml = statusLabel
      ? `<span style="background-color: ${statusColor}; color: #ffffff; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-left: 10px; vertical-align: middle;">${statusLabel}</span>`
      : '';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4338ca;">Product Photo Addendum ${statusBadgeHtml}</h2>

        <p>Dear ${salutation},</p>

        <p>Please find attached the product photo addendum for ${productNames}.</p>

        ${emailOptions?.message ? `<p>${emailOptions.message}</p>` : ''}

        <h3 style="color: #2c3e50;">Photo Summary</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          ${resolvedQuotationNumber ? `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Quotation Reference:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${resolvedQuotationNumber}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Products:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${productsWithPhotos.length}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Total Photos:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${totalPhotos}</td>
          </tr>
        </table>

        <p>These photos provide detailed views of the equipment including product overviews, technical details, and installation examples.</p>

        <p>If you have any questions about the products shown, please don't hesitate to contact us.</p>

        <p>Best regards,<br>
        <strong>José Angel Torres</strong><br>
        Sales Director, ${quotationConfig.companyName}<br>
        <a href="mailto:${quotationConfig.companyEmail}">${quotationConfig.companyEmail}</a><br>
        <a href="${quotationConfig.companyWebsite}">${quotationConfig.companyWebsite}</a></p>

        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">

        <p style="color: #64748b; font-size: 11px;">
          This email and any attachments are confidential and intended solely for the addressee.
          Photos are property of ${quotationConfig.companyName} and may not be redistributed without permission.
        </p>
      </div>
    `;

    const statusTextLabel = statusLabel ? ` [${statusLabel}]` : '';
    const textContent = `
Product Photo Addendum${statusTextLabel}

Dear ${salutation},

Please find attached the product photo addendum for ${productNames}.

${emailOptions?.message ? `${emailOptions.message}\n\n` : ''}Photo Summary:
${resolvedQuotationNumber ? `- Quotation Reference: ${resolvedQuotationNumber}\n` : ''}- Products: ${productsWithPhotos.length}
- Total Photos: ${totalPhotos}

These photos provide detailed views of the equipment including product overviews, technical details, and installation examples.

If you have any questions about the products shown, please don't hesitate to contact us.

Best regards,
José Angel Torres
Sales Director, ${quotationConfig.companyName}
${quotationConfig.companyEmail}
${quotationConfig.companyWebsite}

This email and any attachments are confidential and intended solely for the addressee.
Photos are property of ${quotationConfig.companyName} and may not be redistributed without permission.
    `.trim();

    // Send email
    await sendEmail({
      from: `José Angel Torres <${quotationConfig.companyEmail}>`,
      to: customer.email,
      cc: emailOptions?.cc,
      subject,
      html: htmlContent,
      text: textContent,
      attachments: [{
        filename: `photo-addendum${resolvedQuotationNumber ? `-${resolvedQuotationNumber}` : ''}.pdf`,
        content: pdfBuffer as Buffer,
        contentType: 'application/pdf',
      }],
    });

    return NextResponse.json({
      success: true,
      message: 'Photo addendum email sent successfully',
      recipient: customer.email,
      quotationNumber: resolvedQuotationNumber,
      products: productsWithPhotos.map(p => ({
        productId: p.productId,
        productName: p.productName,
        photoCount: p.photos.length,
      })),
      totalPhotos,
    });

  } catch (error) {
    loggerApi.error('Error sending photo addendum email:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to send photo addendum email', message: (error as Error).message },
      { status: 500 }
    );
  }
});
