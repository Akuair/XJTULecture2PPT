# Authenticated video downloader

## Scope

`packages/downloader` is a transport-agnostic Node/Electron streaming downloader. It never receives account passwords, persists no signed URL, and writes response chunks directly to `<destination>.part`.

Supported behavior:

- MP4 streaming without buffering the full video in memory;
- `Content-Length` and `Content-Range` progress;
- cancellation and inactivity timeout;
- retry with a freshly resolved playback URL;
- HTTP Range resume;
- safe fallback to a full restart when a server ignores Range;
- atomic `.part` to final-path rename only after MP4 validation;
- explicit rejection of HLS and DASH during the MP4-only Phase 5 implementation.

HLS/DASH support will only be added if a real authorized XJTU response is observed. DRM-protected media is never bypassed.

## Electron integration

The Renderer sends only numeric course, activity, and video identifiers over the narrow preload bridge. Electron Main then:

1. resolves the selected view again through the confirmed XJTU activity-detail API;
2. requests the preview URL with the same persistent XJTU Electron Session;
3. follows the authorized redirect to the short-lived signed MP4;
4. streams into the app-private `temp/jobs/<job-id>/source.mp4.part` path;
5. renames to `source.mp4` after byte-count and MP4-header verification.

The main XJTU JSON APIs use `Session.fetch()`. Media uses Electron `net.request()` with the same Session because it supports explicit Range/referrer/origin headers and event-stream consumption across the observed preview redirect chain.

No Cookie, Authorization value, preview token, signed URL, or real user identity is written to metadata or logs.

## Real verification (2026-08-20)

An authorized dual-view lecture was tested through the desktop UI using one server-labelled view. Results:

- final job status: `downloaded`;
- bytes written: `1,000,882,855`;
- UI progress: `954.5 MiB / 954.5 MiB (100%)`;
- container signature: ISO Base Media (`ftyp isom`);
- Windows media parser: H.264/AVC video, audio stream present;
- resolution: `1920 × 1080`;
- parsed duration: approximately `3600` seconds.

The successful source video is intentionally retained for the Phase 6 local video-to-PPT conversion test. It must not be deleted until a non-empty PPTX has been written and verified.

## Automated verification

The downloader test suite covers:

- streaming progress;
- Range resume;
- servers that ignore Range;
- expired signed URL re-resolution;
- retryable 5xx responses;
- non-retryable 401;
- HLS rejection;
- cancellation;
- inactivity timeout;
- refusal to overwrite an existing final file.
