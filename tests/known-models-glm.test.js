import { describe, expect, it } from "vitest";
import { lookupKnown } from "../shared/known-models.js";

describe("known GLM models", () => {
  it("marks glm-5.1 as a reasoning model", () => {
    const model = lookupKnown("glm", "glm-5.1");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
  });

  it("marks glm-5-turbo as a reasoning model", () => {
    const model = lookupKnown("glm", "glm-5-turbo");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
  });
});
