# 西交课堂 API 分析

## 结论与范围

本分析来自 2026-08-19 在 `https://class.xjtu.edu.cn` 上完成的三次真实 headed Playwright 抓包：登录与播放器操作、课程页自动补抓、课程列表与学期切换补抓。所有持久化日志均已二次脱敏并通过验证；Cookie、Authorization、CAS 表单值、人员字段、token、ticket、session、preview token 和 signed URL query 值均未写入本文。

日志保存在 Git 忽略目录 `.network-logs/xjtu-inspector/`，浏览器 profile 保存在 `.dev-session/xjtu-inspector/`。不得提交这两个目录。

本文只描述实际观察到的接口。未观察到的返回值和行为不会用 URL 名称推测。

## 认证机制

登录链路实际经过：

```text
class.xjtu.edu.cn/user/courses
  → class.xjtu.edu.cn/auth/realms/xjtu/protocol/cas/login
  → class.xjtu.edu.cn/auth/realms/xjtu/broker/cas-client/login
  → login.xjtu.edu.cn/cas/login
  → 用户本人完成 CAS/MFA
  → class.xjtu.edu.cn
```

主站 API 请求观察到：

- 自动携带主站 Cookie；
- 有 `Referer`；
- `POST /api/my-courses` 另有 `Origin`；
- 未观察到 `Authorization` 或 `X-SESSION-ID` 请求头。

这只能证明这些 header 在浏览器正常请求中存在，尚未通过删减实验断言 `Referer`/`Origin` 的必要性。正式客户端应优先使用同一个 Electron persistent session 的 `session.fetch`，不要手动导出 Cookie。

Playwright persistent profile 未能在关闭浏览器后复用本次 CAS session Cookie；说明这次主站会话 Cookie 是浏览器会话级。Electron Phase 4 必须实际验证应用重启行为；若主站同样不持久化，应要求重新登录，而不是明文导出 Cookie。

## 学年与学期

### 学年

```http
GET /api/my-academic-years?fields=id,name,sort,is_active
```

响应：

```ts
interface AcademicYearsResponse {
  academic_years: Array<{
    id: number;
    name: string;
    sort: number;
    is_active: boolean;
  }>;
}
```

### 学期

```http
GET /api/my-semesters
```

响应：

```ts
interface SemestersResponse {
  semesters: Array<{
    id: number;
    academic_year_id: number;
    name: string;
    real_name?: string;
    sort: number;
    is_active: boolean;
  }>;
}
```

本次账号返回 10 个学期。抓包当天所有 `is_active` 均为 `false`，所以正式客户端必须：

1. 优先选择服务端 `is_active === true` 的学期；
2. 若没有活动学期，明确报告“当前无活动学期”；
3. 可把 `sort` 最大的学期作为“最近学期”建议，但不能把它伪装成服务端当前学期；
4. 始终保留手动切换学期。

## 课程列表 API

```http
POST /api/my-courses
Content-Type: application/json;charset=UTF-8
```

真实请求体：

```json
{
  "fields": "id,name,course_code,department(id,name),grade(id,name),klass(id,name),course_type,cover,small_cover,start_date,end_date,is_started,is_closed,academic_year_id,semester_id,credit,compulsory,second_name,display_name,created_user(id,name),org(is_enterprise_or_organization),org_id,public_scope,audit_status,audit_remark,can_withdraw_course,imported_from,allow_clone,is_instructor,is_team_teaching,is_default_course_cover,archived,instructors(id,name,email,avatar_small_url),course_attributes(teaching_class_name,is_during_publish_period,copy_status,tip,data,audience_type,graduate_method),user_stick_course_record(id)",
  "page": 1,
  "page_size": 10,
  "conditions": {
    "semester_id": ["55"],
    "keyword": "",
    "classify_type": "recently_started",
    "display_studio_list": false
  },
  "showScorePassedStatus": false
}
```

`semester_id` 是字符串数组。未选择学期时该字段可省略；用户在 UI 中切换学期时观察到单个或多个学期 ID。

响应分页字段：

```ts
interface MyCoursesResponse {
  courses: RawCourse[];
  page: number;
  page_size: number;
  pages: number;
  start: number;
  end: number;
  total: number;
}
```

课程字段包含 `id`、`name`、`display_name`、`course_code`、`academic_year_id`、`semester_id`、`start_date`、`end_date`、`instructors[]`、`department` 和 `course_attributes` 等。教师应来自 `instructors[]`，不能把 `created_user` 猜成教师。

课程列表响应不包含已上传课堂数量。该数量需要从课程 activities 中统计，或进入课程时再加载。

## 课程详情与课堂列表

课程详情（本次页面使用，课程列表已含主要展示字段）：

```http
GET /api/courses/{courseId}?fields=...
```

课堂/活动列表：

```http
GET /api/courses/{courseId}/activities?sub_course_id=0
```

响应根字段为 `activities`。样本课程返回 88 条：

- `type: "lecture_live"`：44 条直播活动；
- `type: "lesson"`：44 条回放课次；
- 44 条 `lesson` 均有 `data.lesson_resource_id`，可作为已生成回放的确认依据。

观察到的回放课次字段：

```ts
interface RawLessonActivity {
  id: number;
  type: "lesson";
  title: string;
  start_time?: string;
  end_time?: string;
  data: {
    lesson_resource_id: number;
    duration?: number;
    allow_download?: boolean;
    lesson_start?: string;
    lesson_end?: string;
  };
}
```

样本 `duration` 为秒。不能把配对的 `lecture_live` 与 `lesson` 同时显示成两次课堂。

## 单节课堂详情与双视角

```http
GET /api/activities/{activityId}?sub_course_id=0
```

关键字段：

```ts
interface RawActivityDetail {
  id: number;
  type: "lesson";
  title: string;
  start_time?: string;
  end_time?: string;
  data: {
    lesson_resource_id: number;
    duration?: number;
    allow_download?: boolean;
  };
  lesson_resource: {
    id: number;
    mimetype: "application/vnd.wg-incast.capture";
    size: number;
    properties: {
      replay_code: string;
      status: "FINISHED";
      type: "RECORD";
      duration?: number;
      start_time?: string;
      end_time?: string;
    };
  };
  video_suite: {
    videos: Array<{
      camera_type?: string;
      label?: string;
      mute?: boolean;
      file_url?: string;
    }>;
  };
}
```

代码必须把 `video_suite.videos` 当数组处理，支持 0、1、2 和多于 2 个视频，不能写死索引。

本次真实课次有两个视角：

| 服务端标签   |  `mute` | 观察到的含义边界                                            |
| ------------ | ------: | ----------------------------------------------------------- |
| `INSTRUCTOR` |  `true` | 服务端明确给出该标签；可显示“INSTRUCTOR/教师（服务端标签）” |
| `ENCODER`    | `false` | 服务端只给出 `ENCODER`；不得擅自显示为“教室全景”            |

同一信息在 RMS 详情中还包含：

```ts
{
  id: number;
  label: "INSTRUCTOR" | "ENCODER" | string;
  play_type: "video/mp4" | string;
  size: number;
  mute: boolean;
  is_best_audio: boolean;
  play_url: string;
  download_url: string;
}
```

样本中 `ENCODER` 标记 `is_best_audio: true`，`INSTRUCTOR` 为 `false`。这只能用于音轨提示，不能用来重新命名画面视角。

## 播放器与视频 URL 获取

主站播放器入口：

```http
GET /api/lessons/{activityId}/player-url?from_page=course
```

响应根字段为 `url`，指向：

```text
https://class-rms.xjtu.edu.cn/embed/lms/lesson-activity/{captureCode}/detail
```

其 query 中观察到 `activity_id`、`course_id`、`dep_id`、`token`、`user_id`，所有值均已脱敏。嵌入页随后请求：

```http
GET /api/v1/auth/embed-token?token=...
GET /api/embed/lesson/captures/{captureCode}/schedule
GET /api/embed/lesson-activities/captures/{captureCode}
```

后两个 RMS API 请求观察到 Cookie、`Authorization` 与 `Referer`。正式主站客户端不应猜测或持久化这个嵌入 token。主站 activity detail 已直接返回 `video_suite.videos[].file_url`，因此第一版可使用该授权播放 URL，并在下载阶段即时解析。

## 媒体类型、重定向与 signed URL

真实播放链路：

```text
video_suite.videos[].file_url
  → class-rms.xjtu.edu.cn/.../videos/{videoId}/preview?previewToken=...
  → HTTP 302
  → review-class.xjtu.edu.cn/.../{file}.mp4?X-Amz-...
  → HTTP 206 Partial Content
```

本次两个视角均为普通 MP4，没有观察到 m3u8、HLS、MPD、DASH 或 DRM/Widevine。

signed URL query 参数名：

- `X-Amz-Algorithm`
- `X-Amz-Credential`
- `X-Amz-Date`
- `X-Amz-Expires`
- `X-Amz-SignedHeaders`
- `X-Amz-Signature`
- `response-content-disposition`

所有值均已脱敏，因此本文不记录精确有效期。客户端必须把 URL 视为短期资源：下载前即时解析；若出现 401/403 或签名过期响应，重新请求 activity detail/preview URL，而不是重试旧 signed URL。

观察到的媒体能力：

- 两个实际请求均返回 `206`；
- `Accept-Ranges: bytes`；
- 存在 `Content-Range`；
- `Content-Length` 与 API 中单个视频的 `size` 一致；
- preview 请求带主站/RMS Cookie、`Referer` 和 `Range`，无 `Authorization`；
- 最终 signed MP4 请求无 Cookie、无 `Authorization`，但有 `Referer`、`Origin` 和 `Range`。

下载器可据此实现 Range 续传，但必须先对真实响应确认目标 URL、ETag/Last-Modified（若有）和当前总大小。

`download_url` 虽然存在，但样本 RMS permissions 同时出现 `can_download: false`。正式程序不应调用 UI 禁止的显式下载入口；第一版使用浏览器正常播放所用的 `play_url/file_url` 授权链路。

## 标题、日期、时长、分辨率

- 课程名称：课程 `name`/`display_name`；
- 教师：课程 `instructors[].name`；
- 课次标题：activity `title`；
- 上课日期：activity `start_time` 或 `data.lesson_start`；
- 时长：activity `data.duration` 或 resource `properties.duration`；
- 视频大小：RMS video `size` 或媒体 `Content-Length`；
- 分辨率：本次 API 响应未提供，必须在媒体 metadata/ffprobe 阶段获取，不能猜测。

## 分页机制

课程分页由请求 `page/page_size` 和响应 `page/page_size/pages/start/end/total` 控制。实测 `page_size` 为 10。客户端应按 `pages` 或累计 `total` 拉取，不得假设一页包含全部课程。

activities 接口本次一次返回全部 88 条，未观察到分页参数。

## 错误返回格式

观察到两类成功响应：

1. 主站 LMS：数据直接位于根字段，例如 `{ courses, page, ... }`、`{ activities }`、`{ url }`；
2. RMS：`{ data, error: { code, details, message, status } }`。

本次没有自然出现 API 401、403 或 500，也没有为了测试而制造未授权访问。因此：

- 401/登录重定向：客户端统一映射为 session 失效；
- 403：映射为无权限，不尝试绕过；
- 5xx：映射为服务暂时不可用；
- 上述映射先用 fixtures 测试，后续只在自然出现时补充真实 body 结构。

## 对正式客户端的实现约束

- API base URL 固定为真实观察到的 `https://class.xjtu.edu.cn`；
- 使用 Electron session 的 fetch，不复制或打印 Cookie；
- 所有服务端 ID 作为字符串暴露给 UI，解析时接受 JSON number/string；
- `is_active` 是当前学期唯一服务端标志；无 active 时不能伪造；
- 课堂列表只选择 `type === "lesson"` 且有 `data.lesson_resource_id` 的条目；
- 视角来自数组，显示服务端 `camera_type/label`；
- `file_url` 先标记 stream type `unknown`，解析 302/Content-Type 后才确认 MP4/HLS/DASH；
- 任何 DRM 迹象都必须终止下载并报告，不实现绕过。
