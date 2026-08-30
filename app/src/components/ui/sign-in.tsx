import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// --- HELPER COMPONENTS (ICONS) ---

const GoogleIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 48 48">
        <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s12-5.373 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-2.641-.21-5.236-.611-7.743z" />
        <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
        <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
        <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C42.022 35.026 44 30.038 44 24c0-2.641-.21-5.236-.611-7.743z" />
    </svg>
);


// --- TYPE DEFINITIONS ---

interface SignInPageProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  heroImageSrc?: string;
  onSignIn?: (event: React.FormEvent<HTMLFormElement>) => void;
  onGoogleSignIn?: () => void;
  onResetPassword?: () => void;
  onCreateAccount?: () => void;

  /* ---- additions for the Kinvox integration. All optional: leave them off and
     the component behaves exactly as it shipped. ----------------------------- */

  /** Replaces the built-in email/password form (and the Google button, the
   *  divider and the create-account footer) with arbitrary content, keeping the
   *  split layout, the hero and the entrance animations. `/signup` uses this to
   *  drop the five-step OTP machine into the same shell. */
  children?: React.ReactNode;
  /** Server-side failure, announced to screen readers. */
  error?: React.ReactNode;
  /** Request in flight — disables submit and swaps its label. */
  busy?: boolean;
  submitLabel?: string;
  busyLabel?: string;
  /** The first field is an email upstream; Kinvox accepts a phone there too. */
  identifierName?: string;
  identifierType?: React.HTMLInputTypeAttribute;
  identifierLabel?: string;
  identifierPlaceholder?: string;
  showGoogle?: boolean;
  showResetPassword?: boolean;
  createAccountPrompt?: React.ReactNode;
  createAccountLabel?: React.ReactNode;
}

// --- SUB-COMPONENTS ---

/* Was a frosted-glass wrapper with a violet focus ring — a second accent, and a
   material that appears nowhere else in this product. It now matches the `Field`
   primitive in ui/index.tsx: paper ground, hairline border, accent on focus. */
const FieldWrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-line-strong bg-paper transition-colors focus-within:border-accent">
    {children}
  </div>
);

// --- MAIN COMPONENT ---

export const SignInPage: React.FC<SignInPageProps> = ({
  title = <span className="font-light text-foreground tracking-tighter">Welcome</span>,
  description = "Access your account and continue your journey with us",
  heroImageSrc,
  onSignIn,
  onGoogleSignIn,
  onResetPassword,
  onCreateAccount,
  children,
  error,
  busy = false,
  submitLabel = 'Sign In',
  busyLabel = 'Signing in…',
  identifierName = 'email',
  identifierType = 'email',
  identifierLabel = 'Email Address',
  identifierPlaceholder = 'Enter your email address',
  showGoogle = true,
  showResetPassword = true,
  createAccountPrompt = 'New to our platform?',
  createAccountLabel = 'Create Account',
}) => {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="h-[100dvh] flex flex-col md:flex-row font-geist w-[100dvw]">
      {/* Left column: sign-in form */}
      {/* `m-auto` on the child rather than `items-center` on the section: a centred
          flex item whose content is taller than the scroll box gets its top edge
          clipped and unreachable. `/signup` puts five step cards in here. */}
      <section className="flex-1 flex flex-col overflow-y-auto p-8">
        <div className="m-auto w-full max-w-md py-4">
          <div className="flex flex-col gap-6">
            <h1 className="animate-element animate-delay-100 text-4xl md:text-5xl font-semibold leading-tight">{title}</h1>
            <p className="animate-element animate-delay-200 text-muted-foreground">{description}</p>

            {children ?? (
              <>
            <form className="space-y-5" onSubmit={onSignIn}>
              <div className="animate-element animate-delay-300">
                <label className="text-sm font-medium text-muted-foreground">{identifierLabel}</label>
                <FieldWrapper>
                  <input name={identifierName} type={identifierType} autoComplete="username" placeholder={identifierPlaceholder} className="w-full bg-transparent text-sm p-4 rounded-lg focus:outline-none" />
                </FieldWrapper>
              </div>

              <div className="animate-element animate-delay-400">
                <label className="text-sm font-medium text-muted-foreground">Password</label>
                <FieldWrapper>
                  <div className="relative">
                    <input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" className="w-full bg-transparent text-sm p-4 pr-12 rounded-lg focus:outline-none" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-3 flex items-center">
                      {showPassword ? <EyeOff className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors" /> : <Eye className="w-5 h-5 text-muted-foreground hover:text-foreground transition-colors" />}
                    </button>
                  </div>
                </FieldWrapper>
              </div>

              <div className="animate-element animate-delay-500 flex items-center justify-between text-sm">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" name="rememberMe" className="custom-checkbox" />
                  <span className="text-foreground/90">Keep me signed in</span>
                </label>
                {showResetPassword && (
                  <a href="#" onClick={(e) => { e.preventDefault(); onResetPassword?.(); }} className="text-accent hover:underline transition-colors">Reset password</a>
                )}
              </div>

              {error && (
                <p role="alert" aria-live="polite" className="animate-element text-sm font-semibold text-destructive">
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy} className="animate-element animate-delay-600 w-full rounded-lg bg-primary py-4 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
                {busy ? busyLabel : submitLabel}
              </button>
            </form>

            {showGoogle && (
              <>
                <div className="animate-element animate-delay-700 relative flex items-center justify-center">
                  <span className="w-full border-t border-border"></span>
                  <span className="px-4 text-sm text-muted-foreground bg-background absolute">Or continue with</span>
                </div>

                <button onClick={onGoogleSignIn} className="animate-element animate-delay-800 w-full flex items-center justify-center gap-3 border border-line-strong rounded-lg py-4 hover:bg-secondary transition-colors">
                    <GoogleIcon />
                    Continue with Google
                </button>
              </>
            )}

            {onCreateAccount && (
              <p className="animate-element animate-delay-900 text-center text-sm text-muted-foreground">
                {createAccountPrompt} <a href="#" onClick={(e) => { e.preventDefault(); onCreateAccount(); }} className="text-accent hover:underline transition-colors">{createAccountLabel}</a>
              </p>
            )}
              </>
            )}
          </div>
        </div>
      </section>

      {/* Right column: hero image + testimonials */}
      {heroImageSrc && (
        <section className="hidden md:block flex-1 relative p-4">
          <div className="animate-slide-right animate-delay-300 absolute inset-4 rounded-xl bg-cover bg-center" style={{ backgroundImage: `url(${heroImageSrc})` }}></div>
        </section>
      )}
    </div>
  );
};
