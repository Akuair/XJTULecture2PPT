export type StreamType = "mp4" | "hls" | "dash" | "unknown";

export interface AcademicYear {
  id: string;
  name: string;
  sort: number;
  isActive: boolean;
}

export interface Semester {
  id: string;
  academicYearId: string;
  name: string;
  realName?: string;
  sort: number;
  isCurrent: boolean;
}

export interface Course {
  id: string;
  name: string;
  displayName?: string;
  code?: string;
  teacher?: string;
  instructors: string[];
  semesterId: string;
  academicYearId: string;
  startDate?: string;
  endDate?: string;
  department?: string;
  uploadedLectureCount?: number;
}

export interface CoursePage {
  courses: Course[];
  page: number;
  pageSize: number;
  pages: number;
  start: number;
  end: number;
  total: number;
}

export interface Lecture {
  id: string;
  courseId: string;
  resourceId: string;
  title: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  allowDownload?: boolean;
  replayStatus?: string;
  videos: LectureVideo[];
}

export interface LectureVideo {
  id?: string;
  viewType: string;
  displayName: string;
  streamType: StreamType;
  url?: string;
  resolution?: string;
  duration?: number;
  mute?: boolean;
  isBestAudio?: boolean;
}

export interface CourseQuery {
  semesterIds?: string[];
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface XjtuTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
