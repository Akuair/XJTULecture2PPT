export const semesterListFixture = {
  semesters: [
    {
      id: 49,
      academic_year_id: 22,
      name: "2025-2026第1学期",
      real_name: "第一学期",
      sort: 21,
      is_active: false,
    },
    {
      id: 55,
      academic_year_id: 22,
      name: "2025-2026第2学期",
      real_name: "第二学期",
      sort: 22,
      is_active: true,
    },
  ],
};

export const semesterListWithoutActiveFixture = {
  semesters: semesterListFixture.semesters.map((semester) => ({ ...semester, is_active: false })),
};

export const courseListFixture = {
  courses: [
    {
      id: 115714,
      name: "课程原名",
      display_name: "课程显示名",
      course_code: "COURSE-001",
      academic_year_id: 22,
      semester_id: 55,
      start_date: "2026-03-02",
      end_date: null,
      department: { id: 1, name: "某学院" },
      instructors: [
        { id: 101, name: "教师甲", email: "teacher-a@example.invalid", avatar_small_url: "" },
        { id: 102, name: "教师乙", email: "teacher-b@example.invalid", avatar_small_url: "" },
      ],
    },
  ],
  page: 1,
  page_size: 10,
  pages: 1,
  start: 1,
  end: 1,
  total: 1,
};

export const lectureListFixture = {
  activities: [
    { id: 1, type: "lecture_live", title: "直播", data: {} },
    {
      id: 5464714,
      type: "lesson",
      title: "第1讲",
      start_time: "2026-03-03T02:10:00Z",
      data: {
        lesson_resource_id: 2802403,
        duration: 3000,
        allow_download: true,
        lesson_start: "2026-03-03T02:10:00Z",
        lesson_end: "2026-03-03T03:00:00Z",
      },
    },
    { id: 2, type: "lesson", title: "尚未生成回放", data: {} },
  ],
};

export function lectureDetailFixture(videoCount: number) {
  const videos = [
    {
      camera_type: "INSTRUCTOR",
      label: "INSTRUCTOR",
      mute: true,
      file_url:
        "https://class-rms.xjtu.edu.cn/api/base/orgs/xjtu/captures/capture/videos/2388850/preview?previewToken=redacted",
    },
    {
      camera_type: "ENCODER",
      label: "ENCODER",
      mute: false,
      file_url:
        "https://class-rms.xjtu.edu.cn/api/base/orgs/xjtu/captures/capture/videos/2388851/preview?previewToken=redacted",
    },
    { label: "SLIDES", mute: true, file_url: "https://media.example.invalid/slides.m3u8" },
    { mute: false, file_url: "https://media.example.invalid/extra.mp4" },
  ].slice(0, videoCount);

  return {
    id: 5464714,
    type: "lesson",
    title: "第1讲",
    start_time: "2026-03-03T02:10:00Z",
    data: { lesson_resource_id: 2802403, duration: 3000, allow_download: true },
    lesson_resource: {
      id: 2802403,
      mimetype: "application/vnd.wg-incast.capture",
      size: 1326951437,
      properties: { status: "FINISHED", type: "RECORD", duration: 3000 },
    },
    video_suite: { videos },
  };
}

export const statusFixtures = {
  expiredSession: { status: 401, body: { message: "unauthorized" } },
  forbidden: { status: 403, body: { message: "forbidden" } },
  serverError: { status: 500, body: { message: "server error" } },
  expiredSignedUrl: {
    status: 403,
    headers: { "content-type": "application/xml" },
    body: "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
  },
};
