import http from "k6/http";
import { check, fail, sleep } from "k6";

const origin = __ENV.API_URL ?? "http://localhost:4000";
if (
  !/^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/.test(
    origin,
  )
) {
  throw new Error("Use a local StreamForge instance for this load test.");
}
const api = `${origin}/api/v1`;
const vus = Number(__ENV.LOAD_VUS ?? 5);
const mode = __ENV.LOAD_MODE ?? "cancel";
if (
  !Number.isInteger(vus) ||
  vus < 1 ||
  vus > 100 ||
  !["cancel", "complete", "browse"].includes(mode)
) {
  throw new Error("Choose 1–100 VUs and cancel, complete, or browse mode.");
}

export const options = {
  scenarios: {
    load:
      mode === "browse"
        ? {
            executor: "constant-vus",
            vus,
            duration: __ENV.LOAD_DURATION ?? "15s",
          }
        : {
            executor: "per-vu-iterations",
            vus,
            iterations: 1,
            maxDuration: "2m",
          },
  },
  thresholds: { http_req_failed: ["rate<0.01"], checks: ["rate>0.99"] },
};

export function setup() {
  const users = [];
  for (let index = 0; index < Math.ceil(vus / 10); index++) {
    const response = http.post(
      `${api}/auth/register`,
      JSON.stringify({
        email: `load-${Date.now()}-${index}@example.test`,
        password: "Local-k6-password-test-2026!",
        displayName: "Load test",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    if (response.status !== 201)
      fail(`Account setup failed with HTTP ${response.status}`);
    users.push(response.cookies.sf_session[0].value);
  }
  return users;
}

export default function run(users) {
  const session = users[Math.floor((__VU - 1) / 10)];
  const headers = {
    Cookie: `sf_session=${session}`,
    "Content-Type": "application/json",
  };
  if (mode === "browse") {
    check(http.get(`${api}/videos?limit=20`, { headers }), {
      "library returned 200": (r) => r.status === 200,
    });
    sleep(0.25);
    return;
  }

  const response = http.post(
    `${api}/uploads`,
    JSON.stringify({
      filename: `load-${__VU}.mp4`,
      mimeType: "video/mp4",
      size: 1024,
    }),
    { headers, tags: { operation: "create" } },
  );
  if (!check(response, { "upload created": (r) => r.status === 201 })) return;
  const sessionUrl = `${api}/uploads/${response.json("id")}`;
  sleep(1);

  if (mode === "complete") {
    const signed = http.post(
      `${sessionUrl}/parts`,
      JSON.stringify({ partNumbers: [1] }),
      { headers },
    );
    if (!check(signed, { "part URL returned": (r) => r.status === 200 }))
      return;
    const upload = http.put(
      origin.includes("host.docker.internal")
        ? signed
            .json("urls.0.url")
            .replace("://localhost:", "://host.docker.internal:")
        : signed.json("urls.0.url"),
      new ArrayBuffer(1024),
      {
        headers: { Host: "localhost:9000" },
      },
    );
    if (!check(upload, { "part uploaded": (r) => r.status === 200 })) return;
    const completed = http.post(`${sessionUrl}/complete`, null, {
      headers,
      tags: { operation: "complete" },
    });
    if (check(completed, { "upload completed": (r) => r.status === 200 })) {
      http.del(`${api}/videos/${response.json("videoId")}`, null, { headers });
    }
    return;
  }
  check(
    http.del(sessionUrl, null, { headers, tags: { operation: "cancel" } }),
    { "session canceled": (r) => r.status === 204 },
  );
}
