import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/retrieval";
import { getRequestUser } from "@/lib/supabase-auth";
import { getFeedbackStats, updateTurnFeedback } from "@/lib/turn-feedback";

export const runtime = "nodejs";

const requestSchema = z.object({
  turnId: z.string().uuid(),
  vote: z.union([z.literal(-1), z.literal(1)]),
});

export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Sign in to rate this answer." }, { status: 401 });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a thumbs-up or thumbs-down rating." }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    await updateTurnFeedback(supabase, user.id, parsed.data.turnId, parsed.data.vote);
    const stats = await getFeedbackStats(supabase, user.id);
    return NextResponse.json({
      vote: parsed.data.vote,
      approvalPercent: stats.approvalPercent,
      ratingsCount: stats.positiveCount + stats.negativeCount,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Feedback record not found.") {
      return NextResponse.json({ error: "This answer is not available for feedback." }, { status: 404 });
    }
    console.error("Could not save answer feedback", error);
    return NextResponse.json({ error: "Could not save feedback. Please try again." }, { status: 500 });
  }
}