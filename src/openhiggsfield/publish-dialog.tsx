"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { clearPublishKey, getPublishProfiles, getPublishStatus, publishRun, savePublishKey } from "@/publish/actions";
import { platformsFor } from "@/publish/upload-post";
import type { PublishPlatformResult, PublishProfile, PublishStatus } from "@/publish/upload-post";

import type { RunRecord } from "./history";
import { CheckIcon, CloseIcon, OpenOutIcon, WarningIcon } from "./icons";

const STATUS_POLL_MS = 4000;
/* Same deadline the studio gives a generation: past it the post is still
   tracked in Upload-Post, the dialog just stops asking. */
const STATUS_DEADLINE_MS = 10 * 60 * 1000;

const PLATFORM_NAMES: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X",
  threads: "Threads",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
  telegram: "Telegram",
  discord: "Discord",
  google_business: "Google Business",
  mastodon: "Mastodon",
};

const NOTES: Record<PublishPlatformResult["state"], string> = {
  pending: "Publishing…",
  done: "Published",
  failed: "Failed",
  skipped: "Skipped",
};

const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

type Phase =
  | { at: "loading" }
  | { at: "key" }
  | { at: "compose"; profiles: PublishProfile[] }
  | { at: "tracking"; requestId: string; status: PublishStatus | null; stale: boolean };

export function PublishDialog({ item, onClose }: { item: RunRecord; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [profile, setProfile] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [caption, setCaption] = useState(item.prompt);

  const kind = item.kind === "video" ? "video" : "image";
  const url = item.urls[0];

  useEffect(() => {
    ref.current?.showModal();
    panelRef.current?.focus();
    void getPublishProfiles().then(
      (result) => {
        if (result.ok && result.value) return openCompose(result.value);
        if (!result.ok) setError(result.error);
        setPhase({ at: "key" });
      },
      (caught) => {
        setError(messageOf(caught));
        setPhase({ at: "key" });
      },
    );
    // Loaded once per open; the dialog remounts for every run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCompose(profiles: PublishProfile[]) {
    const first = profiles.find((candidate) => usable(candidate).length > 0) ?? profiles[0];
    setProfile(first?.username ?? "");
    setPicked(first ? usable(first).map((account) => account.platform) : []);
    setPhase({ at: "compose", profiles });
  }

  /* Accounts on this profile that can take this run right now: a supported
     destination for its kind, with a token that has not lapsed. */
  function usable(candidate: PublishProfile) {
    const allowed = platformsFor(kind);
    return candidate.accounts.filter((account) => allowed.includes(account.platform) && !account.reauth);
  }

  const requestId = phase.at === "tracking" ? phase.requestId : null;
  useEffect(() => {
    if (!requestId) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let live = true;
    const poll = async () => {
      try {
        const result = await getPublishStatus(requestId);
        if (!live) return;
        if (!result.ok) throw new Error(result.error);
        const status = result.value;
        setPhase({ at: "tracking", requestId, status, stale: false });
        if (status.finished) return;
      } catch {
        if (!live) return;
        setPhase((current) => (current.at === "tracking" ? { ...current, stale: true } : current));
      }
      if (Date.now() - started < STATUS_DEADLINE_MS) timer = setTimeout(() => void poll(), STATUS_POLL_MS);
    };
    timer = setTimeout(() => void poll(), STATUS_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [requestId]);

  async function onSaveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await savePublishKey({ apiKey });
      if (!result.ok) throw new Error(result.error);
      openCompose(result.value);
      setApiKey("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onForgetKey() {
    setBusy(true);
    setError(null);
    try {
      await clearPublishKey();
      setPhase({ at: "key" });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onPublish(event: FormEvent) {
    event.preventDefault();
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      const result = await publishRun({ kind, url, profile, platforms: picked, caption });
      if (!result.ok) throw new Error(result.error);
      setPhase({ at: "tracking", requestId: result.value, status: null, stale: false });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const current = phase.at === "compose" ? phase.profiles.find((candidate) => candidate.username === profile) : undefined;
  const accounts = current ? usable(current) : [];

  return (
    <dialog
      ref={ref}
      aria-labelledby="ohf-publish-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      /* Nested inside the viewer, whose arrow keys step between runs; typing
         a caption must not walk the gallery underneath. */
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => event.stopPropagation()}
    >
      <div ref={panelRef} tabIndex={-1} className="ohf-dialog-panel ohf-keys-panel ohf-publish-panel">
        <div className="ohf-keys-head">
          <div>
            <div id="ohf-publish-title" className="ohf-keys-title">
              Publish to social
            </div>
            <p className="ohf-keys-copy">
              {phase.at === "key"
                ? "Post this run to TikTok, Instagram, YouTube and more through Upload-Post. Paste an Upload-Post API key; it stays in an httpOnly cookie."
                : "Sent through Upload-Post, which fetches the file straight from the CDN."}
            </p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        {phase.at === "loading" && (
          <div className="ohf-publish-loading">
            <span className="ohf-spinner" aria-hidden />
          </div>
        )}

        {phase.at === "key" && (
          <form className="ohf-keys-form" onSubmit={(event) => void onSaveKey(event)}>
            <label className="ohf-field">
              <div className="ohf-field-label">Upload-Post API key</div>
              <input
                className="ohf-input ohf-input--mono"
                name="upload_post_key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <p className="ohf-keys-copy">
              Create one in{" "}
              <a href="https://app.upload-post.com/api-keys" target="_blank" rel="noreferrer">
                app.upload-post.com/api-keys
              </a>
              , then connect your accounts under{" "}
              <a href="https://app.upload-post.com/manage-users" target="_blank" rel="noreferrer">
                Manage Users
              </a>
              .
            </p>
            {error && <Alert text={error} />}
            <div className="ohf-keys-actions">
              <button type="submit" className="ohf-keys-save" disabled={busy || !apiKey.trim()}>
                {busy ? "Checking…" : "Save key"}
              </button>
            </div>
          </form>
        )}

        {phase.at === "compose" && (
          <form className="ohf-keys-form" onSubmit={(event) => void onPublish(event)}>
            {phase.profiles.length > 1 && (
              <label className="ohf-field">
                <div className="ohf-field-label">Profile</div>
                <select
                  className="ohf-input"
                  value={profile}
                  onChange={(event) => {
                    const next = phase.profiles.find((candidate) => candidate.username === event.target.value);
                    setProfile(event.target.value);
                    setPicked(next ? usable(next).map((account) => account.platform) : []);
                  }}
                >
                  {phase.profiles.map((candidate) => (
                    <option key={candidate.username} value={candidate.username}>
                      {candidate.username}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="ohf-field">
              <div className="ohf-field-label">Destinations</div>
              {accounts.length > 0 ? (
                <div className="ohf-publish-targets">
                  {accounts.map((account) => {
                    const on = picked.includes(account.platform);
                    return (
                      <button
                        key={account.platform}
                        type="button"
                        className="ohf-publish-target"
                        aria-pressed={on}
                        data-on={on || undefined}
                        title={account.label}
                        onClick={() =>
                          setPicked((list) =>
                            on ? list.filter((platform) => platform !== account.platform) : [...list, account.platform],
                          )
                        }
                      >
                        {on && <CheckIcon size={11} />}
                        {platformName(account.platform)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="ohf-keys-copy">
                  No account on this profile can take {kind === "video" ? "a video" : "an image"} yet.{" "}
                  <a href="https://app.upload-post.com/manage-users" target="_blank" rel="noreferrer">
                    Connect one in Upload-Post
                  </a>
                  .
                </p>
              )}
            </div>

            <label className="ohf-field">
              <div className="ohf-field-label">Caption</div>
              <textarea
                className="ohf-input ohf-publish-caption"
                rows={4}
                maxLength={2200}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
              />
            </label>

            {error && <Alert text={error} />}

            <div className="ohf-keys-actions">
              <button type="button" className="ohf-btn-quiet" disabled={busy} onClick={() => void onForgetKey()}>
                Change key
              </button>
              <button
                type="submit"
                className="ohf-keys-save"
                disabled={busy || !url || picked.length === 0 || !profile}
              >
                {busy ? "Sending…" : `Publish to ${picked.length || ""} ${picked.length === 1 ? "platform" : "platforms"}`}
              </button>
            </div>
          </form>
        )}

        {phase.at === "tracking" && (
          <div className="ohf-keys-form">
            <ul className="ohf-publish-results">
              {rowsOf(phase.status, picked).map(
                (result) => (
                  <li key={result.platform} className="ohf-publish-result" data-state={result.state}>
                    <span className="ohf-publish-result-mark" aria-hidden>
                      {result.state === "pending" ? (
                        <span className="ohf-spinner" />
                      ) : result.state === "done" ? (
                        <CheckIcon size={12} />
                      ) : (
                        <WarningIcon size={12} />
                      )}
                    </span>
                    <span className="ohf-publish-result-name">{platformName(result.platform)}</span>
                    {result.postUrl ? (
                      <a className="ohf-publish-result-link" href={result.postUrl} target="_blank" rel="noreferrer">
                        View post <OpenOutIcon size={11} />
                      </a>
                    ) : result.error ? (
                      <span className="ohf-publish-result-error">{result.error}</span>
                    ) : (
                      <span className="ohf-publish-result-note">
                        {NOTES[result.state]}
                      </span>
                    )}
                  </li>
                ),
              )}
            </ul>
            {phase.stale && <p className="ohf-keys-copy">Could not reach Upload-Post; retrying.</p>}
            <p className="ohf-keys-copy">
              Closing this does not stop the post. Track it in{" "}
              <a href="https://app.upload-post.com/upload-history" target="_blank" rel="noreferrer">
                your Upload-Post history
              </a>
              .
            </p>
            <div className="ohf-keys-actions">
              <button type="button" className="ohf-keys-save" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

/* Until Upload-Post records its first result, every destination asked for is
   shown as on its way, so the list does not start empty. */
function rowsOf(status: PublishStatus | null, picked: string[]): PublishPlatformResult[] {
  if (status?.results.length) return status.results;
  return picked.map((platform) => ({ platform, state: status?.finished ? "failed" : "pending" }));
}

function Alert({ text }: { text: string }) {
  return (
    <div className="ohf-alert" role="alert">
      <span className="ohf-alert-text">{text}</span>
    </div>
  );
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Something went wrong";
}
