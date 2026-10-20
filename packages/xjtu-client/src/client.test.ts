import { describe, expect, it } from "vitest";

import {
  courseListFixture,
  lectureDetailFixture,
  lectureListFixture,
  semesterListFixture,
  semesterListWithoutActiveFixture,
  statusFixtures,
} from "../../../tests/fixtures/xjtu";

import { XjtuClient } from "./client";
import { XjtuApiError } from "./errors";
import { selectActiveSemester, suggestMostRecentSemester } from "./semester-selection";
import type { XjtuTransport } from "./types";

describe("XjtuClient", () => {
  it("parses semesters and keeps active vs recent semantics separate", async () => {
    const activeClient = new XjtuClient(new QueueTransport([jsonResponse(semesterListFixture)]));
    const active = await activeClient.getSemesters();
    expect(selectActiveSemester(active)?.id).toBe("55");
    expect(suggestMostRecentSemester(active)?.id).toBe("55");

    const inactiveClient = new XjtuClient(
      new QueueTransport([jsonResponse(semesterListWithoutActiveFixture)]),
    );
    const inactive = await inactiveClient.getSemesters();
    expect(selectActiveSemester(inactive)).toBeUndefined();
    expect(suggestMostRecentSemester(inactive)?.id).toBe("55");
  });

  it("uses the observed course POST shape and maps instructor names", async () => {
    const transport = new QueueTransport([jsonResponse(courseListFixture)]);
    const client = new XjtuClient(transport);
    const result = await client.getCourses({ semesterIds: ["55"], page: 1 });

    expect(result.total).toBe(1);
    expect(result.courses[0]).toMatchObject({
      id: "115714",
      name: "课程显示名",
      semesterId: "55",
      teacher: "教师甲、教师乙",
    });
    const requestBody = JSON.parse(String(transport.requests[0]?.init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ page: 1, page_size: 10, showScorePassedStatus: false });
    expect(requestBody.conditions).toEqual({
      semester_id: ["55"],
      keyword: "",
      classify_type: "recently_started",
      display_studio_list: false,
    });
    expect(String(requestBody.fields)).toContain("instructors(id,name,email,avatar_small_url)");
  });

  it("loads every course page without assuming a single page", async () => {
    const transport: XjtuTransport = {
      async fetch(_input, init) {
        const body = JSON.parse(String(init?.body)) as { page: number };
        const course = { ...courseListFixture.courses[0], id: body.page };
        return jsonResponse({
          ...courseListFixture,
          courses: [course],
          page: body.page,
          pages: 2,
          start: body.page,
          end: body.page,
          total: 2,
        });
      },
    };
    const courses = await new XjtuClient(transport).getAllCourses(["55"]);
    expect(courses.map((course) => course.id)).toEqual(["1", "2"]);
  });

  it("filters live activities and lessons without a replay resource", async () => {
    const client = new XjtuClient(new QueueTransport([jsonResponse(lectureListFixture)]));
    const lectures = await client.getLectures("115714");
    expect(lectures).toHaveLength(1);
    expect(lectures[0]).toMatchObject({
      id: "5464714",
      courseId: "115714",
      resourceId: "2802403",
      duration: 3000,
      videos: [],
    });
  });

  it.each([0, 1, 2, 4])("supports %i videos without fixed array indexes", async (videoCount) => {
    const client = new XjtuClient(new QueueTransport([jsonResponse(lectureDetailFixture(videoCount))]));
    const lecture = await client.getLecture("115714", "5464714");
    expect(lecture.videos).toHaveLength(videoCount);
    if (videoCount >= 2) {
      expect(lecture.videos[0]).toMatchObject({ id: "2388850", viewType: "INSTRUCTOR", mute: true });
      expect(lecture.videos[1]).toMatchObject({ id: "2388851", viewType: "ENCODER", mute: false });
    }
    if (videoCount === 4) {
      expect(lecture.videos[2]?.streamType).toBe("hls");
      expect(lecture.videos[3]).toMatchObject({ displayName: "视角 4", streamType: "mp4" });
    }
  });

  it.each([
    [statusFixtures.expiredSession, "AUTH_REQUIRED"],
    [statusFixtures.forbidden, "FORBIDDEN"],
    [statusFixtures.serverError, "SERVER_ERROR"],
  ] as const)("maps HTTP $0.status to a user-facing error", async (fixture, code) => {
    const client = new XjtuClient(new QueueTransport([jsonResponse(fixture.body, fixture.status)]));
    await expect(client.getSemesters()).rejects.toMatchObject({ code, status: fixture.status });
  });

  it("treats a successful HTML login page as an expired session", async () => {
    const response = new Response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const client = new XjtuClient(new QueueTransport([response]));
    await expect(client.getSemesters()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("rejects malformed server payloads", async () => {
    const client = new XjtuClient(new QueueTransport([jsonResponse({ semesters: [{ id: 1 }] })]));
    await expect(client.getSemesters()).rejects.toBeInstanceOf(XjtuApiError);
  });

  it("keeps an expired signed URL fixture for downloader retry tests", () => {
    expect(statusFixtures.expiredSignedUrl).toMatchObject({ status: 403 });
  });
});

class QueueTransport implements XjtuTransport {
  readonly requests: Array<{ input: string; init?: RequestInit }> = [];

  constructor(private readonly responses: Response[]) {}

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ input, init });
    const response = this.responses.shift();
    if (!response) throw new Error(`No fixture response for ${input}`);
    return response;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
