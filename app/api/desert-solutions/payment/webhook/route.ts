import { NextRequest, NextResponse } from 'next/server';
import { mercuryClient } from '@/lib/desert-solutions/mercury-client';
import { mercuryConfig } from '@/lib/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { loggerApi } from '@/lib/logger';
import { getProxyClient } from '@/lib/database-proxy/proxy-client';
import { sendEmail } from '@/lib/email/send-email';

/**
 * Payment webhook handler
 * POST /api/desert-solutions/payment/webhook
 *
 * Receives payment notifications from payment provider
 * Note: This uses webhook signature verification, NOT the Desert Solutions API auth
 */
export async function POST(req: NextRequest) {
  try {
    // Get webhook signature from headers
    const signature = req.headers.get('X-Webhook-Signature');
    const timestamp = req.headers.get('X-Webhook-Timestamp');

    if (!signature || !timestamp) {
      return NextResponse.json(
        { error: 'Missing webhook signature headers' },
        { status: 401 }
      );
    }

    // Get raw body for signature verification
    const body = await req.text();

    // Verify webhook signature
    const expectedSignature = createHmac('sha256', mercuryConfig.webhookSecret!)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      loggerApi.error('Invalid webhook signature', { timestamp, signatureLength: signatureBuffer.length });
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    // Parse webhook payload
    const event = JSON.parse(body);

    loggerApi.info('Received payment webhook:', {
      type: event.type,
      invoiceId: event.data?.invoiceId,
      status: event.data?.status,
    });

    // Handle different webhook event types
    switch (event.type) {
      case 'invoice.paid':
        await handleInvoicePaid(event.data);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data);
        break;

      case 'invoice.overdue':
        await handleInvoiceOverdue(event.data);
        break;

      default:
        loggerApi.warn('Unhandled webhook event type:', event.type);
    }

    // Acknowledge receipt
    return NextResponse.json({ received: true });

  } catch (error) {
    loggerApi.error('Error processing payment webhook:', error);
    return NextResponse.json(
      { error: 'Failed to process webhook', message: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * Handle invoice paid event
 */
async function handleInvoicePaid(data: any) {
  try {
    loggerApi.info('Processing invoice.paid event', { invoiceId: data.invoiceId });

    // 1. Get invoice details to find associated quotation
    const invoice = await mercuryClient.invoices.get(data.invoiceId);
    const customer = await mercuryClient.customers.get(invoice.customerId);

    // 2. Send payment confirmation email
    await sendEmail({
      to: customer.email,
      subject: `Payment Received - Invoice ${invoice.number}`,
      html: `
        <h2>Payment Confirmed</h2>
        <p>Dear ${customer.name},</p>
        <p>Thank you! We have received your payment for invoice ${invoice.number}.</p>
        <p><strong>Amount Paid:</strong> $${invoice.total.toFixed(2)}</p>
        <p><strong>Payment Date:</strong> ${new Date(data.paidAt || Date.now()).toLocaleDateString()}</p>
        <p>Your order is now being processed. We will notify you when it ships.</p>
        <p>If you have any questions, please don't hesitate to contact us.</p>
        <p>Best regards,<br>Desert Solutions Team</p>
      `,
      text: `Payment Confirmed\n\nDear ${customer.name},\n\nThank you! We have received your payment for invoice ${invoice.number}.\n\nAmount Paid: $${invoice.total.toFixed(2)}\nPayment Date: ${new Date(data.paidAt || Date.now()).toLocaleDateString()}\n\nYour order is now being processed. We will notify you when it ships.\n\nBest regards,\nDesert Solutions Team`,
    });

    loggerApi.info('Invoice paid confirmation email sent', {
      invoiceId: data.invoiceId,
      customerEmail: customer.email,
    });
  } catch (error) {
    loggerApi.error('Error handling invoice.paid event:', error);
    throw error;
  }
}

/**
 * Handle payment failed event
 */
async function handlePaymentFailed(data: any) {
  try {
    loggerApi.info('Processing invoice.payment_failed event', { invoiceId: data.invoiceId });

    // 1. Get invoice and customer details
    const invoice = await mercuryClient.invoices.get(data.invoiceId);
    const customer = await mercuryClient.customers.get(invoice.customerId);

    // 2. Send payment failure notification
    await sendEmail({
      to: customer.email,
      subject: `Payment Failed - Invoice ${invoice.number}`,
      html: `
        <h2>Payment Failed</h2>
        <p>Dear ${customer.name},</p>
        <p>We were unable to process your payment for invoice ${invoice.number}.</p>
        <p><strong>Amount Due:</strong> $${invoice.total.toFixed(2)}</p>
        <p><strong>Reason:</strong> ${data.failureReason || 'Payment method declined'}</p>
        <p>Please update your payment method and try again:</p>
        <p><a href="${invoice.paymentUrl}" style="background-color: #4338ca; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Pay Invoice</a></p>
        <p>If you need assistance, please contact us.</p>
        <p>Best regards,<br>Desert Solutions Team</p>
      `,
      text: `Payment Failed\n\nDear ${customer.name},\n\nWe were unable to process your payment for invoice ${invoice.number}.\n\nAmount Due: $${invoice.total.toFixed(2)}\nReason: ${data.failureReason || 'Payment method declined'}\n\nPlease update your payment method and try again:\n${invoice.paymentUrl}\n\nBest regards,\nDesert Solutions Team`,
    });

    loggerApi.info('Payment failure notification sent', {
      invoiceId: data.invoiceId,
      customerEmail: customer.email,
    });
  } catch (error) {
    loggerApi.error('Error handling invoice.payment_failed event:', error);
    throw error;
  }
}

/**
 * Handle invoice overdue event
 */
async function handleInvoiceOverdue(data: any) {
  try {
    loggerApi.info('Processing invoice.overdue event', { invoiceId: data.invoiceId });

    // 1. Get invoice and customer details
    const invoice = await mercuryClient.invoices.get(data.invoiceId);
    const customer = await mercuryClient.customers.get(invoice.customerId);

    // 2. Send overdue reminder email
    const daysPastDue = Math.floor(
      (Date.now() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    await sendEmail({
      to: customer.email,
      subject: `Payment Reminder - Invoice ${invoice.number} is Overdue`,
      html: `
        <h2>Payment Reminder</h2>
        <p>Dear ${customer.name},</p>
        <p>This is a friendly reminder that invoice ${invoice.number} is now ${daysPastDue} day(s) overdue.</p>
        <p><strong>Amount Due:</strong> $${invoice.total.toFixed(2)}</p>
        <p><strong>Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString()}</p>
        <p>Please submit payment as soon as possible to avoid any service interruptions:</p>
        <p><a href="${invoice.paymentUrl}" style="background-color: #4338ca; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Pay Invoice</a></p>
        <p>If you have already submitted payment, please disregard this notice.</p>
        <p>If you need to discuss payment arrangements, please contact us immediately.</p>
        <p>Best regards,<br>Desert Solutions Team</p>
      `,
      text: `Payment Reminder\n\nDear ${customer.name},\n\nThis is a friendly reminder that invoice ${invoice.number} is now ${daysPastDue} day(s) overdue.\n\nAmount Due: $${invoice.total.toFixed(2)}\nDue Date: ${new Date(invoice.dueDate).toLocaleDateString()}\n\nPlease submit payment as soon as possible:\n${invoice.paymentUrl}\n\nIf you have already submitted payment, please disregard this notice.\n\nBest regards,\nDesert Solutions Team`,
    });

    loggerApi.info('Overdue reminder sent', {
      invoiceId: data.invoiceId,
      customerEmail: customer.email,
      daysPastDue,
    });
  } catch (error) {
    loggerApi.error('Error handling invoice.overdue event:', error);
    throw error;
  }
}
