import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/lib/supabase-auth";
import { getSupabase } from "@/lib/retrieval";

export const runtime = "nodejs";

const idSchema = z.string().uuid();
const createSchema = z.object({ title: z.string().trim().min(1).max(120) });
const updateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rename"),
    sessionId: idSchema,
    title: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("turn"),
    sessionId: idSchema,
    turn: z.object({
      id: idSchema,
      question: z.string().trim().min(1).max(2000),
      answer: z.string().max(20000),
      citations: z.array(z.unknown()),
      abstained: z.boolean(),
      documentId: idSchema.optional(),
    }),
  }),
]);

function unauthorized() {
  return NextResponse.json({ error: "Sign in to access your chat history." }, { status: 401 });
}

export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return unauthorized();

  const supabase = getSupabase();
  const sessionId = new URL(request.url).searchParams.get("id");
  if (sessionId) {
    if (!idSchema.safeParse(sessionId).success) {
      return NextResponse.json({ error: "Invalid chat session." }, { status: 400 });
    }
    const { data: session, error: sessionError } = await supabase
      .from("chat_sessions")
      .select("id, title, created_at, updated_at")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (sessionError) {
      console.error("Could not load chat session", sessionError);
      return NextResponse.json({ error: "Could not load this chat session." }, { status: 500 });
    }
    if (!session) return NextResponse.json({ error: "Chat session not found." }, { status: 404 });

    const { data: turns, error: turnsError } = await supabase
      .from("chat_turns")
      .select("id, question, answer, citations, abstained, document_id, created_at")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (turnsError) {
      console.error("Could not load chat turns", turnsError);
      return NextResponse.json({ error: "Could not load messages for this chat." }, { status: 500 });
    }
    return NextResponse.json({ session, turns });
  }

  const { data, error } = await supabase
    .from("chat_sessions")
    .select("id, title, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("Could not load chat history", error);
    return NextResponse.json({ error: "Could not load chat history." }, { status: 500 });
  }
  return NextResponse.json({ sessions: data });
}

export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return unauthorized();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid chat title." }, { status: 400 });

  const { data, error } = await getSupabase()
    .from("chat_sessions")
    .insert({ user_id: user.id, title: parsed.data.title })
    .select("id, title, created_at, updated_at")
    .single();
  if (error) {
    console.error("Could not create chat session", error);
    return NextResponse.json({ error: "Could not create a new chat." }, { status: 500 });
  }
  return NextResponse.json({ session: data }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return unauthorized();
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid chat update." }, { status: 400 });

  const supabase = getSupabase();
  const { data: ownedSession, error: ownershipError } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("id", parsed.data.sessionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownershipError) {
    console.error("Could not verify chat session ownership", ownershipError);
    return NextResponse.json({ error: "Could not update this chat." }, { status: 500 });
  }
  if (!ownedSession) return NextResponse.json({ error: "Chat session not found." }, { status: 404 });

  if (parsed.data.type === "rename") {
    const { error } = await supabase.from("chat_sessions")
      .update({ title: parsed.data.title })
      .eq("id", parsed.data.sessionId)
      .eq("user_id", user.id);
    if (error) {
      console.error("Could not rename chat session", error);
      return NextResponse.json({ error: "Could not rename this chat." }, { status: 500 });
    }
  } else {
    const { turn } = parsed.data;
    const { data: existingTurn, error: turnLookupError } = await supabase
      .from("chat_turns")
      .select("session_id, user_id")
      .eq("id", turn.id)
      .maybeSingle();
    if (turnLookupError) {
      console.error("Could not verify chat turn ownership", turnLookupError);
      return NextResponse.json({ error: "Could not update this response." }, { status: 500 });
    }
    if (existingTurn && (existingTurn.session_id !== parsed.data.sessionId || existingTurn.user_id !== user.id)) {
      return NextResponse.json({ error: "Chat response not found." }, { status: 404 });
    }

    const { error } = await supabase.from("chat_turns").upsert({
      id: turn.id,
      session_id: parsed.data.sessionId,
      user_id: user.id,
      question: turn.question,
      answer: turn.answer,
      citations: turn.citations,
      abstained: turn.abstained,
      document_id: turn.documentId || null,
    }, { onConflict: "id" });
    if (error) {
      console.error("Could not save chat turn", error);
      return NextResponse.json({ error: "Could not save this response to chat history." }, { status: 500 });
    }
    const { error: sessionUpdateError } = await supabase.from("chat_sessions").update({ updated_at: new Date().toISOString() })
      .eq("id", parsed.data.sessionId)
      .eq("user_id", user.id);
    if (sessionUpdateError) {
      console.error("Could not update chat session timestamp", sessionUpdateError);
      return NextResponse.json({ error: "Response saved, but chat history could not be refreshed." }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return unauthorized();
  const sessionId = new URL(request.url).searchParams.get("id");
  if (!sessionId || !idSchema.safeParse(sessionId).success) {
    return NextResponse.json({ error: "Invalid chat session." }, { status: 400 });
  }
  const { data, error } = await getSupabase().from("chat_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Could not delete chat session", error);
    return NextResponse.json({ error: "Could not delete this chat." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Chat session not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
