// src/services/pricing/rulesEngine.js
import { withConn, qConn } from "../../db/mysql.js";

/* ---------------- helpers ---------------- */
const safeStr = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};

const bpToRate = (bp) => Number(bp || 0) / 10000;
const roundInt = (n) => Math.round(Number(n || 0));
const calcPercentCents = (baseCents, bp) =>
  roundInt(Number(baseCents || 0) * bpToRate(bp));

const centsToNu = (cents) => Number((Number(cents || 0) / 100).toFixed(2));

export const nowSqlUtc = (dt = new Date()) => {
  const pad = (x) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(
    dt.getUTCDate()
  )} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(
    dt.getUTCSeconds()
  )}`;
};

/* ---------------- matchers ---------------- */
async function pickPlatformFeeRule(
  conn,
  { country_code, city_id, service_type, trip_type, channel, at }
) {
  const cc = safeStr(country_code);
  const city = safeStr(city_id);
  const svc = safeStr(service_type);
  const trip = safeStr(trip_type);
  const ch = safeStr(channel);

  console.log("Trip Type:", trip);

  const rows = await qConn(
    conn,
    `
    SELECT
      rule_id,
      country_code, city_id, service_type, trip_type, channel,
      fee_type, fee_percent_bp, fee_fixed_cents, min_cents, max_cents,
      apply_on,
      priority, is_active, starts_at, ends_at,
      (
        (country_code IS NOT NULL) +
        (city_id IS NOT NULL) +
        (service_type IS NOT NULL) +
        (trip_type IS NOT NULL) +
        (channel IS NOT NULL)
      ) AS specificity
    FROM platform_fee_rules
    WHERE is_active = 1
      AND starts_at <= ?
      AND (ends_at IS NULL OR ends_at > ?)
      AND (country_code IS NULL OR country_code = ?)
      AND (city_id IS NULL OR city_id = ?)
      AND (service_type IS NULL OR service_type = ?)
      AND (trip_type IS NULL OR trip_type = ?)
      AND (channel IS NULL OR channel = ?)
    ORDER BY specificity DESC, priority ASC, starts_at DESC, rule_id DESC
    LIMIT 1
    `,
    [at, at, cc, city, svc, trip, ch]
  );

  return rows[0] || null;
}

async function pickTaxRule(conn, { country_code, city_id, service_type, at }) {
  const cc = safeStr(country_code);
  const city = safeStr(city_id);
  const svc = safeStr(service_type);

  // Bhutan GST is 5% => rate_percent_bp = 500
  // taxable_base = platform_fee
  const rows = await qConn(
    conn,
    `
    SELECT
      tax_rule_id,
      country_code, city_id, service_type,
      tax_type,
      rate_percent_bp,
      tax_inclusive,
      taxable_base,
      priority, is_active, starts_at, ends_at,
      (
        (country_code IS NOT NULL) +
        (city_id IS NOT NULL) +
        (service_type IS NOT NULL)
      ) AS specificity
    FROM tax_rules
    WHERE is_active = 1
      AND starts_at <= ?
      AND (ends_at IS NULL OR ends_at > ?)
      AND tax_type = 'GST'
      AND taxable_base = 'platform_fee'
      AND (country_code IS NULL OR country_code = ?)
      AND (city_id IS NULL OR city_id = ?)
      AND (service_type IS NULL OR service_type = ?)
    ORDER BY specificity DESC, priority ASC, starts_at DESC, tax_rule_id DESC
    LIMIT 1
    `,
    [at, at, cc, city, svc]
  );

  return rows[0] || null;
}

/* ---------------- computations ---------------- */
function computePlatformFeeCents(rule, amounts) {
  if (!rule) {
    return { platform_fee_cents: 0, fee_breakdown: null };
  }

  const apply_on = rule.apply_on || "subtotal";

  const baseCents =
    apply_on === "fare_after_discounts"
      ? Number(
          amounts.fare_after_discounts_cents ??
            amounts.subtotal_cents ??
            0
        )
      : apply_on === "driver_take_home_base"
      ? Number(amounts.driver_take_home_base_cents ?? 0)
      : Number(amounts.subtotal_cents ?? 0);

  const fee_type = rule.fee_type;
  const percentBp = toInt(rule.fee_percent_bp, 0);
  const fixedCents = toInt(rule.fee_fixed_cents, 0);

  let raw = 0;
  let percentPart = 0;
  let fixedPart = 0;

  if (fee_type === "percent") {
    percentPart = calcPercentCents(baseCents, percentBp);
    raw = percentPart;
  } else if (fee_type === "fixed") {
    fixedPart = fixedCents;
    raw = fixedPart;
  } else if (fee_type === "mixed") {
    percentPart = calcPercentCents(baseCents, percentBp);
    fixedPart = fixedCents;
    raw = percentPart + fixedPart;
  } else {
    raw = 0;
  }

  const minCents = toInt(rule.min_cents, 0);
  const maxCents = toInt(rule.max_cents, 0);

  let finalFee = raw;
  if (minCents > 0) finalFee = Math.max(finalFee, minCents);
  if (maxCents > 0) finalFee = Math.min(finalFee, maxCents);

  return {
    platform_fee_cents: roundInt(finalFee),
    fee_breakdown: {
      apply_on,
      base_cents: roundInt(baseCents),
      fee_type,
      fee_percent_bp: percentBp,
      fee_fixed_cents: fixedCents,
      raw_fee_cents: roundInt(raw),
      min_cents: minCents,
      max_cents: maxCents,
      percent_part_cents: roundInt(percentPart),
      fixed_part_cents: roundInt(fixedPart),
    },
  };
}

function computeGstCents(taxRule, platformFeeCents) {
  if (!taxRule) return { gst_cents: 0, gst_breakdown: null };

  const rateBp = toInt(taxRule.rate_percent_bp, 0);
  const inclusive = toInt(taxRule.tax_inclusive, 0);

  let gst = 0;
  if (!inclusive) {
    gst = calcPercentCents(platformFeeCents, rateBp);
  } else {
    // embedded tax: gross - gross/(1+rate)
    const gross = Number(platformFeeCents || 0);
    const rate = bpToRate(rateBp);
    gst = roundInt(gross - gross / (1 + rate));
  }

  return {
    gst_cents: roundInt(gst),
    gst_breakdown: {
      tax_rule_id: taxRule.tax_rule_id,
      rate_percent_bp: rateBp,
      tax_inclusive: inclusive,
      taxable_base: taxRule.taxable_base,
      taxable_amount_cents: roundInt(platformFeeCents),
    },
  };
}

/* ---------------- public API ---------------- */
export async function computePlatformFeeAndGST(input) {
  const at = safeStr(input.at) || nowSqlUtc(new Date());

  return await withConn(async (conn) => {

    // Match fee rule
    const feeRule = await pickPlatformFeeRule(conn, {
      country_code: input.country_code,
      city_id: input.city_id,
      service_type: input.service_type,
      trip_type: input.trip_type,
      channel: input.channel,
      at,
    });

    console.log("Matched platform fee rule:", feeRule);

    // Compute platform fee
    const feeRes = computePlatformFeeCents(feeRule, {
      subtotal_cents: input.subtotal_cents,
      fare_after_discounts_cents: input.fare_after_discounts_cents,
      driver_take_home_base_cents: input.driver_take_home_base_cents,
    });
    console.log("Platform fee computation result:", feeRes);

    // Match GST rule
    const taxRule = await pickTaxRule(conn, {
      country_code: input.country_code,
      city_id: input.city_id,
      service_type: input.service_type,
      at,
    });
    console.log("Matched tax rule:", taxRule);

    // Compute GST on platform fee
    const gstRes = computeGstCents(taxRule, feeRes.platform_fee_cents);
    console.log("GST computation result:", gstRes);

    // Totals
    const subtotal_cents = toInt(input.subtotal_cents, 0);
    const platform_fee_cents = feeRes.platform_fee_cents;
    const gst_cents = gstRes.gst_cents;

    const total_payable_cents = subtotal_cents + platform_fee_cents + gst_cents;
    const driver_payout_cents = Math.max(subtotal_cents, 0);

    // Nu conversions
    const subtotal_nu = centsToNu(subtotal_cents);
    const platform_fee_nu = centsToNu(platform_fee_cents);
    const gst_nu = centsToNu(gst_cents);
    const total_payable_nu = centsToNu(total_payable_cents);
    const driver_payout_nu = centsToNu(driver_payout_cents);

    return {
      at,
      input: {
        country_code: input.country_code ?? null,
        city_id: input.city_id ?? null,
        service_type: input.service_type ?? null,
        trip_type: input.trip_type ?? null,
        channel: input.channel ?? null,

        subtotal_cents,
        subtotal_nu,

        fare_after_discounts_cents:
          input.fare_after_discounts_cents == null
            ? null
            : toInt(input.fare_after_discounts_cents, 0),

        driver_take_home_base_cents:
          input.driver_take_home_base_cents == null
            ? null
            : toInt(input.driver_take_home_base_cents, 0),
      },

      matched_rules: {
        platform_fee_rule: feeRule,
        tax_rule: taxRule,
      },

      amounts: {
        platform_fee_cents,
        platform_fee_nu,

        gst_cents,
        gst_nu,

        total_payable_cents,
        total_payable_nu,

        driver_payout_cents,
        driver_payout_nu,
      },

      receipt: [
        { label: "Subtotal", cents: subtotal_cents, nu: subtotal_nu },
        { label: "Platform fee", cents: platform_fee_cents, nu: platform_fee_nu },
        { label: "GST (5%)", cents: gst_cents, nu: gst_nu },
        { label: "Total payable", cents: total_payable_cents, nu: total_payable_nu },
      ],

      fee_breakdown: feeRes.fee_breakdown,
      gst_breakdown: gstRes.gst_breakdown,
    };
  });
}
