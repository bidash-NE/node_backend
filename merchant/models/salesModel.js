const { prisma } = require("../lib/prisma");

/**
 * Get today's sales for a given business (merchant).
 * Includes only orders:
 *  - that contain items for this business_id
 *  - with status = 'COMPLETED'
 *  - created today (DATE(o.created_at) = CURDATE())
 *
 * We compute:
 *  - gross_sales: sum of (subtotal + delivery_fee) for that business
 *  - net_sales: gross minus proportional share of platform_fee
 *  - total_orders: number of distinct orders for this business today
 */
async function getTodaySalesForBusiness(business_id) {
  try {
    const bid = Number(business_id);
    if (!Number.isFinite(bid) || bid <= 0) {
      throw new Error("Invalid business_id. Must be a positive integer.");
    }

    // Check if business exists
    const business = await prisma.merchant_business_details.findUnique({
      where: { business_id: bid },
      select: { business_id: true },
    });

    if (!business) {
      throw new Error(`Business with ID ${bid} not found.`);
    }

    // Get today's date range (start to end of day)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Fetch all completed orders for this business from today
    const orders = await prisma.orders.findMany({
      where: {
        status: "COMPLETED",
        created_at: {
          gte: todayStart,
          lte: todayEnd,
        },
        order_items: {
          some: {
            business_id: bid,
          },
        },
      },
      select: {
        order_id: true,
        total_amount: true,
        platform_fee: true,
        order_items: {
          where: {
            business_id: bid,
          },
          select: {
            subtotal: true,
            delivery_fee: true,
          },
        },
      },
    });

    if (!orders.length) {
      return {
        business_id: bid,
        total_orders: 0,
        gross_sales: 0,
        net_sales: 0,
        currency: "Nu",
      };
    }

    let gross = 0;
    let net = 0;

    for (const order of orders) {
      // Calculate business share from this order
      let businessShare = 0;
      for (const item of order.order_items) {
        businessShare += Number(item.subtotal || 0) + Number(item.delivery_fee || 0);
      }

      const orderTotal = Number(order.total_amount || 0);
      const platformFee = Number(order.platform_fee || 0);

      gross += businessShare;

      // Calculate proportional platform fee share
      let feeShare = 0;
      if (orderTotal > 0 && platformFee > 0) {
        feeShare = platformFee * (businessShare / orderTotal);
      }

      net += businessShare - feeShare;
    }

    return {
      business_id: bid,
      total_orders: orders.length,
      gross_sales: Number(gross.toFixed(2)),
      net_sales: Number(net.toFixed(2)),
      currency: "Nu",
    };
  } catch (error) {
    console.error("getTodaySalesForBusiness error:", error);
    throw error;
  }
}

module.exports = {
  getTodaySalesForBusiness,
};