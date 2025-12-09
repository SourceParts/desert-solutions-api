import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { Quotation, formatCurrency as formatCurrencyHelper, CurrencyCode } from '@/lib/desert-solutions/quotation-types';
import { quotationConfig } from '@/lib/config';
import { z } from 'zod';
import { sendEmail } from '@/lib/email/send-email';
import { renderToBuffer } from '@react-pdf/renderer';
import QuotationPDF from '@/lib/desert-solutions/quotation-pdf';
import React from 'react';
import { getProxyClient } from '@/lib/database-proxy/proxy-client';
import { loggerApi } from '@/lib/logger';
import { DocumentStatus, DEFAULT_DOCUMENT_STATUS, isValidDocumentStatus, getStatusLabel, getStatusColor, generateDocumentHash } from '@/lib/utils/pdf';

// Force Node.js runtime for @react-pdf/renderer native bindings
export const runtime = 'nodejs';

const customerSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  salutation: z.string().optional(), // e.g., "Mr. Aldewereld" for formal salutation
}).passthrough();

const emailQuotationSchema = z.object({
  quotationId: z.string().optional(), // UUID from database
  quotation: z.object({
    quotationNumber: z.string(),
    customer: customerSchema.optional(),
    customerData: customerSchema.optional(),
  }).passthrough().optional(),
  emailOptions: z.object({
    subject: z.string().optional(),
    message: z.string().optional(),
    cc: z.array(z.string().email()).optional(),
    attachPDF: z.boolean().optional().default(true),
  }).optional(),
  documentStatus: z.enum(['WIP', 'RC', 'FINAL']).optional().default('WIP'),
}).refine((data) => data.quotationId || data.quotation, {
  message: "Either quotationId or quotation must be provided",
}).refine((data) => !data.quotation || data.quotation.customer || data.quotation.customerData, {
  message: "Quotation must have customer or customerData",
});

/**
 * Email quotation to customer
 * POST /api/desert-solutions/quotation/email
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const validated = emailQuotationSchema.parse(body);
    const { quotationId, emailOptions, documentStatus } = validated;
    let quotation = validated.quotation;

    // If only quotationId provided, fetch full quotation from database
    if (quotationId && !quotation) {
      const dbClient = getProxyClient();
      const result = await dbClient.desertSolutions.getQuotation(quotationId);

      if (!result.success || !result.quotation) {
        return NextResponse.json(
          { error: 'Quotation not found' },
          { status: 404 }
        );
      }

      quotation = result.quotation as any;
    }

    if (!quotation) {
      return NextResponse.json(
        { error: 'Quotation data not available' },
        { status: 400 }
      );
    }

    // Normalize customer data (handle both customer and customerData)
    const customer = (quotation as any).customer || (quotation as any).customerData;
    if (!customer) {
      return NextResponse.json(
        { error: 'Customer data not available' },
        { status: 400 }
      );
    }

    // Build email subject with status indicator for non-final releases
    const statusLabel = getStatusLabel(documentStatus);
    const subjectStatusSuffix = statusLabel ? ` - ${statusLabel}` : '';
    const subject = emailOptions?.subject ??
      `${quotationConfig.companyName} - Quotation [${quotation.quotationNumber}]${subjectStatusSuffix}`;

    // Generate document hash for audit trail
    const documentHash = generateDocumentHash(
      `Quotation-${quotation.quotationNumber}-${new Date().toISOString().split('T')[0]}`
    );

    // Get quotation data
    const q = quotation as any;

    // Format currency helper using quotation's currency
    const currency = (q.currency || 'USD') as CurrencyCode;
    const formatCurrency = (amount: number | undefined) => {
      return formatCurrencyHelper(amount || 0, currency);
    };
    // Use salutation if provided, otherwise use first name
    const salutation = customer.salutation || customer.name.split(' ')[0];

    // Get status color for badge
    const statusColor = getStatusColor(documentStatus);

    // Build HTML email content
    const statusBadgeHtml = statusLabel
      ? `<span style="background-color: ${statusColor}; color: #ffffff; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-left: 10px; vertical-align: middle;">${statusLabel}</span>`
      : '';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4338ca;">Quotation ${statusBadgeHtml}</h2>

        <p>Dear ${salutation},</p>

        <p>Thank you for your interest in ${quotationConfig.companyName}. Please find attached your quotation with detailed pricing and specifications for the requested equipment.</p>

        <h3 style="color: #2c3e50;">Quotation Summary</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Quotation Number:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${quotation.quotationNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Date:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${q.date ? new Date(q.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Status:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${(q.status || 'Draft').toUpperCase()}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Valid Until:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${q.terms?.validUntil ? new Date(q.terms.validUntil).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '30 days from date'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Customer:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${customer.name}${customer.company ? ` - ${customer.company}` : ''}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Items:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${q.items?.length || 0} product(s)</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Subtotal:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${formatCurrency(q.subtotal)}</td>
          </tr>
          ${q.tax > 0 ? `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Tax:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${formatCurrency(q.tax)}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Total:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0; font-weight: bold; color: #4338ca;">${formatCurrency(q.total)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Payment Terms:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${q.terms?.paymentTerms || 'Net 30'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;"><strong>Delivery Terms:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${q.terms?.deliveryTerms || 'FOB'}</td>
          </tr>
        </table>

        ${emailOptions?.message ? `<p>${emailOptions.message}</p>` : ''}

        <p>If you have any questions or would like to proceed with your order, please don't hesitate to contact us.</p>

        <p>Best regards,<br>
        <strong>José Angel Torres</strong><br>
        Sales Director, ${quotationConfig.companyName}<br>
        <a href="mailto:${quotationConfig.companyEmail}">${quotationConfig.companyEmail}</a><br>
        <a href="${quotationConfig.companyWebsite}">${quotationConfig.companyWebsite}</a></p>

        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">

        <p style="color: #64748b; font-size: 11px;">
          This email and any attachments are confidential and intended solely for the addressee.
          If you have received this email in error, please notify the sender immediately and delete this email.
        </p>
      </div>
    `;

    // Build plain text version
    const statusTextLabel = statusLabel ? ` [${statusLabel}]` : '';
    const textContent = `
Quotation${statusTextLabel}

Dear ${salutation},

Thank you for your interest in ${quotationConfig.companyName}. Please find attached your quotation with detailed pricing and specifications for the requested equipment.

Quotation Summary:
- Quotation Number: ${quotation.quotationNumber}
- Date: ${q.date ? new Date(q.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'}
- Status: ${(q.status || 'Draft').toUpperCase()}
- Valid Until: ${q.terms?.validUntil ? new Date(q.terms.validUntil).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '30 days from date'}
- Customer: ${customer.name}${customer.company ? ` - ${customer.company}` : ''}
- Items: ${q.items?.length || 0} product(s)
- Subtotal: ${formatCurrency(q.subtotal)}
${q.tax > 0 ? `- Tax: ${formatCurrency(q.tax)}\n` : ''}- Total: ${formatCurrency(q.total)}
- Payment Terms: ${q.terms?.paymentTerms || 'Net 30'}
- Delivery Terms: ${q.terms?.deliveryTerms || 'FOB'}

${emailOptions?.message ? `${emailOptions.message}\n\n` : ''}If you have any questions or would like to proceed with your order, please don't hesitate to contact us.

Best regards,
José Angel Torres
Sales Director, ${quotationConfig.companyName}
${quotationConfig.companyEmail}
${quotationConfig.companyWebsite}

This email and any attachments are confidential and intended solely for the addressee.
    `.trim();

    // Generate PDF if requested
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

    if (emailOptions?.attachPDF !== false) {
      // Normalize quotation for PDF: ensure customer field exists
      const normalizedQuotation = {
        ...quotation,
        customer,
      };
      const pdfBuffer = await renderToBuffer(
        <QuotationPDF quotation={normalizedQuotation as Quotation} documentStatus={documentStatus} documentHash={documentHash} />
      );

      attachments.push({
        filename: `quotation-${quotation.quotationNumber}.pdf`,
        content: pdfBuffer as Buffer,
        contentType: 'application/pdf',
      });
    }

    // Send email with Resend
    await sendEmail({
      from: `José Angel Torres <${quotationConfig.companyEmail}>`,
      to: customer.email,
      cc: emailOptions?.cc,
      subject,
      html: htmlContent,
      text: textContent,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return NextResponse.json({
      success: true,
      message: 'Email sent successfully',
      recipient: customer.email,
    });

  } catch (error) {
    loggerApi.error('Error sending quotation email:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to send email', message: (error as Error).message },
      { status: 500 }
    );
  }
});
