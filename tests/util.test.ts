import { describe, expect, it } from "vitest";
import { hasNoBotAgentsLabel, normalizeRepositoryTarget } from "../src/util";

describe("util helpers", () => {
  it("normalizes repository from webhook payload", () => {
    expect(
      normalizeRepositoryTarget({ repository: { full_name: "Acme/Widgets" } })
    ).toEqual({ owner: "acme", repo: "widgets" });

    expect(
      normalizeRepositoryTarget({ repository: { owner: { login: "Acme" }, name: "Widgets" } })
    ).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("detects opt-out labels", () => {
    expect(hasNoBotAgentsLabel({ repository: { topics: ["ci", "no-bot-agents"] } })).toBe(true);
    expect(hasNoBotAgentsLabel({ repository: { labels: [{ name: "no-bot-agents" }] } })).toBe(true);
    expect(hasNoBotAgentsLabel({ repository: { topics: ["ci"] } })).toBe(false);
  });
});
