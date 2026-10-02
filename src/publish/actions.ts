"use server";

import { cookies } from "next/headers";

import {
  MissingPublishKeyError,
  PUBLISH_KEY_COOKIE,
  PUBLISH_KEY_COOKIE_OPTIONS,
  parsePublishKeyInput,
} from "./credentials";
import { createUploadPostClient } from "./upload-post";
import type { PublishKind, PublishProfile, PublishStatus } from "./upload-post";

/* Next replaces a thrown error's message with a digest in production builds,
   and the reason (a rejected key, a disconnected account, an exhausted plan)
   is the whole point of the answer. So failures come back as data. */
export type PublishResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(work: () => Promise<T>): Promise<PublishResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : "Something went wrong" };
  }
}

/* Saving checks the key against Upload-Post before it is stored, so a typo is
   named in the form rather than at the first publish. */
export async function savePublishKey(data: unknown): Promise<PublishResult<PublishProfile[]>> {
  return attempt(async () => {
    const apiKey = parsePublishKeyInput(data);
    const profiles = await createUploadPostClient(apiKey).profiles();
    const jar = await cookies();
    jar.set(PUBLISH_KEY_COOKIE, apiKey, PUBLISH_KEY_COOKIE_OPTIONS);
    return profiles;
  });
}

export async function clearPublishKey() {
  const jar = await cookies();
  jar.set(PUBLISH_KEY_COOKIE, "", { ...PUBLISH_KEY_COOKIE_OPTIONS, maxAge: 0 });
}

/** The profiles and connected accounts behind the saved key, or null when no
    key is saved yet; the dialog opens on the key form in that case. */
export async function getPublishProfiles(): Promise<PublishResult<PublishProfile[] | null>> {
  return attempt(async () => {
    const apiKey = await readPublishKey();
    if (!apiKey) return null;
    return createUploadPostClient(apiKey).profiles();
  });
}

export async function publishRun(data: unknown): Promise<PublishResult<string>> {
  return attempt(() => submit(data));
}

export async function getPublishStatus(requestId: unknown): Promise<PublishResult<PublishStatus>> {
  return attempt(async () => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return createUploadPostClient(await requirePublishKey()).status(requestId);
  });
}

async function submit(data: unknown): Promise<string> {
  const payload = asObject(data);
  const kind = payload.kind;
  if (kind !== "image" && kind !== "video") throw new Error("Only image and video runs can be published");
  const url = payload.url;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("This run has no public file");
  const profile = payload.profile;
  if (typeof profile !== "string" || !profile) throw new Error("Pick a profile");
  const platforms = payload.platforms;
  if (!Array.isArray(platforms) || !platforms.every((platform) => typeof platform === "string")) {
    throw new Error("Pick at least one destination");
  }
  const caption = typeof payload.caption === "string" ? payload.caption.trim() : "";

  return createUploadPostClient(await requirePublishKey()).publish({
    kind: kind as PublishKind,
    url,
    profile,
    platforms,
    caption,
  });
}

async function readPublishKey(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(PUBLISH_KEY_COOKIE)?.value || null;
}

async function requirePublishKey(): Promise<string> {
  const apiKey = await readPublishKey();
  if (!apiKey) throw new MissingPublishKeyError();
  return apiKey;
}

function asObject(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid publish payload");
  return data as Record<string, unknown>;
}
