import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { getProductById, getProductWithVariant } from '@/lib/desert-solutions/product-catalog';
import { getPhotosByProductId } from '@/lib/desert-solutions/product-photos';
import { getFile } from '@/lib/do-spaces';
import { quotationConfig } from '@/lib/config';
import { z } from 'zod';
import { sendEmail } from '@/lib/email/send-email';
import { renderToBuffer } from '@react-pdf/renderer';
import DatasheetPDF, { DatasheetData } from '@/lib/desert-solutions/DS-ACSC-400/datasheet-pdf';
import React from 'react';
import { loggerApi } from '@/lib/logger';
import { DocumentStatus, DEFAULT_DOCUMENT_STATUS, getStatusLabel, getStatusColor, generateDocumentHash } from '@/lib/utils/pdf';

// Force Node.js runtime for @react-pdf/renderer native bindings
export const runtime = 'nodejs';

const datasheetSchema = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  customer: z.object({
    name: z.string(),
    email: z.string().email(),
    company: z.string().optional(),
    salutation: z.string().optional(),
  }).optional(),
  emailOptions: z.object({
    subject: z.string().optional(),
    message: z.string().optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
  }).optional(),
  documentStatus: z.enum(['WIP', 'RC', 'FINAL']).optional().default('WIP'),
  language: z.enum(['en', 'nl']).optional().default('en'), // Language: en (English), nl (Dutch)
  languages: z.array(z.enum(['en', 'nl'])).optional(), // Multiple languages for multi-attachment emails
  returnPdf: z.boolean().optional().default(false), // If true, return PDF instead of sending email
});

/**
 * Fetch image as base64 data URL for PDF embedding
 */
async function fetchImageAsDataUrl(s3Key: string): Promise<string | null> {
  try {
    const file = await getFile(s3Key);
    if (!file?.Body) {
      return null;
    }

    const contentType = file.ContentType || 'image/jpeg';
    const base64 = file.Body.toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    loggerApi.error(`Failed to fetch image ${s3Key}:`, error);
    return null;
  }
}

/**
 * Build datasheet data from product catalog
 */
function buildDatasheetData(product: any, productImage?: string, sideViewImage?: string): DatasheetData {
  // Extract key specs for highlight boxes
  const keySpecs: Array<{ label: string; value: string }> = [];

  if (product.specifications['Cooling Capacity']) {
    keySpecs.push({ label: 'Cooling Capacity', value: product.specifications['Cooling Capacity'] });
  }
  if (product.specifications['Total Power Consumption']) {
    keySpecs.push({ label: 'Power Consumption', value: product.specifications['Total Power Consumption'] });
  }
  if (product.specifications['Refrigerant']) {
    keySpecs.push({ label: 'Refrigerant', value: product.specifications['Refrigerant'].split(' ')[0] });
  }
  if (product.specifications['Number of Compressors']) {
    keySpecs.push({ label: 'Compressors', value: product.specifications['Number of Compressors'] });
  }
  if (product.specifications['Temperature Control Range']) {
    keySpecs.push({ label: 'Temp Range', value: product.specifications['Temperature Control Range'] });
  }
  if (product.specifications['Dimensions (L×W×H)']) {
    keySpecs.push({ label: 'Dimensions', value: product.specifications['Dimensions (L×W×H)'] });
  }

  // Extract features from long description
  const features: string[] = [];
  const longDesc = product.longDescription || '';
  const featuresMatch = longDesc.match(/Key Features:([\s\S]*?)$/);
  if (featuresMatch) {
    const featureLines = featuresMatch[1].split('\n')
      .map((line: string) => line.replace(/^[•\-*]\s*/, '').trim())
      .filter((line: string) => line.length > 0);
    features.push(...featureLines);
  }

  // If no features extracted, add some default ones from specifications
  if (features.length === 0) {
    if (product.specifications['Compressor Type']) {
      features.push(product.specifications['Compressor Type']);
    }
    if (product.specifications['Safety Protection']) {
      features.push(`Safety: ${product.specifications['Safety Protection']}`);
    }
    if (product.specifications['Control System']) {
      features.push(product.specifications['Control System']);
    }
  }

  return {
    productId: product.id,
    sku: product.specifications['SKU'] || product.id.toUpperCase(),
    productName: product.name.replace('Desert Solutions ', ''),
    shortDescription: product.shortDescription,
    longDescription: longDesc.split('Key Features:')[0].trim(),
    specifications: product.specifications,
    keySpecs: keySpecs.slice(0, 4), // Max 4 key specs for highlight
    features,
    productImage,
    sideViewImage,
  };
}

/**
 * Generate datasheet PDF or send via email
 * POST /api/desert-solutions/datasheet
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const validated = datasheetSchema.parse(body);
    const { productId, variantId, customer, emailOptions, documentStatus, language, languages, returnPdf } = validated;

    // Get product from catalog
    const product = variantId
      ? getProductWithVariant(productId, variantId)
      : getProductById(productId);

    if (!product) {
      return NextResponse.json(
        { error: 'Product not found', productId },
        { status: 404 }
      );
    }

    // Fetch product images from photos (front view + side view)
    let productImage: string | undefined;
    let sideViewImage: string | undefined;
    const photoSet = getPhotosByProductId(productId.replace('-r407c', '').replace('-r290', ''));
    if (photoSet?.photos) {
      // Fetch front view (first photo)
      if (photoSet.photos[0]) {
        const frontUrl = await fetchImageAsDataUrl(photoSet.photos[0].s3Key);
        if (frontUrl) {
          productImage = frontUrl;
        }
      }
      // Fetch side view (second photo - "Full length view")
      if (photoSet.photos[1]) {
        const sideUrl = await fetchImageAsDataUrl(photoSet.photos[1].s3Key);
        if (sideUrl) {
          sideViewImage = sideUrl;
        }
      }
    }

    // Build datasheet data
    const datasheetData = buildDatasheetData(product, productImage, sideViewImage);

    // Generate document hash
    const documentHash = generateDocumentHash(
      `Datasheet-${datasheetData.sku}-${new Date().toISOString().split('T')[0]}`
    );

    // Determine which languages to generate
    const langsToGenerate = languages && languages.length > 0 ? languages : [language];

    // Generate PDFs for each language
    const pdfBuffers: Array<{ lang: 'en' | 'nl'; buffer: Buffer }> = [];
    for (const lang of langsToGenerate) {
      const buffer = await renderToBuffer(
        <DatasheetPDF data={datasheetData} documentStatus={documentStatus} documentHash={documentHash} language={lang} />
      );
      pdfBuffers.push({ lang, buffer: buffer as Buffer });
    }

    // If returnPdf is true, return the PDF directly (only single language supported)
    if (returnPdf) {
      // Convert Buffer to Uint8Array for NextResponse compatibility
      const uint8Array = new Uint8Array(pdfBuffers[0].buffer);
      return new NextResponse(uint8Array, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="datasheet-${datasheetData.sku}.pdf"`,
        },
      });
    }

    // Otherwise, send via email
    if (!customer?.email) {
      return NextResponse.json(
        { error: 'Customer email is required when returnPdf is false' },
        { status: 400 }
      );
    }

    // Get status label and color for badge
    const statusLabel = getStatusLabel(documentStatus);
    const statusColor = getStatusColor(documentStatus);
    const subjectStatusSuffix = statusLabel ? ` - ${statusLabel}` : '';

    const salutation = customer.salutation || customer.name.split(' ')[0];

    const subject = emailOptions?.subject ??
      `${quotationConfig.companyName} - Product Datasheet [${datasheetData.sku}]${subjectStatusSuffix}`;

    const statusBadgeHtml = statusLabel
      ? `<span style="background-color: ${statusColor}; color: #ffffff; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-left: 10px; vertical-align: middle;">${statusLabel}</span>`
      : '';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4338ca;">Product Datasheet ${statusBadgeHtml}</h2>

        <p>Dear ${salutation},</p>

        <p>Please find attached the technical datasheet for <strong>${datasheetData.productName}</strong>.</p>

        ${emailOptions?.message ? `<p>${emailOptions.message}</p>` : ''}

        <h3 style="color: #2c3e50;">Product Information</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Product:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${datasheetData.productName}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>SKU:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${datasheetData.sku}</td>
          </tr>
          ${datasheetData.keySpecs.slice(0, 2).map(spec => `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>${spec.label}:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${spec.value}</td>
          </tr>
          `).join('')}
        </table>

        <p>The attached PDF contains comprehensive technical specifications, key features, and product details.</p>

        <p>If you have any questions or would like a formal quotation, please don't hesitate to contact us.</p>

        <p>Best regards,<br>
        <strong>José Angel Torres</strong><br>
        Sales Director, ${quotationConfig.companyName}<br>
        <a href="mailto:${quotationConfig.companyEmail}">${quotationConfig.companyEmail}</a><br>
        <a href="${quotationConfig.companyWebsite}">${quotationConfig.companyWebsite}</a></p>

        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">

        <p style="color: #64748b; font-size: 11px;">
          This email and any attachments are confidential and intended solely for the addressee.
          Specifications are subject to change without notice.
        </p>
      </div>
    `;

    const statusTextLabel = statusLabel ? ` [${statusLabel}]` : '';
    const textContent = `
Product Datasheet${statusTextLabel}

Dear ${salutation},

Please find attached the technical datasheet for ${datasheetData.productName}.

${emailOptions?.message ? `${emailOptions.message}\n\n` : ''}Product Information:
- Product: ${datasheetData.productName}
- SKU: ${datasheetData.sku}
${datasheetData.keySpecs.slice(0, 2).map(spec => `- ${spec.label}: ${spec.value}`).join('\n')}

The attached PDF contains comprehensive technical specifications, key features, and product details.

If you have any questions or would like a formal quotation, please don't hesitate to contact us.

Best regards,
José Angel Torres
Sales Director, ${quotationConfig.companyName}
${quotationConfig.companyEmail}
${quotationConfig.companyWebsite}

This email and any attachments are confidential and intended solely for the addressee.
Specifications are subject to change without notice.
    `.trim();

    // Build attachments from generated PDFs
    const langLabels: Record<string, string> = { en: 'EN', nl: 'NL' };
    const attachments = pdfBuffers.map(({ lang, buffer }) => ({
      filename: pdfBuffers.length > 1
        ? `datasheet-${datasheetData.sku}-${langLabels[lang]}.pdf`
        : `datasheet-${datasheetData.sku}.pdf`,
      content: buffer,
      contentType: 'application/pdf',
    }));

    // Send email
    await sendEmail({
      from: `José Angel Torres <${quotationConfig.companyEmail}>`,
      to: customer.email,
      cc: emailOptions?.cc,
      bcc: emailOptions?.bcc,
      subject,
      html: htmlContent,
      text: textContent,
      attachments,
    });

    return NextResponse.json({
      success: true,
      message: 'Datasheet email sent successfully',
      recipient: customer.email,
      product: {
        id: product.id,
        name: datasheetData.productName,
        sku: datasheetData.sku,
      },
      languages: langsToGenerate,
      attachments: attachments.length,
      documentHash,
    });

  } catch (error) {
    loggerApi.error('Error generating datasheet:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to generate datasheet', message: (error as Error).message },
      { status: 500 }
    );
  }
});
