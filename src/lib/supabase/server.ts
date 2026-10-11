// Supabase client for Server Components, Server Actions and Route Handlers.
// Acts as the signed-in user (session from cookies), so Row Level Security
// applies. Uses only the publishable key; the secret key never reaches the app.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
          } catch {
            // Called from a Server Component, which can't set cookies; the
            // session refresh is handled by the auth middleware (Phase 2 auth).
          }
        },
      },
    },
  );
}
