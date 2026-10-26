"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, BookOpenText, Check, FileText, LockKeyhole, Sparkles } from "lucide-react";
import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";

export function AuthScreen({ supabase }: { supabase: SupabaseClient }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setNotice("Your account was created. Check your email if verification is enabled for this Supabase project.");
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setError("");
    setBusy(true);
    try {
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (authError) throw authError;
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Google sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <header className="auth-topbar">
        <Link className="auth-brand" href="/" aria-label="Silverline home">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <span>Silverline</span>
        </Link>
        <button className="auth-top-link" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
          {mode === "signup" ? "Log in" : "Create account"}
        </button>
      </header>
      <section className="auth-layout">
        <div className="auth-pitch">
          <span className="auth-eyebrow"><Sparkles size={14} /> DOCUMENT INTELLIGENCE</span>
          <h1>Make your documents<br />easier to understand.</h1>
          <p>Ask questions, explore cited answers, and pick up every conversation where you left off.</p>
          <div className="auth-feature-list">
            <div><BookOpenText size={18} /><span><strong>Grounded answers</strong><small>Every response points back to its source.</small></span><Check size={15} /></div>
            <div><FileText size={18} /><span><strong>Your chats, saved</strong><small>Private conversation history across sessions.</small></span><Check size={15} /></div>
            <div><LockKeyhole size={18} /><span><strong>Personal workspace</strong><small>Your account keeps your sessions separate.</small></span><Check size={15} /></div>
          </div>
        </div>
        <div className="auth-card">
          <span className="auth-card-mark"><Sparkles size={19} /></span>
          <h2>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
          <p>{mode === "signup" ? "Start a private workspace for your document conversations." : "Sign in to continue your conversations."}</p>
          <button className="google-auth-button" type="button" disabled={busy} onClick={() => void signInWithGoogle()}>
            <GoogleGlyph /> Continue with Google
          </button>
          <div className="auth-divider"><span />or continue with email<span /></div>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
            {error && <div className="auth-error" role="alert">{error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"} {!busy && <ArrowRight size={16} />}
            </button>
          </form>
          <p className="auth-switch">
            {mode === "signup" ? "Already have an account?" : "New to Silverline?"}{" "}
            <button onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(""); setNotice(""); }}>
              {mode === "signup" ? "Log in" : "Create an account"}
            </button>
          </p>
          <small className="auth-terms">By continuing, you agree to use this assistant for the provided illustrative sample documents.</small>
        </div>
      </section>
      <footer className="auth-footer">Silverline AI · Source-grounded document assistant</footer>
    </main>
  );
}

function GoogleGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17">
    <path fill="#4285F4" d="M17.64 9.2c0-.63-.06-1.24-.16-1.82H9v3.44h4.84a4.14 4.14 0 0 1-1.8 2.72v2.24h2.91c1.7-1.56 2.69-3.86 2.69-6.58Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.95-2.22l-2.91-2.24c-.8.54-1.82.87-3.04.87-2.34 0-4.32-1.58-5.03-3.71H.96v2.31A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.7a5.4 5.4 0 0 1 0-3.4V4.99H.96a9 9 0 0 0 0 8.02l3.01-2.31Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.37l2.58-2.58A8.63 8.63 0 0 0 9 0 9 9 0 0 0 .96 4.99L3.97 7.3C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>;
}
