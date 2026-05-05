const { prisma } = require("../lib/prisma.js");

// ===== helpers =====
function toDbIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toDbStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

async function logAdmin(conn, actorUserId, adminName, activity) {
  try {
    const logData = {
      admin_name: toDbStrOrNull(adminName),
      activity: toDbStrOrNull(activity),
      created_at: new Date(),
    };

    if (actorUserId && actorUserId > 0) {
      logData.users = {
        connect: { user_id: Number(actorUserId) },
      };
    }

    await prisma.admin_logs.create({
      data: logData,
    });
  } catch (error) {
    console.error("Error logging admin action:", error);
  }
}

// ✅ Users (role='user') + points (wallet fetched separately)
async function fetchUsersByRole() {
  const users = await prisma.users.findMany({
    where: {
      role: "user",
    },
    include: {
      // wallet: true,  // ❌ REMOVED
    },
    orderBy: {
      user_name: "asc",
    },
  });

  // Fetch wallet info for all users
  const usersWithWallets = await Promise.all(
    users.map(async (user) => {
      let walletInfo = null;
      try {
        walletInfo = await prisma.wallets.findUnique({
          where: { user_id: Number(user.user_id) },
        });
      } catch (error) {
        // Wallet might not exist for this user
      }

      return {
        user_id: Number(user.user_id),
        user_name: user.user_name,
        email: user.email,
        phone: user.phone,
        is_verified: user.is_verified,
        is_active: user.is_active,
        role: user.role,
        profile_image: user.profile_image,
        points: Number(user.points ?? 0),
        wallet_id: walletInfo?.wallet_id || null,
        wallet_amount: walletInfo?.amount ? Number(walletInfo.amount) : null,
      };
    }),
  );

  return usersWithWallets;
}

// ✅ Drivers (role='driver') + license/vehicles + avg_rating + points
async function fetchDrivers() {
  const users = await prisma.users.findMany({
    where: {
      role: "driver",
    },
    include: {
      // wallet: true,  // ❌ REMOVED
      drivers: true,
    },
    orderBy: {
      user_name: "asc",
    },
  });

  const detailedDrivers = await Promise.all(
    users.map(async (user) => {
      const driverInfo = user.drivers;
      const driver_id = driverInfo?.driver_id
        ? Number(driverInfo.driver_id)
        : null;
      const license_number = driverInfo?.license_number || null;

      // Get wallet info
      let walletInfo = null;
      try {
        walletInfo = await prisma.wallets.findUnique({
          where: { user_id: Number(user.user_id) },
        });
      } catch (error) {
        // Wallet might not exist for this user
      }

      // Get vehicles using raw SQL to avoid features column issue
      let vehicles = [];
      if (driver_id) {
        const vehicleRows = await prisma.$queryRaw`
          SELECT 
            vehicle_id, 
            make, 
            color, 
            license_plate, 
            vehicle_type,
            features
          FROM driver_vehicles 
          WHERE driver_id = ${driver_id}
        `;

        vehicles = vehicleRows.map((v) => ({
          vehicle_id: Number(v.vehicle_id),
          make: v.make,
          color: v.color,
          license_plate: v.license_plate,
          vehicle_type: v.vehicle_type,
          features: v.features || null,
        }));
      }

      // Get average rating using Prisma
      let avg_rating = null;
      if (driver_id) {
        const ratings = await prisma.ride_ratings.aggregate({
          where: {
            driver_id: driver_id,
            payment_status: true,
          },
          _avg: {
            rating: true,
          },
        });

        if (ratings._avg.rating !== null) {
          avg_rating = Number(ratings._avg.rating);
        }
      }

      return {
        user_id: Number(user.user_id),
        user_name: user.user_name,
        email: user.email,
        phone: user.phone,
        is_verified: user.is_verified,
        is_active: user.is_active,
        role: user.role,
        profile_image: user.profile_image || null,
        wallet_id: walletInfo?.wallet_id || null,
        wallet_amount: walletInfo?.amount ? Number(walletInfo.amount) : null,
        points: Number(user.points ?? 0),
        driver_id: driver_id,
        license_number: license_number,
        vehicles: vehicles,
        avg_rating: avg_rating,
      };
    }),
  );

  return detailedDrivers;
}

// ✅ Admins (role in 'admin','superadmin') + points
async function fetchAdmins() {
  const admins = await prisma.users.findMany({
    where: {
      role: {
        in: ["admin", "superadmin"],
      },
    },
    include: {
      // wallet: true,  // ❌ REMOVED
    },
    orderBy: {
      user_name: "asc",
    },
  });

  // Fetch wallet info for all admins
  const adminsWithWallets = await Promise.all(
    admins.map(async (admin) => {
      let walletInfo = null;
      try {
        walletInfo = await prisma.wallets.findUnique({
          where: { user_id: Number(admin.user_id) },
        });
      } catch (error) {
        // Wallet might not exist for this admin
      }

      return {
        user_id: Number(admin.user_id),
        user_name: admin.user_name,
        email: admin.email,
        phone: admin.phone,
        is_active: admin.is_active,
        role: admin.role,
        profile_image: admin.profile_image,
        points: Number(admin.points ?? 0),
        wallet_id: walletInfo?.wallet_id || null,
        wallet_amount: walletInfo?.amount ? Number(walletInfo.amount) : null,
      };
    }),
  );

  return adminsWithWallets;
}

// ✅ Merchants with business details + wallet_id + average_rating + points
async function fetchMerchantsWithBusiness() {
  const merchants = await prisma.users.findMany({
    where: {
      role: "merchant",
    },
    include: {
      // wallet: true,  // ❌ REMOVED
      merchant_business_details: true,
    },
    orderBy: {
      user_name: "asc",
    },
  });

  const merchantsWithDetails = await Promise.all(
    merchants.map(async (merchant) => {
      const business = merchant.merchant_business_details[0] || {};
      const ownerType = business.owner_type;
      const businessId = business.business_id
        ? Number(business.business_id)
        : null;

      // Get average rating based on owner_type using Prisma
      let avg_rating = null;
      if (businessId && ownerType) {
        if (ownerType === "mart") {
          const ratings = await prisma.mart_ratings.aggregate({
            where: { business_id: businessId },
            _avg: { rating: true },
          });
          if (ratings._avg.rating !== null) {
            avg_rating = Number(ratings._avg.rating);
          }
        } else if (ownerType === "food") {
          const ratings = await prisma.food_ratings.aggregate({
            where: { business_id: businessId },
            _avg: { rating: true },
          });
          if (ratings._avg.rating !== null) {
            avg_rating = Number(ratings._avg.rating);
          }
        }
      }

      // Fetch wallet info separately
      let walletInfo = null;
      try {
        walletInfo = await prisma.wallets.findUnique({
          where: { user_id: Number(merchant.user_id) },
        });
      } catch (error) {
        // Wallet might not exist for this user
      }

      return {
        user_id: Number(merchant.user_id),
        user_name: merchant.user_name,
        email: merchant.email,
        phone: merchant.phone,
        is_verified: merchant.is_verified,
        is_active: merchant.is_active,
        role: merchant.role,
        profile_image: merchant.profile_image || business.business_logo,
        points: Number(merchant.points ?? 0),
        wallet_id: walletInfo?.wallet_id || null,
        wallet_amount: walletInfo?.amount ? Number(walletInfo.amount) : null,
        business_id: businessId,
        business_name: business.business_name,
        owner_type: business.owner_type,
        business_logo: business.business_logo,
        opening_time: business.opening_time,
        closing_time: business.closing_time,
        address: business.address,
        business_created_at: business.created_at,
        business_updated_at: business.updated_at,
        average_rating: avg_rating,
      };
    }),
  );

  return merchantsWithDetails;
}

// ===== admin ops =====
async function deactivateUser(user_id, actorUserId = null, adminName = null) {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: Number(user_id) },
      select: { user_id: true, user_name: true, is_active: true },
    });

    if (!user) {
      return { notFound: true };
    }

    if (user.is_active === false) {
      return { updated: false, already: "deactivated" };
    }

    await prisma.users.update({
      where: { user_id: Number(user_id) },
      data: { is_active: false },
    });

    await logAdmin(
      null,
      actorUserId,
      adminName,
      `Deactivated user "${user.user_name}" (id: ${user_id})`,
    );

    return { updated: true };
  } catch (error) {
    console.error("Deactivate user error:", error);
    throw error;
  }
}

async function activateUser(user_id, actorUserId = null, adminName = null) {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: Number(user_id) },
      select: { user_id: true, user_name: true, is_active: true },
    });

    if (!user) {
      return { notFound: true };
    }

    if (user.is_active === true) {
      return { updated: false, already: "active" };
    }

    await prisma.users.update({
      where: { user_id: Number(user_id) },
      data: { is_active: true },
    });

    await logAdmin(
      null,
      actorUserId,
      adminName,
      `Activated user "${user.user_name}" (id: ${user_id})`,
    );

    return { updated: true };
  } catch (error) {
    console.error("Activate user error:", error);
    throw error;
  }
}

async function deleteUser(user_id, actorUserId = null, adminName = null) {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: Number(user_id) },
      select: { user_id: true, user_name: true },
    });

    if (!user) {
      return { notFound: true };
    }

    await prisma.users.delete({
      where: { user_id: Number(user_id) },
    });

    await logAdmin(
      null,
      actorUserId,
      adminName,
      `Deleted user "${user.user_name}" (id: ${user_id})`,
    );

    return { deleted: true };
  } catch (error) {
    if (error.code === "P2003") {
      const customError = new Error("ER_ROW_IS_REFERENCED_2");
      customError.code = "ER_ROW_IS_REFERENCED_2";
      throw customError;
    }
    throw error;
  }
}

module.exports = {
  fetchUsersByRole,
  fetchDrivers,
  fetchAdmins,
  fetchMerchantsWithBusiness,
  deactivateUser,
  activateUser,
  deleteUser,
};
