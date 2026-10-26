import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSupabase, getRequestUser, getFeedbackStats, updateTurnFeedback } = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  getRequestUser: vi.fn(),
  getFeedbackStats: vi.fn(),
  updateTurnFeedback: vi.fn(),
}));

vi.mock("@/lib/retrieval", () => ({ getSupabase }));
vi.mock("@/lib/supabase-auth", () => ({ getRequestUser }));
vi.mock("@/lib/turn-feedback", () => ({ getFeedbackStats, updateTurnFeedback }));

import { POST } from "./route";

describe("POST /api/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRequestUser.mockResolvedValue({ id: "user-id" });
    getSupabase.mockReturnValue({});
    updateTurnFeedback.mockResolvedValue(undefined);
    getFeedbackStats.mockResolvedValue({
      positiveCount: 3,
      negativeCount: 1,
      approvalPercent: 75,
    });
  });

  it("requires an authenticated user", async () => {
    getRequestUser.mockResolvedValue(null);
    const response = await POST(new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnId: "123e4567-e89b-42d3-a456-426614174000",
        vote: 1,
      }),
    }));

    expect(response.status).toBe(401);
    expect(updateTurnFeedback).not.toHaveBeenCalled();
  });

  it("saves the vote and returns the user's cumulative approval rate", async () => {
    const turnId = "123e4567-e89b-42d3-a456-426614174000";
    const response = await POST(new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnId, vote: -1 }),
    }));

    expect(response.status).toBe(200);
    expect(updateTurnFeedback).toHaveBeenCalledWith({}, "user-id", turnId, -1);
    expect(await response.json()).toEqual({
      vote: -1,
      approvalPercent: 75,
      ratingsCount: 4,
    });
  });

  it("rejects votes outside the thumbs-up/down values", async () => {
    const response = await POST(new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnId: "123e4567-e89b-42d3-a456-426614174000",
        vote: 0,
      }),
    }));

    expect(response.status).toBe(400);
    expect(updateTurnFeedback).not.toHaveBeenCalled();
  });
});