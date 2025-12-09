import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import {
  Quotation,
  generateQuotationNumber,
  calculateQuotationTotals,
  CurrencyCode
} from '@/lib/desert-solutions/quotation-types';
import { getProductById, getProductPrice } from '@/lib/desert-solutions/product-catalog';
import { quotationConfig } from '@/lib/config';
import { z } from 'zod';
import { getProxyClient } from '@/lib/database-proxy/proxy-client';
import { loggerApi } from '@/lib/logger';

// Extend function timeout for database proxy calls
export const maxDuration = 120;

const createQuotationSchema = z.object({
  customer: z.object({
    name: z.string(),
    company: z.string().optional(),
    email: z.string().email(),
    phone: z.string().optional(),
    address: z.object({
      street: z.string(),
      city: z.string(),
      state: z.string(),
      zip: z.string(),
      country: z.string(),
    }).optional(),
  }),
  items: z.array(z.object({
    productId: z.string(),
    variantId: z.string().optional(),
    quantity: z.number().positive(),
    customPrice: z.number().optional(), // Optional custom pricing
  })),
  terms: z.object({
    paymentTerms: z.string().optional(),
    deliveryTerms: z.string().optional(),
    warranty: z.string().optional(),
    leadTime: z.string().optional(),
    shippingCost: z.number().optional(),
    discount: z.object({
      amount: z.number(),
      description: z.string(),
    }).optional(),
  }).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  validityDays: z.number().optional(),
  currency: z.enum(['USD', 'EUR', 'CNY']).optional().default('USD'),
});

/**
 * Create new quotation
 * POST /api/desert-solutions/quotation/create
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const validated = createQuotationSchema.parse(body);
    const currency = validated.currency as CurrencyCode;

    // Build quotation items from product catalog with currency-specific pricing
    const quotationItems = validated.items.map((item, index) => {
      const product = getProductById(item.productId);
      if (!product) {
        throw new Error(`Product not found: ${item.productId}`);
      }

      // Determine the correct product ID for pricing (including variant)
      const pricingId = item.variantId || item.productId;

      // Use custom price if provided, otherwise use currency-specific catalog price
      const catalogPrice = getProductPrice(pricingId, currency) || product.basePrice;
      const unitPrice = item.customPrice ?? catalogPrice;
      const totalPrice = unitPrice * item.quantity;

      return {
        id: `${item.productId}-${index}`,
        name: product.name,
        description: product.shortDescription,
        quantity: item.quantity,
        unitPrice,
        totalPrice,
        specifications: product.specifications,
        images: product.images,
      };
    });

    // Calculate validity date
    const validityDays = validated.validityDays ?? quotationConfig.defaultValidityDays;
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    // Build quotation object
    const quotation: Partial<Quotation> = {
      id: generateQuotationNumber(),
      quotationNumber: generateQuotationNumber('QDS'),
      date: new Date(),
      customer: validated.customer,
      items: quotationItems,
      currency,
      terms: {
        validUntil,
        paymentTerms: validated.terms?.paymentTerms ?? 'Net 30',
        deliveryTerms: validated.terms?.deliveryTerms ?? 'FOB Origin',
        warranty: validated.terms?.warranty,
        leadTime: validated.terms?.leadTime,
        shippingCost: validated.terms?.shippingCost ?? 0,
        taxRate: quotationConfig.defaultTaxRate,
        discount: validated.terms?.discount,
      },
      notes: validated.notes,
      internalNotes: validated.internalNotes,
      status: 'draft',
    };

    // Calculate totals
    const totals = calculateQuotationTotals(quotation);
    const completeQuotation: Quotation = {
      ...quotation as Quotation,
      ...totals,
    };

    // Store quotation in database
    const dbClient = getProxyClient();
    const storedResult = await dbClient.desertSolutions.createQuotation({
      quotationNumber: completeQuotation.quotationNumber,
      customerData: completeQuotation.customer,
      items: completeQuotation.items,
      currency: completeQuotation.currency,
      subtotal: completeQuotation.subtotal,
      tax: completeQuotation.tax,
      shipping: completeQuotation.shipping,
      discount: completeQuotation.discount,
      total: completeQuotation.total,
      terms: {
        validUntil: completeQuotation.terms.validUntil.toISOString(),
        paymentTerms: completeQuotation.terms.paymentTerms,
        deliveryTerms: completeQuotation.terms.deliveryTerms,
        warranty: completeQuotation.terms.warranty,
        leadTime: completeQuotation.terms.leadTime,
        shippingCost: completeQuotation.terms.shippingCost ?? 0,
        taxRate: completeQuotation.terms.taxRate ?? 0,
        discount: completeQuotation.terms.discount,
      },
      notes: completeQuotation.notes,
      internalNotes: completeQuotation.internalNotes,
      status: completeQuotation.status as "draft" | "sent" | "accepted" | "rejected" | "expired",
      date: completeQuotation.date.toISOString(),
    });

    return NextResponse.json({
      success: true,
      quotation: storedResult.quotation,
    }, { status: 201 });

  } catch (error) {
    loggerApi.error('Error creating quotation:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create quotation', message: (error as Error).message },
      { status: 500 }
    );
  }
});
