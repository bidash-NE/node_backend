// Registration capacity test — ramps to ~1000 concurrent virtual users each
// registering one brand-new "customer" account against POST /api/register.
//
// Run (rate limiter on the target server must be raised first — see runbook):
//   BASE_URL=http://staging-host:3000 k6 run load-test/k6-register-test.js
//
// Each VU/iteration generates a unique phone+email so registrations never
// collide with each other or with driver/seed-load-test-users.js accounts.
// Cleanup after the run: delete users with phone LIKE '+97501%' and the
// matching user_devices rows (see driver/seed-load-test-users.js pattern).

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const VUS = Number(__ENV.VUS || 1000);
const DURATION = __ENV.DURATION || "1m";

const RUN_ID = Date.now().toString().slice(-6);
const PHONE_PREFIX = "+97501"; // distinct from seed-load-test-users.js's +97500

export const options = {
  scenarios: {
    register_storm: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<3000"],
  },
};

export default function () {
  const uid = `${RUN_ID}${__VU}${__ITER}`;
  const phone = `${PHONE_PREFIX}${uid}`.slice(0, 13);
  const email = `loadtestreg${uid}@example.test`;
  const deviceId = `loadtest-reg-device-${uid}`;

  const payload = {
    user: {
      user_name: `Load Test Reg ${uid}`,
      email,
      phone,
      password: "LoadTest!2026",
      role: "customer",
    },
    deviceID: deviceId,
  };

  const res = http.post(`${BASE_URL}/api/register`, JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "status is 201": (r) => r.status === 201,
    "not rate limited": (r) => r.status !== 429,
  });

  sleep(1);
}
