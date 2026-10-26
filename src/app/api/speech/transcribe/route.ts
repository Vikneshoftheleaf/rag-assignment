import { NextResponse } from "next/server";
import { transcribeWithFallback } from "@/lib/providers";
import { getRequestUser } from "@/lib/supabase-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const maxAudioBytes = 2 * 1024 * 1024;
const allowedAudioTypes = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
]);

export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Sign in to transcribe a recording." }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxAudioBytes + 64 * 1024) {
    return NextResponse.json({ error: "Recording is too large. Keep it under 2 MB and try again." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Upload a recording to transcribe." }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "The recording is empty. Try recording again." }, { status: 400 });
  }
  if (audio.size > maxAudioBytes) {
    return NextResponse.json({ error: "Recording is too large. Keep it under 2 MB and try again." }, { status: 413 });
  }
  const contentType = audio.type.split(";")[0].toLowerCase();
  if (!allowedAudioTypes.has(contentType)) {
    return NextResponse.json({ error: "This audio format is not supported by the transcription service." }, { status: 415 });
  }

  try {
    const result = await transcribeWithFallback(new Uint8Array(await audio.arrayBuffer()));
    return NextResponse.json({ transcript: result.text, provider: result.provider });
  } catch (error) {
    console.error("Speech transcription failed", error);
    return NextResponse.json(
      { error: "Could not transcribe this recording. Please try again or type your question." },
      { status: 503 },
    );
  }
}
