import { expect, test } from "bun:test";
import { isRegistryPropagationError } from "../scripts/registry-install.ts";

test("retry only npm propagation-related missing-version failures", () => {
  expect(
    isRegistryPropagationError(
      "npm error code ETARGET\nnpm error notarget No matching version found for lcu-auto@0.4.2.",
    ),
  ).toBe(true);
  expect(isRegistryPropagationError("npm error code E404\nnpm error 404 Not Found")).toBe(true);
  expect(isRegistryPropagationError("npm error code E401\nnpm error 401 Unauthorized")).toBe(false);
  expect(
    isRegistryPropagationError("npm error code EOTP\nTwo factor authentication required"),
  ).toBe(false);
  expect(isRegistryPropagationError("npm error code ETARGET\nUnexpected build failure")).toBe(
    false,
  );
});
