import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { checkoutSchema } from '../utils/validation';
import { stripe, calculateStripeFee } from '../services/payment';
import { env } from '../config/env';

const router = Router();
const prisma = new PrismaClient();

// POST /api/checkout-session
router.post('/', async (req, res) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const { storeId, cartItems, phoneE164, consentCall, consentSms, tipCents } = body;

    // Verify store exists
    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Fetch menu items and calculate totals from DB (don't trust client)
    const menuItemIds = cartItems.map((item) => item.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: {
        id: { in: menuItemIds },
        storeId,
        isAvailable: true,
      },
    });

    if (menuItems.length !== cartItems.length) {
      return res.status(400).json({ error: 'Some items are not available' });
    }

    // Calculate totals
    let subtotalCents = 0;
    const orderItemsData: any[] = [];

    for (const cartItem of cartItems) {
      const menuItem = menuItems.find((m: any) => m.id === cartItem.menuItemId);
      if (!menuItem) continue;

      const itemTotal = menuItem.priceCents * cartItem.quantity;
      subtotalCents += itemTotal;

      orderItemsData.push({
        menuItemId: menuItem.id,
        nameSnapshot: menuItem.name,
        priceCentsSnapshot: menuItem.priceCents,
        costCentsSnapshot: menuItem.costCents,
        quantity: cartItem.quantity,
      });
    }

    const taxCents = 0; // No tax for MVP
    const totalCents = subtotalCents + taxCents + tipCents;

    // Get next order number for this store
    const lastOrder = await prisma.order.findFirst({
      where: { storeId },
      orderBy: { orderNumber: 'desc' },
      select: { orderNumber: true },
    });

    const orderNumber = (lastOrder?.orderNumber || 0) + 1;

    // Create order with PENDING payment status
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber,
        customerPhoneE164: phoneE164,
        consentCall,
        consentSms,
        status: 'PLACED',
        paymentStatus: 'PENDING',
        subtotalCents,
        taxCents,
        tipCents,
        totalCents,
        currency: 'usd',
        items: {
          create: orderItemsData,
        },
      },
    });

    // Create Stripe checkout session
    const lineItems = menuItems.map((menuItem: any) => {
      const cartItem = cartItems.find((c) => c.menuItemId === menuItem.id)!;
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: menuItem.name,
            description: menuItem.description || undefined,
          },
          unit_amount: menuItem.priceCents,
        },
        quantity: cartItem.quantity,
      };
    });

    // Add tip as a line item if provided
    if (tipCents > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Tip',
            description: 'Gratuity for service',
          },
          unit_amount: tipCents,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_URL}/cancel?order_id=${order.id}`,
      metadata: {
        orderId: order.id,
        storeId,
      },
    });

    // Update order with checkout session ID
    await prisma.order.update({
      where: { id: order.id },
      data: { stripeCheckoutSessionId: session.id },
    });

    res.json({
      sessionId: session.id,
      sessionUrl: session.url,
      orderId: order.id,
    });
  } catch (error: any) {
    console.error('Checkout error:', error);
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;
