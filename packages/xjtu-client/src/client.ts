import { XjtuApiError } from "./errors";
import type {
  AcademicYear,
  Course,
  CoursePage,
  CourseQuery,
  Lecture,
  LectureVideo,
  Semester,
  StreamType,
  XjtuTransport,
} from "./types";

const DEFAULT_BASE_URL = "https://class.xjtu.edu.cn";
const COURSE_PAGE_SIZE = 10;
const COURSE_FIELDS =
  "id,name,course_code,department(id,name),grade(id,name),klass(id,name),course_type,cover,small_cover,start_date,end_date,is_started,is_closed,academic_year_id,semester_id,credit,compulsory,second_name,display_name,created_user(id,name),org(is_enterprise_or_organization),org_id,public_scope,audit_status,audit_remark,can_withdraw_course,imported_from,allow_clone,is_instructor,is_team_teaching,is_default_course_cover,archived,instructors(id,name,email,avatar_small_url),course_attributes(teaching_class_name,is_during_publish_period,copy_status,tip,data,audience_type,graduate_method),user_stick_course_record(id)";

export class XjtuClient {
  private readonly baseUrl: string;
  private readonly transport: XjtuTransport;

  constructor(transport: XjtuTransport, options: { baseUrl?: string } = {}) {
    this.transport = transport;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async getAcademicYears(): Promise<AcademicYear[]> {
    const payload = asRecord(await this.requestJson("/api/my-academic-years?fields=id,name,sort,is_active"));
    return asArray(payload.academic_years, "academic_years").map((item) => {
      const year = asRecord(item);
      return {
        id: requiredId(year.id, "academic_year.id"),
        name: requiredString(year.name, "academic_year.name"),
        sort: requiredNumber(year.sort, "academic_year.sort"),
        isActive: requiredBoolean(year.is_active, "academic_year.is_active"),
      };
    });
  }

  async getSemesters(): Promise<Semester[]> {
    const payload = asRecord(await this.requestJson("/api/my-semesters"));
    return asArray(payload.semesters, "semesters").map((item) => {
      const semester = asRecord(item);
      return {
        id: requiredId(semester.id, "semester.id"),
        academicYearId: requiredId(semester.academic_year_id, "semester.academic_year_id"),
        name: requiredString(semester.name, "semester.name"),
        realName: optionalString(semester.real_name),
        sort: requiredNumber(semester.sort, "semester.sort"),
        isCurrent: requiredBoolean(semester.is_active, "semester.is_active"),
      };
    });
  }

  async getCourses(query: CourseQuery = {}): Promise<CoursePage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? COURSE_PAGE_SIZE;
    const conditions: Record<string, unknown> = {
      keyword: query.keyword ?? "",
      classify_type: "recently_started",
      display_studio_list: false,
    };
    if (query.semesterIds?.length) conditions.semester_id = query.semesterIds.map(String);

    const payload = asRecord(
      await this.requestJson("/api/my-courses", {
        method: "POST",
        body: JSON.stringify({
          fields: COURSE_FIELDS,
          page,
          page_size: pageSize,
          conditions,
          showScorePassedStatus: false,
        }),
      }),
    );

    return {
      courses: asArray(payload.courses, "courses").map(parseCourse),
      page: requiredNumber(payload.page, "page"),
      pageSize: requiredNumber(payload.page_size, "page_size"),
      pages: requiredNumber(payload.pages, "pages"),
      start: requiredNumber(payload.start, "start"),
      end: requiredNumber(payload.end, "end"),
      total: requiredNumber(payload.total, "total"),
    };
  }

  async getAllCourses(semesterIds?: string[]): Promise<Course[]> {
    const courses: Course[] = [];
    let page = 1;
    let pages = 1;
    do {
      const result = await this.getCourses({ semesterIds, page, pageSize: COURSE_PAGE_SIZE });
      courses.push(...result.courses);
      pages = result.pages;
      page += 1;
    } while (page <= pages);
    return courses;
  }

  async getLectures(courseId: string): Promise<Lecture[]> {
    const payload = asRecord(
      await this.requestJson(`/api/courses/${encodeURIComponent(courseId)}/activities?sub_course_id=0`),
    );
    return asArray(payload.activities, "activities")
      .map((item) => asRecord(item))
      .filter(
        (activity) =>
          activity.type === "lesson" && asRecordOrUndefined(activity.data)?.lesson_resource_id != null,
      )
      .map((activity) => parseLectureSummary(activity, courseId));
  }

  async getLecture(courseId: string, activityId: string): Promise<Lecture> {
    const activity = asRecord(
      await this.requestJson(`/api/activities/${encodeURIComponent(activityId)}?sub_course_id=0`),
    );
    const lecture = parseLectureSummary(activity, courseId);
    const suite = asRecordOrUndefined(activity.video_suite);
    const rawVideos = suite?.videos === undefined ? [] : asArray(suite.videos, "video_suite.videos");
    const resource = asRecordOrUndefined(activity.lesson_resource);
    const properties = asRecordOrUndefined(resource?.properties);
    return {
      ...lecture,
      replayStatus: optionalString(properties?.status),
      videos: rawVideos.map((video, index) => parseLectureVideo(video, index, lecture.duration)),
    };
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Referer", `${this.baseUrl}/user/courses`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json;charset=UTF-8");
    if (method !== "GET" && method !== "HEAD") headers.set("Origin", this.baseUrl);

    const response = await this.transport.fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      credentials: "include",
      redirect: "follow",
    });

    if (response.status === 401) {
      throw new XjtuApiError("AUTH_REQUIRED", "西交登录已经过期，请重新登录。", 401);
    }
    if (response.status === 403) {
      throw new XjtuApiError("FORBIDDEN", "当前账号无权访问该资源。", 403);
    }
    if (response.status >= 500) {
      throw new XjtuApiError("SERVER_ERROR", "西交课堂服务器暂时不可用。", response.status);
    }
    if (!response.ok) {
      throw new XjtuApiError("HTTP_ERROR", `西交课堂请求失败（HTTP ${response.status}）。`, response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const finalUrl = response.url;
    if (/text\/html/i.test(contentType) || /\/(?:login|auth)(?:\/|$)/i.test(finalUrl)) {
      throw new XjtuApiError("AUTH_REQUIRED", "西交登录已经过期，请重新登录。", response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new XjtuApiError("INVALID_RESPONSE", "西交课堂返回了无法解析的数据。", response.status);
    }
  }
}

function parseCourse(item: unknown): Course {
  const course = asRecord(item);
  const instructors = Array.isArray(course.instructors)
    ? course.instructors
        .map((item) => optionalString(asRecordOrUndefined(item)?.name))
        .filter((name): name is string => Boolean(name))
    : [];
  const department = asRecordOrUndefined(course.department);
  const rawName = requiredString(course.name, "course.name");
  const displayName = optionalString(course.display_name);
  return {
    id: requiredId(course.id, "course.id"),
    name: displayName || rawName,
    displayName,
    code: optionalString(course.course_code),
    teacher: instructors.length ? instructors.join("、") : undefined,
    instructors,
    semesterId: requiredId(course.semester_id, "course.semester_id"),
    academicYearId: requiredId(course.academic_year_id, "course.academic_year_id"),
    startDate: optionalString(course.start_date),
    endDate: optionalString(course.end_date),
    department: optionalString(department?.name),
  };
}

function parseLectureSummary(activity: Record<string, unknown>, courseId: string): Lecture {
  const data = asRecord(activity.data);
  return {
    id: requiredId(activity.id, "activity.id"),
    courseId,
    resourceId: requiredId(data.lesson_resource_id, "activity.data.lesson_resource_id"),
    title: optionalString(activity.title) ?? "未命名课堂",
    startTime: optionalString(activity.start_time) ?? optionalString(data.lesson_start),
    endTime: optionalString(activity.end_time) ?? optionalString(data.lesson_end),
    duration: optionalNumber(data.duration),
    allowDownload: optionalBoolean(data.allow_download),
    videos: [],
  };
}

function parseLectureVideo(item: unknown, index: number, duration?: number): LectureVideo {
  const video = asRecord(item);
  const url = optionalString(video.file_url);
  const serverLabel = optionalString(video.camera_type) ?? optionalString(video.label);
  return {
    id: url ? extractPreviewVideoId(url) : undefined,
    viewType: serverLabel ?? "unknown",
    displayName: serverLabel ?? `视角 ${index + 1}`,
    streamType: classifyStream(url),
    url,
    duration,
    mute: optionalBoolean(video.mute),
    isBestAudio: optionalBoolean(video.is_best_audio),
  };
}

function extractPreviewVideoId(url: string): string | undefined {
  return /\/videos\/([^/]+)\/preview(?:[/?#]|$)/.exec(url)?.[1];
}

function classifyStream(url?: string): StreamType {
  if (!url) return "unknown";
  const pathname = safePathname(url).toLowerCase();
  if (pathname.endsWith(".mp4")) return "mp4";
  if (pathname.endsWith(".m3u8")) return "hls";
  if (pathname.endsWith(".mpd")) return "dash";
  return "unknown";
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? url;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function requiredId(value: unknown, field: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) invalid(field);
  return String(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) invalid(field);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function invalid(field: string): never {
  throw new XjtuApiError("INVALID_RESPONSE", `西交课堂响应字段无效：${field}`);
}
