import { NextRequest, NextResponse } from 'next/server';
import { DESERT_SOLUTIONS_SECURITY } from '@/lib/desert-solutions/api-security';
import { mercuryClient } from '@/lib/desert-solutions/mercury-client';
import { z } from 'zod';
import { loggerApi } from '@/lib/logger';

// Request validation schema
const createInvoiceSchema = z.object({
  quotation: z.object({
    quotationNumber: z.string(),
    customer: z.object({
      name: z.string(),
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
      id: z.string(),
      name: z.string(),
      description: z.string(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative(),
      totalPrice: z.number().nonnegative(),
    })),
    subtotal: z.number().nonnegative(),
    tax: z.number().nonnegative(),
    shipping: z.number().nonnegative(),
    discount: z.number().nonnegative(),
    total: z.number().positive(),
    terms: z.object({
      validUntil: z.string(),
      paymentTerms: z.string(),
      deliveryTerms: z.string(),
    }),
    notes: z.string().optional(),
  }),
  sendEmail: z.boolean().optional().default(false),
  dueInDays: z.number().optional().default(30),
});

/**
 * Create invoice from quotation
 * POST /api/desert-solutions/invoice/create
 *
 * Creates an invoice using the configured payment provider (currently Mercury Bank)
 * Implementation is abstracted - changing providers won't affect API contract
 */
export const POST = DESERT_SOLUTIONS_SECURITY(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const validated = createInvoiceSchema.parse(body);
    const { quotation, sendEmail, dueInDays } = validated;

    // Step 1: Create or get customer
    const customer = await mercuryClient.customers.create({
      name: quotation.customer.name,
      email: quotation.customer.email,
      phone: quotation.customer.phone,
      address: quotation.customer.address,
    });

    // Step 2: Create invoice
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueInDays);

    const invoice = await mercuryClient.invoices.create({
      customerId: customer.id,
      dueDate: dueDate,
      lineItems: quotation.items.map(item => ({
        description: `${item.name} - ${item.description}`,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.totalPrice,
      })),
      subtotal: quotation.subtotal,
      tax: quotation.tax,
      shipping: quotation.shipping,
      discount: quotation.discount,
      total: quotation.total,
      notes: quotation.notes,
      sendEmail: sendEmail,
    });

    return NextResponse.json({
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.number,
        status: invoice.status,
        total: invoice.total,
        dueDate: invoice.dueDate,
        paymentUrl: invoice.paymentUrl,
        customerId: customer.id,
      },
    }, { status: 201 });

  } catch (error) {
    loggerApi.error('Error creating invoice:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create invoice', message: (error as Error).message },
      { status: 500 }
    );
  }
});
