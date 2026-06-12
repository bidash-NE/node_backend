// models/salesModel.js
const { prisma } = require("../lib/prisma");

/**
 * Since wallet capture now happens on merchant accept,
 * today's dashboard sales should include accepted/active orders,
 * not only completed orders.
 */
const SALES_STATUSES = [
  "CONFIRMED",
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "PICKED_UP",
  "DELIVERED",
  "COMPLETED",
];

function n2(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * Bhutan local day range.
 * This works if your Node/backend server is already using Bhutan/local time.
 */
function getTodayRange() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  return {
    todayStart,
    todayEnd,
  };
}

/**
 * Get today's sales for a business.
 *
 * Model:
 * orders.total_amount = gross payable
 * total_amount = items + delivery - discount + full platform fee
 *
 * Merchant dashboard:
 * gross_sales = business item subtotal + delivery share - discount share
 * platform_fee_merchant_share = 50% of platform fee share
 * net_sales = gross_sales - platform_fee_merchant_share
 *
 * Example:
 * total_amount = 619
 * platform_fee = 29
 * merchant/order amount = 619 - 29 = 590
 * merchant platform fee = 14.5
 * net_sales = 590 - 14.5 = 575.5
 */
async function getTodaySalesForBusiness(business_id) {
  const bid = Number(business_id);

  if (!Number.isFinite(bid) || bid <= 0) {
    throw new Error("Invalid business_id. Must be a positive integer.");
  }

  const business = await prisma.merchant_business_details.findUnique({
    where: {
      business_id: bid,
    },
    select: {
      business_id: true,
    },
  });

  if (!business) {
    throw new Error(`Business with ID ${bid} not found.`);
  }

  const { todayStart, todayEnd } = getTodayRange();

  const orders = await prisma.orders.findMany({
    where: {
      status: {
        in: SALES_STATUSES,
      },
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
      business_id: true,
      status: true,
      total_amount: true,
      platform_fee: true,
      delivery_fee: true,
      discount_amount: true,
      created_at: true,

      // Items belonging to this merchant
      order_items: {
        select: {
          business_id: true,
          subtotal: true,
        },
      },
    },
  });

  if (!orders.length) {
    return {
      business_id: bid,
      total_orders: 0,
      gross_sales: 0,
      platform_fee_total_share: 0,
      platform_fee_merchant_share: 0,
      net_sales: 0,
      currency: "Nu",
      counted_statuses: SALES_STATUSES,
    };
  }

  let grossSales = 0;
  let platformFeeTotalShare = 0;
  let merchantPlatformFeeShare = 0;
  let netSales = 0;

  for (const order of orders) {
    const allItemsSubtotal = n2(
      order.order_items.reduce(
        (sum, item) => sum + Number(item.subtotal || 0),
        0,
      ),
    );

    const businessItemsSubtotal = n2(
      order.order_items
        .filter((item) => Number(item.business_id) === bid)
        .reduce((sum, item) => sum + Number(item.subtotal || 0), 0),
    );

    if (!(businessItemsSubtotal > 0)) continue;

    const ratio =
      allItemsSubtotal > 0 ? businessItemsSubtotal / allItemsSubtotal : 1;

    const deliveryFee = n2(order.delivery_fee);
    const discountAmount = n2(order.discount_amount);
    const platformFee = n2(order.platform_fee);

    const businessDeliveryShare = n2(deliveryFee * ratio);
    const businessDiscountShare = n2(discountAmount * ratio);
    const businessPlatformFeeShare = n2(platformFee * ratio);

    // Merchant/order amount before merchant-side platform deduction
    const businessGross = n2(
      businessItemsSubtotal + businessDeliveryShare - businessDiscountShare,
    );

    // Your platform fee model: 50% user, 50% merchant
    const businessMerchantPlatformFee = n2(businessPlatformFeeShare * 0.5);

    const businessNet = n2(businessGross - businessMerchantPlatformFee);

    grossSales = n2(grossSales + businessGross);
    platformFeeTotalShare = n2(platformFeeTotalShare + businessPlatformFeeShare);
    merchantPlatformFeeShare = n2(
      merchantPlatformFeeShare + businessMerchantPlatformFee,
    );
    netSales = n2(netSales + businessNet);
  }

  return {
    business_id: bid,
    total_orders: orders.length,

    // Amount credited from buyer to merchant before merchant platform fee
    gross_sales: grossSales,

    // Full platform fee allocated to this business/order share
    platform_fee_total_share: platformFeeTotalShare,

    // Merchant-side 50% platform fee deduction
    platform_fee_merchant_share: merchantPlatformFeeShare,

    // Actual merchant net after merchant platform fee
    net_sales: netSales,

    currency: "Nu",
    counted_statuses: SALES_STATUSES,
  };
}

module.exports = {
  getTodaySalesForBusiness,
};