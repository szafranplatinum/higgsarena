/* The Upload-Post key is a second credential next to the platform key, kept the
   same way: an httpOnly cookie the browser holds and only the server reads, so
   publishing never puts it in reach of page script. */
export const PUBLISH_KEY_COOKIE = "upload_post_key";

export const PUBLISH_KEY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export class MissingPublishKeyError extends Error {
  constructor() {
    super("Missing Upload-Post API key");
    this.name = "MissingPublishKeyError";
  }
}

export function parsePublishKeyInput(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Enter an Upload-Post API key");
  }
  const apiKey = (data as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Enter an Upload-Post API key");
  /* Keys are copied out of a dashboard, often with the scheme still attached. */
  return apiKey.trim().replace(/^apikey\s+/i, "");
}
