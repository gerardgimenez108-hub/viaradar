export const DEFAULT_ORIGINS = [
  "https://buscando-la-via-h.web.app",
  "https://buscando-la-via-h.firebaseapp.com",
  "https://viaradar.web.app",
  "https://viaradar.firebaseapp.com",
  "https://viaradar.vercel.app",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export function configuredOrigins(value?: string): Set<string> {
  return new Set(
    (value || DEFAULT_ORIGINS.join(","))
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}
