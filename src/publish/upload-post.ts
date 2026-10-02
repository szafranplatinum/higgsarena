const UPLOAD_POST_API = "https://api.upload-post.com/api";

/* What each destination will take from a finished run. Reddit is left out
   while its posting is paused upstream; YouTube carries video only. */
const VIDEO_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "facebook",
  "x",
  "threads",
  "pinterest",
  "bluesky",
  "telegram",
  "discord",
  "google_business",
  "mastodon",
] as const;
const IMAGE_PLATFORMS = VIDEO_PLATFORMS.filter((platform) => platform !== "youtube");

export type PublishKind = "image" | "video";

export interface PublishAccount {
  platform: string;
  /* The public @name when the platform reports one, else its display name. */
  label: string;
  reauth: boolean;
}

export interface PublishProfile {
  username: string;
  accounts: PublishAccount[];
}

export interface PublishRequest {
  kind: PublishKind;
  url: string;
  profile: string;
  platforms: string[];
  caption: string;
}

export interface PublishPlatformResult {
  platform: string;
  state: "pending" | "done" | "failed" | "skipped";
  postUrl?: string;
  error?: string;
}

export interface PublishStatus {
  status: string;
  finished: boolean;
  results: PublishPlatformResult[];
}

export function platformsFor(kind: PublishKind): readonly string[] {
  return kind === "video" ? VIDEO_PLATFORMS : IMAGE_PLATFORMS;
}

export function createUploadPostClient(apiKey: string) {
  async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(`${UPLOAD_POST_API}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Apikey ${apiKey}` },
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) throw new Error("Upload-Post rejected the API key");
    if (!response.ok && response.status !== 404) {
      throw new Error(messageOf(body) ?? `Upload-Post answered ${response.status}`);
    }
    return body;
  }

  return {
    async profiles(): Promise<PublishProfile[]> {
      const body = await call("/uploadposts/users");
      const profiles = Array.isArray(body.profiles) ? body.profiles : [];
      return profiles.flatMap((raw): PublishProfile[] => {
        const profile = raw as { username?: unknown; social_accounts?: unknown };
        if (typeof profile.username !== "string") return [];
        return [{ username: profile.username, accounts: accountsOf(profile.social_accounts) }];
      });
    },

    /* Async so the response is back in seconds whatever the file weighs:
       Upload-Post fetches the result from the CDN itself, nothing passes
       through this server. */
    async publish(request: PublishRequest): Promise<string> {
      const allowed = platformsFor(request.kind);
      const platforms = request.platforms.filter((platform) => allowed.includes(platform));
      if (platforms.length === 0) throw new Error("Pick at least one destination");

      const form = new FormData();
      form.append("user", request.profile);
      for (const platform of platforms) form.append("platform[]", platform);
      form.append(request.kind === "video" ? "video" : "photos[]", request.url);
      form.append("title", request.caption);
      /* YouTube needs a title and caps it at 100 characters. */
      if (platforms.includes("youtube")) form.append("youtube_title", request.caption.slice(0, 100));
      /* Every run here is generated, and the platforms that carry an AI
         label should show it. */
      form.append("is_ai_generated", "true");
      form.append("async_upload", "true");

      const body = await call(request.kind === "video" ? "/upload" : "/upload_photos", {
        method: "POST",
        body: form,
      });
      const requestId = body.request_id;
      if (typeof requestId !== "string" || !requestId) {
        throw new Error(messageOf(body) ?? "Upload-Post did not return a request id");
      }
      return requestId;
    },

    async status(requestId: string): Promise<PublishStatus> {
      const body = await call(`/uploadposts/status?request_id=${encodeURIComponent(requestId)}`);
      const status = typeof body.status === "string" ? body.status : "pending";
      const results = (Array.isArray(body.results) ? body.results : []).flatMap(resultOf);
      return {
        status,
        finished: status === "completed" || status === "failed" || status === "not_found",
        results,
      };
    },
  };
}

function accountsOf(raw: unknown): PublishAccount[] {
  if (raw === null || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([platform, value]): PublishAccount[] => {
    /* An empty string or null is a platform added to the profile but never
       connected, so there is nothing to post through. */
    if (value === null || typeof value !== "object") return [];
    const account = value as Record<string, unknown>;
    /* Some platforms (LinkedIn, Facebook pages) report a name where the
       handle goes; only a real @name gets the prefix. */
    const raw = typeof account.handle === "string" ? account.handle.replace(/^@/, "") : "";
    const handle = raw ? (/\s/.test(raw) ? raw : `@${raw}`) : null;
    const name = typeof account.display_name === "string" ? account.display_name : null;
    return [{ platform, label: handle ?? name ?? platform, reauth: account.reauth_required === true }];
  });
}

function resultOf(raw: unknown): PublishPlatformResult[] {
  if (raw === null || typeof raw !== "object") return [];
  const entry = raw as Record<string, unknown>;
  if (typeof entry.platform !== "string") return [];
  const error =
    (typeof entry.error_message === "string" && entry.error_message) ||
    (typeof entry.error === "string" && entry.error) ||
    undefined;
  const postUrl =
    typeof entry.post_url === "string" && /^https?:\/\//.test(entry.post_url) ? entry.post_url : undefined;
  const state: PublishPlatformResult["state"] =
    entry.status === "skipped" || entry.skipped === true
      ? "skipped"
      : entry.status === "queued" || entry.status === "processing" || entry.status === "retryable"
        ? "pending"
        : entry.success === true
          ? "done"
          : entry.success === false
            ? "failed"
            : "pending";
  return [{ platform: entry.platform, state, postUrl, error: state === "done" ? undefined : error }];
}

function messageOf(body: Record<string, unknown>): string | null {
  for (const key of ["message", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}
