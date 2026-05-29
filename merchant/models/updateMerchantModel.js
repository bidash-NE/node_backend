const { prisma } = require("../lib/prisma");

async function updateMerchantBusinessDetails(business_id, updateFields) {
  const allowedFields = [
    "business_name",
    "latitude",
    "longitude",
    "address",
    "business_logo",
    "license_image",
    "delivery_option",
    "complementary",
    "complementary_details",
    "opening_time",
    "closing_time",
    "kitchen_closing_time",
    "holidays",
    "special_celebration",
    "special_celebration_discount_percentage",
    "min_amount_for_fd",
  ];

  const updateData = {};

  for (const field of allowedFields) {
    if (updateFields[field] !== undefined) {
      if (field === "holidays" && Array.isArray(updateFields[field])) {
        updateData[field] = JSON.stringify(updateFields[field]);
      } else if (field === "latitude" || field === "longitude") {
        // Convert to number or null
        updateData[field] = updateFields[field] === "" || updateFields[field] === null 
          ? null 
          : Number(updateFields[field]);
      } else if (field === "min_amount_for_fd") {
        // Handle min_amount_for_fd conversion
        const raw = String(updateFields[field] ?? "").trim();
        updateData[field] = raw === "" ? null : Number(raw);
      } else {
        updateData[field] = updateFields[field];
      }
    }
  }

  if (Object.keys(updateData).length === 0) return false;

  // Add updated_at timestamp
  updateData.updated_at = new Date();

  const result = await prisma.merchant_business_details.update({
    where: { business_id: business_id },
    data: updateData,
  });

  return true;
}

async function getMerchantBusinessDetailsById(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    include: {
      users: {
        select: {
          user_id: true,
          user_name: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  if (!business) return null;

  // Format the response
  return {
    business_id: Number(business.business_id),
    user_id: Number(business.user_id),
    business_name: business.business_name,
    business_license_number: business.business_license_number,
    license_image: business.license_image,
    latitude: business.latitude,
    longitude: business.longitude,
    address: business.address,
    business_logo: business.business_logo,
    delivery_option: business.delivery_option,
    complementary: business.complementary,
    complementary_details: business.complementary_details,
    opening_time: business.opening_time,
    closing_time: business.closing_time,
    kitchen_closing_time: business.kitchen_closing_time,
    holidays: business.holidays,
    special_celebration: business.special_celebration,
    special_celebration_discount_percentage: business.special_celebration_discount_percentage,
    min_amount_for_fd: business.min_amount_for_fd,
    owner_type: business.owner_type,
    created_at: business.created_at,
    updated_at: business.updated_at,
    user: business.users ? {
      user_id: Number(business.users.user_id),
      user_name: business.users.user_name,
      email: business.users.email,
      phone: business.users.phone,
    } : null,
  };
}

async function clearSpecialCelebrationByBusinessId(business_id) {
  const result = await prisma.merchant_business_details.update({
    where: { business_id: business_id },
    data: {
      special_celebration: null,
      special_celebration_discount_percentage: null,
      updated_at: new Date(),
    },
  });

  return true;
}

module.exports = {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
  clearSpecialCelebrationByBusinessId,
};