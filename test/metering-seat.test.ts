import { describe, it, expect, afterEach } from "vitest";

import { deriveSeatId, detectCi } from "../src/metering/seat.js";

const USAGE_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

const CI_KEYS = [
  "CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI",
  "TRAVIS", "JENKINS_URL", "BUILDKITE", "TF_BUILD", "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER", "CODEBUILD_BUILD_ID", "HEROKU_TEST_RUN_ID", "DRONE",
];

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function stashCiEnv() {
  for (const k of CI_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}

describe("deriveSeatId", () => {
  it("produces a stable, charset-valid, opaque id", async () => {
    const a = await deriveSeatId("bvk_key_one");
    const b = await deriveSeatId("bvk_key_one");
    expect(a).toBeDefined();
    expect(a).toBe(b); // stable across calls on the same machine + key
    expect(USAGE_ID_PATTERN.test(a!)).toBe(true);
    expect(a!.startsWith("m-")).toBe(true);
  });

  it("differs by service-account key (per-account seats)", async () => {
    const a = await deriveSeatId("bvk_key_one");
    const b = await deriveSeatId("bvk_key_two");
    expect(a).not.toBe(b);
  });
});

describe("detectCi", () => {
  it("is false with no CI markers", () => {
    stashCiEnv();
    expect(detectCi()).toBe(false);
  });

  it("is true when a CI marker is present", () => {
    stashCiEnv();
    process.env["GITHUB_ACTIONS"] = "true";
    expect(detectCi()).toBe(true);
  });

  it("ignores falsey marker values", () => {
    stashCiEnv();
    process.env["CI"] = "false";
    expect(detectCi()).toBe(false);
  });
});
