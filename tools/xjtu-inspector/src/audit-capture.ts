import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: tsx src/audit-capture.ts <jsonl-path>");

interface CapturedEvent {
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  kind: "request" | "response";
  method: string;
  resourceType: string;
  status?: number;
  timestamp: string;
  url: string;
}

interface EndpointAudit {
  bodyPaths: Set<string>;
  count: number;
  endpoint: string;
  methods: Set<string>;
  queryKeys: Set<string>;
  resourceTypes: Set<string>;
  statuses: Set<number>;
}

const allowedHosts = new Set(["class.xjtu.edu.cn", "class-rms.xjtu.edu.cn", "review-class.xjtu.edu.cn"]);
const endpoints = new Map<string, EndpointAudit>();
const videoFacts: unknown[] = [];
const mediaFacts: unknown[] = [];
const listFacts: unknown[] = [];
const requestFacts: unknown[] = [];
const semesterFacts: unknown[] = [];
const paginationFacts: unknown[] = [];
const activityFacts: unknown[] = [];
const playerFacts: unknown[] = [];
const input = createInterface({
  input: createReadStream(inputPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

for await (const line of input) {
  const event = JSON.parse(line) as CapturedEvent;
  const url = new URL(event.url);
  if (!allowedHosts.has(url.hostname)) continue;
  const endpoint = `${url.origin}${url.pathname}`;
  const audit = endpoints.get(endpoint) ?? {
    endpoint,
    count: 0,
    methods: new Set<string>(),
    queryKeys: new Set<string>(),
    resourceTypes: new Set<string>(),
    statuses: new Set<number>(),
    bodyPaths: new Set<string>(),
  };
  audit.count += 1;
  audit.methods.add(event.method);
  if (event.status !== undefined) audit.statuses.add(event.status);
  audit.resourceTypes.add(event.resourceType);
  [...url.searchParams.keys()].forEach((key) => audit.queryKeys.add(key));
  if (event.kind === "response" && event.body !== undefined) collectPaths(event.body, "", audit.bodyPaths, 0);
  endpoints.set(endpoint, audit);

  if (event.kind === "request") {
    collectRequestFacts(endpoint, event, requestFacts);
  }
  if (event.kind === "response") {
    collectWhitelistedFacts(
      endpoint,
      event,
      videoFacts,
      mediaFacts,
      listFacts,
      semesterFacts,
      paginationFacts,
      activityFacts,
      playerFacts,
    );
  }
}

console.log(
  JSON.stringify(
    {
      endpoints: [...endpoints.values()]
        .filter((item) => /\/api\/|\.mp4$|\.m3u8$|\.mpd$/i.test(item.endpoint))
        .map((item) => ({
          endpoint: item.endpoint,
          count: item.count,
          methods: [...item.methods].sort(),
          queryKeys: [...item.queryKeys].sort(),
          resourceTypes: [...item.resourceTypes].sort(),
          statuses: [...item.statuses].sort((left, right) => left - right),
          bodyPaths: [...item.bodyPaths].sort(),
        }))
        .sort((left, right) => left.endpoint.localeCompare(right.endpoint)),
      listFacts,
      requestFacts,
      semesterFacts,
      paginationFacts,
      activityFacts,
      playerFacts,
      videoFacts,
      mediaFacts,
    },
    null,
    2,
  ),
);

function collectPaths(value: unknown, path: string, output: Set<string>, depth: number): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    output.add(`${path}[]`);
    if (value[0] !== undefined) collectPaths(value[0], `${path}[]`, output, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    if (path) output.add(path);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    output.add(childPath);
    collectPaths(child, childPath, output, depth + 1);
  }
}

function collectWhitelistedFacts(
  endpoint: string,
  event: CapturedEvent,
  videos: unknown[],
  media: unknown[],
  lists: unknown[],
  semesters: unknown[],
  pagination: unknown[],
  activitiesOutput: unknown[],
  players: unknown[],
): void {
  const body = asRecord(event.body);
  const data = asRecord(body?.data);

  if (/lesson-activities\/captures\//.test(endpoint)) {
    const candidates = [data?.lesson_videos, data?.videos].filter(Array.isArray).flat() as unknown[];
    videos.push({
      endpoint,
      aggregateVideoSize: numberOrUndefined(data?.video_size),
      status: stringEnum(data?.status),
      videos: candidates.map((candidate) => {
        const video = asRecord(candidate);
        return {
          id: numberOrUndefined(video?.id),
          label: stringEnum(video?.label),
          playType: stringEnum(video?.play_type),
          size: numberOrUndefined(video?.size),
          mute: booleanOrUndefined(video?.mute),
          isBestAudio: booleanOrUndefined(video?.is_best_audio),
          downloadPath: urlPath(video?.download_url),
          downloadQueryKeys: urlQueryKeys(video?.download_url),
          playPath: urlPath(video?.play_url),
          playQueryKeys: urlQueryKeys(video?.play_url),
        };
      }),
    });
  }

  if (/\.(?:mp4|m3u8|mpd)$/i.test(endpoint)) {
    media.push({
      endpoint,
      status: event.status,
      contentType: event.headers?.["content-type"],
      acceptRanges: event.headers?.["accept-ranges"],
      contentLength: event.headers?.["content-length"],
      contentRangePresent: Boolean(event.headers?.["content-range"]),
    });
  }

  for (const key of ["semesters", "courses", "classrooms", "activities", "live_records", "lessons"]) {
    const array = body?.[key] ?? data?.[key];
    if (Array.isArray(array)) {
      lists.push({
        endpoint,
        key,
        count: array.length,
        itemKeys: Object.keys(asRecord(array[0]) ?? {}).sort(),
      });
    }
  }

  if (/\/api\/my-semesters$/.test(endpoint) && Array.isArray(body?.semesters)) {
    semesters.push(
      ...body.semesters.map((item) => {
        const semester = asRecord(item);
        return {
          id: numberOrUndefined(semester?.id),
          academicYearId: numberOrUndefined(semester?.academic_year_id),
          isActive: booleanOrUndefined(semester?.is_active),
          sort: numberOrUndefined(semester?.sort),
          name: plainLabel(semester?.name),
          realName: plainLabel(semester?.real_name),
        };
      }),
    );
  }

  if (/\/api\/my-courses$/.test(endpoint)) {
    pagination.push({
      page: numberOrUndefined(body?.page),
      pageSize: numberOrUndefined(body?.page_size),
      pages: numberOrUndefined(body?.pages),
      start: numberOrUndefined(body?.start),
      end: numberOrUndefined(body?.end),
      total: numberOrUndefined(body?.total),
      returnedCourses: Array.isArray(body?.courses) ? body.courses.length : undefined,
    });
  }

  if (/\/api\/courses\/\d+\/activities$/.test(endpoint) && Array.isArray(body?.activities)) {
    const typeCounts = new Map<string, number>();
    const replayCandidates: unknown[] = [];
    for (const item of body.activities) {
      const activity = asRecord(item);
      const dataRecord = asRecord(activity?.data);
      const type = plainLabel(activity?.type) ?? "<unknown>";
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      const lessonResourceId = numberOrUndefined(dataRecord?.lesson_resource_id);
      if (lessonResourceId !== undefined) {
        replayCandidates.push({
          id: numberOrUndefined(activity?.id),
          type,
          startTime: plainLabel(activity?.start_time),
          endTime: plainLabel(activity?.end_time),
          lessonResourceId,
          duration: numberOrUndefined(dataRecord?.duration),
          allowDownload: booleanOrUndefined(dataRecord?.allow_download),
          lessonStart: plainLabel(dataRecord?.lesson_start),
          lessonEnd: plainLabel(dataRecord?.lesson_end),
        });
      }
    }
    activitiesOutput.push({
      endpoint,
      total: body.activities.length,
      typeCounts: Object.fromEntries([...typeCounts.entries()].sort()),
      replayCandidateCount: replayCandidates.length,
      replayCandidates,
    });
  }

  if (/\/api\/activities\/\d+$/.test(endpoint)) {
    const dataRecord = asRecord(body?.data);
    const lessonResource = asRecord(body?.lesson_resource);
    const properties = asRecord(lessonResource?.properties);
    const suite = asRecord(body?.video_suite);
    players.push({
      endpoint,
      activity: {
        id: numberOrUndefined(body?.id),
        type: plainLabel(body?.type),
        startTime: plainLabel(body?.start_time),
        endTime: plainLabel(body?.end_time),
        duration: numberOrUndefined(dataRecord?.duration),
        allowDownload: booleanOrUndefined(dataRecord?.allow_download),
        lessonResourceId: numberOrUndefined(dataRecord?.lesson_resource_id),
      },
      resource: {
        id: numberOrUndefined(lessonResource?.id),
        mimeType: plainLabel(lessonResource?.mimetype),
        size: numberOrUndefined(lessonResource?.size),
        status: stringEnum(properties?.status),
        type: stringEnum(properties?.type),
        duration: numberOrUndefined(properties?.duration),
        startTime: plainLabel(properties?.start_time),
        endTime: plainLabel(properties?.end_time),
        hasReplayCode: typeof properties?.replay_code === "string" && properties.replay_code.length > 0,
      },
      suiteVideos: Array.isArray(suite?.videos)
        ? suite.videos.map((item) => {
            const video = asRecord(item);
            return {
              cameraType: stringEnum(video?.camera_type),
              label: stringEnum(video?.label),
              mute: booleanOrUndefined(video?.mute),
              filePath: urlPath(video?.file_url),
              fileQueryKeys: urlQueryKeys(video?.file_url),
            };
          })
        : [],
    });
  }

  if (/\/api\/lessons\/\d+\/player-url$/.test(endpoint)) {
    players.push({
      endpoint,
      playerUrlPath: urlPath(body?.url),
      playerUrlQueryKeys: urlQueryKeys(body?.url),
    });
  }
}

function collectRequestFacts(endpoint: string, event: CapturedEvent, facts: unknown[]): void {
  const isCoreRequest =
    /\/api\/(my-courses|my-semesters|my-academic-years)$/.test(endpoint) ||
    /\/api\/(?:courses\/\d+\/activities|activities\/\d+|lessons\/\d+\/player-url)$/.test(endpoint) ||
    /\/api\/(?:embed\/lesson|embed\/lesson-activities|base\/orgs\/.*\/preview)/.test(endpoint) ||
    /\.(?:mp4|m3u8|mpd)$/i.test(endpoint);
  if (!isCoreRequest) return;
  const body = asRecord(event.body);
  const conditions = asRecord(body?.conditions);
  facts.push({
    endpoint,
    contentType: event.contentType,
    bodyKeys: Object.keys(body ?? {}).sort(),
    safeBodyShape: body ? summarizeSafeQuery(body, []) : undefined,
    query: body
      ? {
          page: numberOrUndefined(body.page),
          pageSize: numberOrUndefined(body.page_size),
          semesterId: numberOrUndefined(body.semester_id) ?? numberOrUndefined(conditions?.semester_id),
          academicYearId:
            numberOrUndefined(body.academic_year_id) ?? numberOrUndefined(conditions?.academic_year_id),
          archived: booleanOrUndefined(body.archived) ?? booleanOrUndefined(conditions?.archived),
        }
      : undefined,
    headers: {
      hasCookie: Boolean(event.headers?.cookie),
      hasAuthorization: Boolean(event.headers?.authorization),
      hasXSessionId: Boolean(event.headers?.["x-session-id"]),
      hasReferer: Boolean(event.headers?.referer),
      hasOrigin: Boolean(event.headers?.origin),
      hasRange: Boolean(event.headers?.range),
      hasAcceptEncoding: Boolean(event.headers?.["accept-encoding"]),
    },
  });
}

function summarizeSafeQuery(value: unknown, path: string[]): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const key = path.at(-1) ?? "";
    if (key === "fields" || /^[A-Za-z0-9_.:/,+-]*$/.test(value)) return value;
    return `[REDACTED_TEXT length=${value.length}]`;
  }
  if (Array.isArray(value)) return value.map((item) => summarizeSafeQuery(item, path));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, summarizeSafeQuery(child, [...path, key])]),
    );
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Z0-9_./+-]+$/i.test(value) ? value : undefined;
}

function plainLabel(value: unknown): string | undefined {
  return typeof value === "string" && !value.includes("[REDACTED]") ? value : undefined;
}

function urlPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function urlQueryKeys(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    return [...new URL(value).searchParams.keys()].sort();
  } catch {
    return [];
  }
}
